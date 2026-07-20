use std::sync::Arc;
use tokio::sync::Mutex;
use dashmap::DashMap;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::data_channel::RTCDataChannel;
use webrtc::api::APIBuilder;
use webrtc::peer_connection::configuration::RTCConfiguration;
// use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use serde::{Deserialize, Serialize};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use futures_util::{StreamExt, SinkExt};
use once_cell::sync::Lazy;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::interceptor::registry::Registry;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use tauri::{AppHandle, Manager, Listener, Emitter};
use crate::serial_manager::{SerialManager, SerialConfig};
use crate::tcp_manager::TcpManager;
use crate::ssh_manager::SshManager;
use std::fs;
use uuid::Uuid;
use webrtc::data_channel::data_channel_state::RTCDataChannelState;
// use crate::ActiveReaction;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SignalMessage {
    Heartbeat { device_id: String },
    Goodbye { device_id: String },
    Offer { from_id: String, to_id: String, sdp: String },
    Answer { from_id: String, to_id: String, sdp: String },
    #[serde(rename = "candidate")]
    IceCandidate { from_id: String, to_id: String, candidate: String },
    Error { message: String },
}

pub struct PeerState {
    pub pc: Arc<RTCPeerConnection>,
    pub channels: Vec<Arc<RTCDataChannel>>,
}

pub struct ShareManager {
    pub display_id: Arc<Mutex<Option<String>>>,
    pub peers: DashMap<String, PeerState>,
    pub is_running: Arc<Mutex<bool>>,
}

pub static SHARE_MANAGER: Lazy<ShareManager> = Lazy::new(|| ShareManager {
    display_id: Arc::new(Mutex::new(None)),
    peers: DashMap::new(),
    is_running: Arc::new(Mutex::new(false)),
});

pub static SIGNAL_SENDER: Lazy<Arc<Mutex<Option<tokio::sync::mpsc::Sender<Message>>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));

/// ICE candidates that arrive before the peer's RTCPeerConnection is created (i.e. before
/// accept_remote_offer completes). Keyed by from_id, drained inside handle_offer after the
/// remote description is set.
static PENDING_CANDIDATES: Lazy<DashMap<String, Vec<RTCIceCandidateInit>>> = Lazy::new(DashMap::new);
pub struct ManagerContext {
    pub serial: Arc<SerialManager>,
    pub _tcp: Arc<TcpManager>,
    pub ssh: Arc<SshManager>,
    pub app: AppHandle,
}

pub static MANAGER_CONTEXT: Lazy<Arc<Mutex<Option<ManagerContext>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
#[tauri::command]
pub async fn share_active_tab(tab_id: String, peer_id: String) -> Result<(), String> {
    let peer_id = peer_id.trim().to_string();
    println!("[WEBRTC] Sharing tab {} to peer {}...", tab_id, peer_id);
    println!("[WEBRTC] Current Peers in Manager: {:?}", SHARE_MANAGER.peers.iter().map(|kv| kv.key().clone()).collect::<Vec<String>>());

    // Find peer
    let found_peer_id = {
        let mut match_id = None;
        for kv in SHARE_MANAGER.peers.iter() {
            if kv.key().trim() == peer_id {
                match_id = Some(kv.key().clone());
                break;
            }
        }
        match_id
    };

    if let Some(target_id) = found_peer_id {
        let peer = SHARE_MANAGER.peers.get(&target_id).unwrap();
        let ctx_locked = MANAGER_CONTEXT.lock().await;
        if let Some(ctx) = ctx_locked.as_ref() {
            // FIND the existing channel (serial-bridge) instead of creating a new one
            let existing_dc = peer.channels.iter()
                .find(|ch| ch.label().starts_with("serial-") || ch.label().starts_with("remote-"))
                .cloned();

            let dc = if let Some(dc) = existing_dc {
                println!("[WEBRTC] Reusing existing channel '{}' for tab {}", dc.label(), tab_id);
                dc
            } else {
                // Fallback: create new channel if none exists
                println!("[WEBRTC] No existing channel found, creating new one for tab {}", tab_id);
                let new_dc = peer.pc.create_data_channel(&tab_id, None).await.map_err(|e| e.to_string())?;
                setup_data_channel(peer_id.clone(), new_dc.clone(), None).await;
                new_dc
            };

            // CRITICAL: Map the channel label to the ACTUAL serial tab
            // So when web client sends data on "serial-bridge", it routes to the real serial tab
            let channel_label = dc.label().to_string();
            DC_TAB_MAP.insert(channel_label.clone(), tab_id.clone());
            println!("[WEBRTC] Mapped channel '{}' → tab '{}'", channel_label, tab_id);

            let dc_c = Arc::clone(&dc);
            let tab_id_inner = tab_id.clone();
            
            ctx.app.listen("serial-data", move |event| {
                if let Ok(payload) = serde_json::from_str::<SerialEventPayload>(event.payload()) {
                    if payload.0 == tab_id_inner {
                        let mut packet = vec![0x01]; // Terminal Data
                        let dir_byte = if payload.3.starts_with("TX") { 1u8 } else { 0u8 };
                        packet.push(dir_byte);
                        packet.extend_from_slice(&payload.1);
                        
                        let dc_inner = dc_c.clone();
                        tokio::spawn(async move {
                            if dc_inner.ready_state() == RTCDataChannelState::Open {
                                let _ = dc_inner.send(&packet.into()).await;
                            }
                        });
                    }
                }
            });

            println!("[REMOTE] Shared tab {} with peer {} via channel '{}'", tab_id, peer_id, dc.label());
            return Ok(());
        } else {
            return Err("Sharing context missing. Please toggle Broadcasting ON (Host)".to_string());
        }
    }
    
    Err(format!("Peer {} not found in manager. Active: {:?}", peer_id, SHARE_MANAGER.peers.iter().map(|kv| kv.key().clone()).collect::<Vec<String>>()))
}

/// Broadcast binary data to all active DataChannels
pub async fn broadcast_remote_data(label: String, data: Vec<u8>) {
    // [0x01 = Serial Data, 0x00 = RX direction, ...bytes]
    // Web app's onmessage handler expects: [type, dir_byte, ...bytes]
    let mut payload = vec![0x01, 0x00];
    payload.extend_from_slice(&data);

    for kv in SHARE_MANAGER.peers.iter() {
        let peer = kv.value();
        for ch in &peer.channels {
            if ch.label() == label && ch.ready_state() == RTCDataChannelState::Open {
                let _ = ch.send(&payload.clone().into()).await;
            }
        }
    }
}

#[tauri::command]
pub async fn send_remote_data(peer_id: String, label: String, data: Vec<u8>) -> Result<(), String> {
    if let Some(peer) = SHARE_MANAGER.peers.get(&peer_id) {
        println!("[WEBRTC] Sending remote data to peer {} on channel {}. Size: {}", peer_id, label, data.len());
        for ch in &peer.channels {
            if ch.label() == label {
                if ch.ready_state() == RTCDataChannelState::Open {
                    let _ = ch.send(&data.into()).await;
                    return Ok(());
                } else {
                    println!("[WEBRTC] Channel {} state is {:?}. Waiting...", label, ch.ready_state());
                    let ch_c = Arc::clone(ch);
                    let data_c = data.clone();
                    let label_c = label.clone();
                    tokio::spawn(async move {
                        for _ in 0..30 {
                            if ch_c.ready_state() == RTCDataChannelState::Open {
                                let _ = ch_c.send(&data_c.into()).await;
                                println!("[WEBRTC] Channel {} OPENED and data sent.", label_c);
                                break;
                            }
                            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                        }
                    });
                    return Ok(());
                }
            }
        }
        let labels: Vec<String> = peer.channels.iter().map(|c| c.label().to_string()).collect();
        println!("[WEBRTC] Channel {} NOT FOUND. Available: {:?}", label, labels);
    }
    Err("Peer or channel not found".to_string())
}

fn get_machine_id(app: &AppHandle) -> String {
    let path = app.path().app_data_dir().unwrap().join("machine_id");
    if let Ok(id) = fs::read_to_string(&path) {
        return id.trim().to_string();
    }
    let new_id = Uuid::new_v4().to_string();
    let _ = fs::create_dir_all(path.parent().unwrap());
    let _ = fs::write(&path, &new_id);
    new_id
}

pub fn get_machine_id_pub(app: &AppHandle) -> String {
    get_machine_id(app)
}

/// Read the persisted device ID from disk (survives restarts).
fn load_device_id(app: &AppHandle) -> Option<String> {
    let path = app.path().app_data_dir().ok()?.join("device_id");
    let raw = fs::read_to_string(&path).ok()?;
    let id = raw.trim().to_string();
    if id.is_empty() { None } else { Some(id) }
}

/// Persist the device ID to disk so it is restored on next start.
fn save_device_id(app: &AppHandle, id: &str) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join("device_id"), id);
    }
}

const SUPABASE_URL: &str = "https://xpxzssueokeomxopzdbr.supabase.co";
const SUPABASE_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhweHpzc3Vlb2tlb214b3B6ZGJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTA1MjUsImV4cCI6MjA5MDI4NjUyNX0.2kQAQJpXEqIduP0eVYn22JSRZMHauJ3mh8tnCS5Ftbc";

/// Query Supabase for a previously registered device_id matching this machine_id.
/// Returns None if the machine has no prior registration or the lookup fails.
async fn lookup_supabase_device_id(machine_id: &str) -> Option<String> {
    let url = format!(
        "{}/rest/v1/remote_devices?machine_id=eq.{}&select=id&order=last_seen.desc&limit=1",
        SUPABASE_URL, machine_id
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("apikey", SUPABASE_KEY)
        .header("Authorization", format!("Bearer {}", SUPABASE_KEY))
        .send()
        .await
        .ok()?;
    if machine_id == "unknown" { return None; }
    let rows: Vec<serde_json::Value> = resp.json().await.ok()?;
    rows.into_iter().next()?.get("id")?.as_str().map(|s| s.to_string())
}

pub async fn ensure_signaling_active(app: AppHandle, name: String, signal_url: String) -> Result<String, String> {
    // 1. Check if already active in memory
    if let Some(id) = SHARE_MANAGER.display_id.lock().await.as_ref() {
        return Ok(id.clone());
    }

    // Resolve device_id with priority: disk cache → Supabase lookup → /claim-id (last resort).
    // This prevents the signal server from minting a new ID on every restart.
    let machine_id = get_machine_id(&app);

    let device_id = if let Some(cached_id) = load_device_id(&app) {
        // Disk cache is the fastest path and survives restarts.
        println!("[SIGNAL] Using cached device ID from disk: {}", cached_id);
        cached_id
    } else if let Some(supabase_id) = lookup_supabase_device_id(&machine_id).await {
        // Disk was cleared (reinstall, new data dir, etc.) but Supabase still has the
        // previously registered ID for this machine — recover it before minting a new one.
        println!("[SIGNAL] Recovered device ID from Supabase (machine_id={}): {}", machine_id, supabase_id);
        save_device_id(&app, &supabase_id);
        supabase_id
    } else {
        // No existing registration — claim a brand-new ID from the signal server.
        let base_url = signal_url.replace("wss://", "https://").replace("ws://", "http://").replace("/ws", "");
        let client = reqwest::Client::new();
        match client
            .post(format!("{}/claim-id", base_url))
            .json(&serde_json::json!({ "name": name, "os": "Linux", "machine_id": machine_id }))
            .send()
            .await
        {
            Ok(resp) => match resp.json::<serde_json::Value>().await {
                Ok(body) => match body["device_id"].as_str() {
                    Some(id) => {
                        let id = id.to_string();
                        println!("[SIGNAL] New device ID from server (machine_id={}): {}", machine_id, id);
                        save_device_id(&app, &id);
                        id
                    }
                    None => return Err("No device_id in server response".to_string()),
                },
                Err(e) => return Err(format!("Failed to parse /claim-id response: {}", e)),
            },
            Err(e) => return Err(format!("Cannot reach signal server and no disk/Supabase cache: {}", e)),
        }
    };

    *SHARE_MANAGER.display_id.lock().await = Some(device_id.clone());

    // 2. Connect WebSocket
    println!("[SIGNAL] Connecting to WebSocket: {}...", signal_url);
    let signal_url_reconnect = signal_url.clone(); // keep for auto-reconnect
    let (mut ws_stream, _) = connect_async(signal_url).await.map_err(|e| e.to_string())?;
    println!("[SIGNAL] WebSocket Connected!");

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Message>(100);
    *SIGNAL_SENDER.lock().await = Some(tx);

    // 3. Send Heartbeat to register session
    let hb = SignalMessage::Heartbeat { device_id: device_id.clone() };
    ws_stream.send(Message::Text(serde_json::to_string(&hb).unwrap().into())).await.map_err(|e| e.to_string())?;

    let _ = app.emit("remote-id-ready", device_id.clone());

    let app_c = app.clone();
    let device_id_hb = device_id.clone();
    tokio::spawn(async move {
        // Periodic heartbeat — keeps this device visible on the signal server.
        // Without this the server expires the session and callers get "Device not found".
        let mut heartbeat = tokio::time::interval(tokio::time::Duration::from_secs(20));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Skip the first immediate tick so we don't double-send (we already sent one above)
        heartbeat.tick().await;

        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    let hb = SignalMessage::Heartbeat { device_id: device_id_hb.clone() };
                    let msg = Message::Text(serde_json::to_string(&hb).unwrap().into());
                    if let Err(e) = ws_stream.send(msg).await {
                        println!("[SIGNAL] Heartbeat failed, connection lost: {}", e);
                        break;
                    }
                    println!("[SIGNAL] Heartbeat sent for {}", device_id_hb);
                }
                Some(Ok(msg)) = ws_stream.next() => {
                    if let Message::Text(text) = msg {
                        println!("[SIGNAL] Raw WS Message: {}", text);
                        if let Ok(signal) = serde_json::from_str::<serde_json::Value>(&text.to_string()) {
                            let msg_type = signal["type"].as_str().unwrap_or("");
                            let from = signal["from_id"].as_str().unwrap_or("").to_string();
                            let sdp = signal["sdp"].as_str().unwrap_or("").to_string();

                            match msg_type {
                                "offer" => {
                                    if !from.is_empty() {
                                        println!("[SIGNAL] Received Offer from: {}", from);
                                        let payload = vec![from, sdp];
                                        let _ = app_c.emit("remote-offer", payload);
                                    }
                                }
                                "answer" => {
                                    let from = signal["from_id"].as_str().unwrap_or("").to_string();
                                    let sdp = signal["sdp"].as_str().unwrap_or("").to_string();
                                    if !from.is_empty() {
                                        handle_answer(from, sdp).await;
                                    }
                                }
                                "ice_candidate" | "candidate" => {
                                    let from = signal["from_id"].as_str().unwrap_or("").to_string();
                                    let candidate = signal["candidate"].as_str().unwrap_or("").to_string();
                                    if !from.is_empty() {
                                        handle_ice_candidate(from, candidate).await;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                Some(out_msg) = rx.recv() => {
                    if let Err(e) = ws_stream.send(out_msg).await {
                        println!("[SIGNAL] Error sending to WS: {}", e);
                        break;
                    }
                }
                else => break,
            }
        }
        println!("[SIGNAL] WS loop exited — clearing signaling state (keeping active peers).");
        *SHARE_MANAGER.display_id.lock().await = None;
        // Do NOT clear peers here — WebRTC P2P connections are independent of the signal
        // server and must survive a WS drop. Clearing them would kill live sessions.
        *SIGNAL_SENDER.lock().await = None;

        // Auto-reconnect: keep trying until `is_running` is explicitly set to false
        let mut retry_secs = 5u64;
        loop {
            if !*SHARE_MANAGER.is_running.lock().await {
                println!("[SIGNAL] Sharing stopped — not reconnecting.");
                break;
            }
            println!("[SIGNAL] Reconnecting in {}s...", retry_secs);
            tokio::time::sleep(tokio::time::Duration::from_secs(retry_secs)).await;

            match connect_async(&signal_url_reconnect).await {
                Ok((new_ws, _)) => {
                    let (new_tx, new_rx) = tokio::sync::mpsc::channel::<Message>(100);
                    *SIGNAL_SENDER.lock().await = Some(new_tx);
                    *SHARE_MANAGER.display_id.lock().await = Some(device_id_hb.clone());

                    // Re-register with server
                    let mut ws = new_ws;
                    let hb = SignalMessage::Heartbeat { device_id: device_id_hb.clone() };
                    let _ = ws.send(Message::Text(serde_json::to_string(&hb).unwrap().into())).await;
                    let _ = app_c.emit("remote-id-ready", device_id_hb.clone());

                    println!("[SIGNAL] Reconnected as {}", device_id_hb);
                    rx = new_rx;
                    ws_stream = ws;
                    retry_secs = 5;

                    // Resume the heartbeat + message loop
                    let mut heartbeat2 = tokio::time::interval(tokio::time::Duration::from_secs(20));
                    heartbeat2.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    heartbeat2.tick().await;

                    loop {
                        tokio::select! {
                            _ = heartbeat2.tick() => {
                                let hb2 = SignalMessage::Heartbeat { device_id: device_id_hb.clone() };
                                let msg2 = Message::Text(serde_json::to_string(&hb2).unwrap().into());
                                if let Err(e) = ws_stream.send(msg2).await {
                                    println!("[SIGNAL] Heartbeat failed after reconnect: {}", e);
                                    *SHARE_MANAGER.display_id.lock().await = None;
                                    *SIGNAL_SENDER.lock().await = None;
                                    break;
                                }
                                println!("[SIGNAL] Heartbeat sent for {} (reconnected)", device_id_hb);
                            }
                            Some(Ok(msg2)) = ws_stream.next() => {
                                if let Message::Text(text) = msg2 {
                                    if let Ok(signal) = serde_json::from_str::<serde_json::Value>(&text.to_string()) {
                                        let msg_type = signal["type"].as_str().unwrap_or("");
                                        let from = signal["from_id"].as_str().unwrap_or("").to_string();
                                        let sdp = signal["sdp"].as_str().unwrap_or("").to_string();
                                        match msg_type {
                                            "offer" => {
                                                if !from.is_empty() {
                                                    let _ = app_c.emit("remote-offer", vec![from, sdp]);
                                                }
                                            }
                                            "answer" => {
                                                if !from.is_empty() { handle_answer(from, sdp).await; }
                                            }
                                            "ice_candidate" | "candidate" => {
                                                let candidate = signal["candidate"].as_str().unwrap_or("").to_string();
                                                if !from.is_empty() { handle_ice_candidate(from, candidate).await; }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                            }
                            Some(out_msg) = rx.recv() => {
                                if let Err(e) = ws_stream.send(out_msg).await {
                                    println!("[SIGNAL] Send error after reconnect: {}", e);
                                    *SHARE_MANAGER.display_id.lock().await = None;
                                    *SIGNAL_SENDER.lock().await = None;
                                    break;
                                }
                            }
                            else => break,
                        }
                    }
                }
                Err(e) => {
                    println!("[SIGNAL] Reconnect failed: {} — will retry in {}s", e, retry_secs * 2);
                    retry_secs = (retry_secs * 2).min(60);
                }
            }
        }

        *SHARE_MANAGER.is_running.lock().await = false;
        println!("[SIGNAL] Sharing task fully stopped.");
    });

    Ok(device_id)
}

pub async fn start_sharing(
    app: AppHandle,
    serial: Arc<SerialManager>,
    tcp: Arc<TcpManager>,
    ssh: Arc<SshManager>,
    name: String,
    signal_url: String
) -> Result<String, String> {
    // Always refresh MANAGER_CONTEXT so the latest handles are used.
    *MANAGER_CONTEXT.lock().await = Some(ManagerContext {
        serial,
        _tcp: tcp,
        ssh,
        app: app.clone(),
    });

    let mut running = SHARE_MANAGER.is_running.lock().await;
    if *running {
        // Auto-init already established signaling — return the existing ID.
        if let Some(id) = SHARE_MANAGER.display_id.lock().await.as_ref() {
            return Ok(id.clone());
        }
        // Running flag set but no ID yet (race) — fall through and let ensure_signaling_active handle it.
    }
    *running = true;
    drop(running);

    ensure_signaling_active(app, name, signal_url).await
}

pub async fn stop_sharing() -> Result<(), String> {
    let mut running = SHARE_MANAGER.is_running.lock().await;
    if !*running {
        return Ok(());
    }

    // Send Goodbye to signal server if connected
    if let Some(tx) = SIGNAL_SENDER.lock().await.as_ref() {
        if let Some(id) = SHARE_MANAGER.display_id.lock().await.as_ref() {
            let bye = SignalMessage::Goodbye { device_id: id.clone() };
            let _ = tx.send(Message::Text(serde_json::to_string(&bye).unwrap().into())).await;
        }
    }

    *running = false;
    Ok(())
}

async fn handle_offer(my_id: String, from: String, sdp: String) {
    // If an old connection exists for this peer, close it and clear the frontend state first
    if let Some((_, old_peer)) = SHARE_MANAGER.peers.remove(&from) {
        println!("[WEBRTC] Cleaning up old connection for {}", from);
        let _ = old_peer.pc.close().await;
        if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
            use tauri::Emitter;
            let _ = ctx.app.emit("remote-peer-disconnected", from.clone());
        }
    }

    let api = create_webrtc_api();
    let config = create_webrtc_config();
    let pc = Arc::new(api.new_peer_connection(config).await.unwrap());
    let my_id_c = my_id.clone();
    let from_c = from.clone();
    
    let my_id_ice = my_id_c.clone();
    let from_ice = from_c.clone();
    pc.on_ice_candidate(Box::new(move |c| {
        let tid = from_ice.clone();
        let fid = my_id_ice.clone();
        Box::pin(async move {
            if let Some(candidate) = c {
                let json = candidate.to_json().unwrap();
                let msg = SignalMessage::IceCandidate { 
                    to_id: tid, 
                    from_id: fid,
                    candidate: serde_json::to_string(&json).unwrap() 
                };
                send_signal(msg).await;
            }
        })
    }));

    let from_dc = from_c.clone();
    pc.on_data_channel(Box::new(move |d| {
        let from_cc = from_dc.clone();
        Box::pin(async move {
            setup_data_channel(from_cc, d, None).await;
        })
    }));

    pc.set_remote_description(RTCSessionDescription::offer(sdp).unwrap()).await.unwrap();
    let answer = pc.create_answer(None).await.unwrap();
    pc.set_local_description(answer.clone()).await.unwrap();

    let ans_msg = SignalMessage::Answer { to_id: from.clone(), from_id: my_id, sdp: answer.sdp };
    send_signal(ans_msg).await;

    let pc_c = Arc::clone(&pc);
    SHARE_MANAGER.peers.insert(from.clone(), PeerState {
        pc: pc_c,
        channels: Vec::new()
    });

    // Drain any ICE candidates that arrived before the peer connection was created.
    if let Some((_, queued)) = PENDING_CANDIDATES.remove(&from) {
        if let Some(peer) = SHARE_MANAGER.peers.get(&from) {
            for init in queued {
                let _ = peer.pc.add_ice_candidate(init).await;
            }
        }
    }
}

async fn handle_answer(from: String, sdp: String) {
    if let Some(peer) = SHARE_MANAGER.peers.get(&from) {
        let _ = peer.pc.set_remote_description(RTCSessionDescription::answer(sdp).unwrap()).await;
    }
}

async fn handle_ice_candidate(from: String, candidate: String) {
    let init = if let Ok(parsed) = serde_json::from_str::<RTCIceCandidateInit>(&candidate) {
        parsed
    } else {
        RTCIceCandidateInit { candidate, ..Default::default() }
    };

    if let Some(peer) = SHARE_MANAGER.peers.get(&from) {
        // Peer already exists — apply immediately.
        let _ = peer.pc.add_ice_candidate(init).await;
    } else {
        // Peer not yet created (offer not accepted yet) — queue for later.
        println!("[SIGNAL] Queuing ICE candidate from {} (peer not ready yet)", from);
        PENDING_CANDIDATES.entry(from).or_default().push(init);
    }
}

/// Mappings to track which DataChannel belongs to which virtual tab
static DC_TAB_MAP: Lazy<DashMap<String, String>> = Lazy::new(|| DashMap::new());

async fn setup_data_channel(peer_id: String, d: Arc<RTCDataChannel>, app_handle: Option<AppHandle>) {
    let label = d.label().to_owned();
    
    if let Some(mut peer) = SHARE_MANAGER.peers.get_mut(&peer_id) {
        peer.channels.push(Arc::clone(&d));
    }

    // Auto-map labeled channels for terminal data routing
    if (label.starts_with("serial-") || label.starts_with("ssh-") || label.starts_with("remote-")) && label != "serial-bridge" {
        println!("[WEBRTC] Mapping data channel {} to self", label);
        DC_TAB_MAP.insert(label.clone(), label.clone());

        // Notify frontend that a new channel is ready
        if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
            let _ = ctx.app.emit("remote-channel-open", (peer_id.clone(), label.clone()));
        }
    } else if label == "serial-bridge" {
        // HOST-SIDE: Map the generic mirror channel to the 'main' tab by default
        // This allows commands from the Web client to hit the real serial port.
        println!("[WEBRTC] Mapping generic bridge '{}' to 'main' tab on HOST", label);
        DC_TAB_MAP.insert("serial-bridge".to_string(), "main".to_string());
        
        // Notify frontend that the bridge is ready
        if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
            let _ = ctx.app.emit("remote-channel-open", (peer_id.clone(), label.clone()));
        }
    }

    let d_c = Arc::clone(&d);
    let peer_id_c = peer_id.clone();
    let app_handle_c = app_handle.clone();
    d.on_message(Box::new(move |msg: DataChannelMessage| {
        let d_inner = Arc::clone(&d_c);
        let pid = peer_id_c.clone();
        let app_val = app_handle_c.clone();
        Box::pin(async move {
            if msg.data.is_empty() { return; }
            let msg_type = msg.data[0];
            let payload = &msg.data[1..];
            match msg_type {
                0x01 => { // Serial Data from remote
                    let label = d_inner.label();
                    println!("[WEBRTC] Incoming remote data on channel '{}'", label);
                    
                    if let Some(tab_id) = DC_TAB_MAP.get(&*label) {
                        let tab_id_str: &String = tab_id.value();
                        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
                        let event_payload = (tab_id_str.clone(), payload.to_vec(), ts as u64, "RX".to_string());
                        
                        let mut emitted = false;
                        if let Some(app) = app_val.as_ref() {
                            let _ = app.emit("serial-data", event_payload.clone());
                            emitted = true;
                        }

                        if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
                            println!("[WEBRTC] Routing data to tab {}", tab_id_str);
                            if !emitted {
                                let _ = ctx.app.emit("serial-data", event_payload);
                            }
                            // Only HOST should write to physical serial. Clients have "remote-x" tab IDs which won't write properly if they don't own it.
                            if label != "serial-bridge" {
                                let _ = ctx.serial.write_data(&ctx.app, tab_id_str, payload.to_vec(), "TX_REMOTE");
                            }
                        }
                    } else {
                        println!("[WEBRTC] WARNING: No tab mapped for channel '{}'. DC_TAB_MAP dump: {:?}", label, DC_TAB_MAP.iter().map(|kv| kv.key().clone()).collect::<Vec<_>>());
                    }
                }
                0x02 => { // Control
                    handle_control_message(pid, d_inner, payload).await;
                }
                0x03 => { // SSH Data from remote
                    let label = d_inner.label();
                    if let Some(tab_id) = DC_TAB_MAP.get(&*label) {
                        let tab_id_str: &String = tab_id.value();
                        if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
                            let _ = ctx.ssh.write_data(&ctx.app, tab_id_str, payload.to_vec());
                        }
                    }
                }
                _ => {}
            }
        })
    }));
}

#[derive(Debug, Serialize, Deserialize)]
struct SerialEventPayload(String, Vec<u8>, u64, String);

async fn handle_control_message(peer_id: String, d: Arc<RTCDataChannel>, payload: &[u8]) {
    if payload.is_empty() { return; }
    match payload[0] {
        0x01 => { // Open Serial [baud: u32 (4)] [path_len: u8 (1)] [path...]
            if payload.len() < 6 { return; }
            let baud = u32::from_le_bytes([payload[1], payload[2], payload[3], payload[4]]);
            let path_len = payload[5] as usize;
            if payload.len() < 6 + path_len { return; }
            let path = String::from_utf8_lossy(&payload[6..6+path_len]).to_string();
            
            println!("[REMOTE] Peer {} opening serial: {} @ {}", peer_id, path, baud);
            if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
                let tab_id = format!("remote-{}-{}", peer_id, d.label());
                let config = SerialConfig {
                    port_name: path,
                    baud_rate: baud,
                    data_bits: 8,
                    flow_control: "None".to_string(),
                    parity: "None".to_string(),
                    stop_bits: 1,
                };
                if let Ok(_) = ctx.serial.open_port(ctx.app.clone(), &tab_id, config.clone()) {
                    use tauri::Emitter;
                    let _ = ctx.app.emit("remote-tab-created", (tab_id.clone(), peer_id.clone(), config.port_name.clone()));
                    DC_TAB_MAP.insert(d.label().to_owned(), tab_id.clone());
                    
                    // Setup data forwarding from serial -> DataChannel
                    let d_c = Arc::clone(&d);
                    let tab_id_inner = tab_id.clone();
                    
                    ctx.app.listen("serial-data", move |event| {
                        if let Ok(payload) = serde_json::from_str::<SerialEventPayload>(event.payload()) {
                            if payload.0 == tab_id_inner && payload.3 == "RX" {
                                let mut packet = vec![0x01]; // Serial Data Type
                                packet.extend_from_slice(&payload.1);
                                let dc = d_c.clone();
                                tokio::spawn(async move {
                                    let _ = dc.send(&packet.into()).await;
                                });
                            }
                        }
                    });
                }
            }
        }
        0x02 => { // Open SSH [host: string] [port: u16] [user: string] [pass: string]
            // Format: [0x02, host_len, host..., port:u16LE, user_len, user..., pass_len, pass...]
            if payload.len() < 2 { return; }
            let mut cursor = 1;
            
            let host_len = payload[cursor] as usize; cursor += 1;
            if payload.len() < cursor + host_len + 5 { return; }
            let host = String::from_utf8_lossy(&payload[cursor..cursor+host_len]).to_string(); cursor += host_len;
            
            let port = u16::from_le_bytes([payload[cursor], payload[cursor+1]]); cursor += 2;
            
            let user_len = payload[cursor] as usize; cursor += 1;
            if payload.len() < cursor + user_len + 1 { return; }
            let user = String::from_utf8_lossy(&payload[cursor..cursor+user_len]).to_string(); cursor += user_len;
            
            let pass_len = payload[cursor] as usize; cursor += 1;
            if payload.len() < cursor + pass_len { return; }
            let pass = String::from_utf8_lossy(&payload[cursor..cursor+pass_len]).to_string();
            
            println!("[REMOTE] Peer {} opening SSH: {}@{}", peer_id, user, host);
            if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
                let tab_id = format!("remote-{}-{}", peer_id, d.label());
                if let Ok(_) = ctx.ssh.connect(ctx.app.clone(), &tab_id, &host, port, &user, "password", &pass) {
                    DC_TAB_MAP.insert(d.label().to_owned(), tab_id.clone());
                    
                    let d_c = Arc::clone(&d);
                    let tab_id_inner = tab_id.clone();
                    ctx.app.listen("serial-data", move |event| {
                        if let Ok(payload) = serde_json::from_str::<SerialEventPayload>(event.payload()) {
                            if payload.0 == tab_id_inner && payload.3 == "RX" {
                                let mut packet = vec![0x03]; // SSH Data Type
                                packet.extend_from_slice(&payload.1);
                                let dc = d_c.clone();
                                tokio::spawn(async move {
                                    let _ = dc.send(&packet.into()).await;
                                });
                            }
                        }
                    });
                }
            }
        }
        0x03 => { // Mirror Tab Signal [tab_id_len, tab_id...]
            if payload.len() < 2 { return; }
            let len = payload[1] as usize;
            if payload.len() < 2 + len { return; }
            let tab_id = String::from_utf8_lossy(&payload[2..2+len]).to_string();
            
            // Emit to frontend to add mirroring tab
            if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
                use tauri::Emitter;
                let _ = ctx.app.emit("remote-tab-created", (tab_id.clone(), peer_id, "Mirrored Session".to_string()));
                DC_TAB_MAP.insert(d.label().to_owned(), tab_id);
            }
        }
        0x04 => { // Project State Sync (Viewer -> Host)
            if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
                use tauri::Emitter;
                let payload_vec = payload.to_vec();
                let _ = ctx.app.emit("remote-project-sync", (peer_id, d.label().to_owned(), payload_vec));
            }
        }
        0x05 => { // Trigger Sequence (Viewer -> Host)
            if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
                use tauri::Emitter;
                let payload_vec = payload.to_vec();
                let _ = ctx.app.emit("remote-sequence-trigger", (peer_id, d.label().to_owned(), payload_vec));
            }
        }
        _ => {}
    }
}

pub async fn connect_remote(app: AppHandle, _tab_id: String, device_id: String) -> Result<(), String> {
    // let my_id = ensure_signaling_active(app.clone(), "unknown".to_string(), "wss://plan-signal-29066723448.asia-south1.run.app/ws".to_string()).await?; // GCP Server
    let my_id = ensure_signaling_active(app.clone(), "unknown".to_string(), "wss://plan-signal.onrender.com/ws".to_string()).await?;
    let api = create_webrtc_api();
    let config = create_webrtc_config();
    let pc = Arc::new(api.new_peer_connection(config).await.unwrap());
    let device_id_c = device_id.clone();
    let my_id_c = my_id.clone();
    
    let device_id_ice = device_id_c.clone();
    let my_id_ice = my_id_c.clone();
    pc.on_ice_candidate(Box::new(move |c| {
        let tid = device_id_ice.clone();
        let fid = my_id_ice.clone();
        Box::pin(async move {
            if let Some(candidate) = c {
                let json = candidate.to_json().unwrap();
                let msg = SignalMessage::IceCandidate { 
                    to_id: tid, 
                    from_id: fid,
                    candidate: serde_json::to_string(&json).unwrap() 
                };
                send_signal(msg).await;
            }
        })
    }));

    let pc_c = Arc::clone(&pc);
    SHARE_MANAGER.peers.insert(device_id.clone(), PeerState { 
        pc: pc_c,
        channels: Vec::new()
    });

    // Always use "serial-bridge" so broadcast_remote_data can find this channel
    let dc = pc.create_data_channel("serial-bridge", None).await.unwrap();
    setup_data_channel(device_id.clone(), dc, Some(app)).await;

    let offer = pc.create_offer(None).await.unwrap();
    pc.set_local_description(offer.clone()).await.unwrap();

    let off_msg = SignalMessage::Offer { 
        to_id: device_id.clone(), 
        from_id: my_id, 
        sdp: offer.sdp 
    };
    send_signal(off_msg).await;

    Ok(())
}

fn create_webrtc_api() -> webrtc::api::API {
    let mut m = MediaEngine::default();
    let _ = m.register_default_codecs();
    let registry = Registry::new();
    let registry = register_default_interceptors(registry, &mut m).unwrap();
    APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .build()
}

fn create_webrtc_config() -> RTCConfiguration {
    RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            ..Default::default()
        }],
        ..Default::default()
    }
}

async fn send_signal(msg: SignalMessage) {
    if let Some(tx) = SIGNAL_SENDER.lock().await.as_ref() {
        let _ = tx.send(Message::Text(serde_json::to_string(&msg).unwrap().into())).await;
    }
}

pub async fn get_display_id() -> Option<String> {
    SHARE_MANAGER.display_id.lock().await.clone()
}

// --- NEW UNIFIED SIGNALING COMMANDS ---

#[tauri::command]
pub async fn accept_remote_offer(from_id: String, sdp: String) -> Result<String, String> {
    let my_id = {
        let id_lock = SHARE_MANAGER.display_id.lock().await;
        id_lock.clone().ok_or("Signaling not started")?
    };
    handle_offer(my_id, from_id, sdp).await;
    // Note: handle_offer generates and sends the Answer sdp internally via WebSocket
    Ok("Answer sent".to_string())
}
