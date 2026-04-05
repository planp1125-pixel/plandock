use std::sync::Arc;
use tokio::sync::Mutex;
use dashmap::DashMap;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::data_channel::RTCDataChannel;
use webrtc::api::APIBuilder;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
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
use crate::ActiveReaction;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SignalMessage {
    Heartbeat { device_id: String },
    Goodbye { device_id: String },
    Offer { from_id: String, to_id: String, sdp: String },
    Answer { from_id: String, to_id: String, sdp: String },
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

pub struct ManagerContext {
    pub serial: Arc<SerialManager>,
    pub tcp: Arc<TcpManager>,
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
                setup_data_channel(peer_id.clone(), new_dc.clone()).await;
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

pub async fn start_sharing(
    app: AppHandle,
    serial: Arc<SerialManager>,
    tcp: Arc<TcpManager>,
    ssh: Arc<SshManager>,
    name: String, 
    signal_url: String
) -> Result<String, String> {
    let mut running = SHARE_MANAGER.is_running.lock().await;
    if *running {
        return Err("Already sharing".to_string());
    }
    *running = true;

    *MANAGER_CONTEXT.lock().await = Some(ManagerContext {
        serial,
        tcp,
        ssh,
        app: app.clone(),
    });

    let machine_id = get_machine_id(&app);

    // 1. Claim ID via HTTP
    let base_url = signal_url.replace("wss://", "https://").replace("ws://", "http://").replace("/ws", "");
    let client = reqwest::Client::new();
    let resp = client.post(format!("{}/claim-id", base_url))
        .json(&serde_json::json!({ "name": name, "os": "Linux", "machine_id": machine_id }))
        .send().await.map_err(|e| e.to_string())?;
    
    let claim_resp: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let device_id = claim_resp["device_id"].as_str().ok_or("No device_id in response")?.to_string();
    println!("[SIGNAL] Claimed/Restored Device ID: {}", device_id);
    *SHARE_MANAGER.display_id.lock().await = Some(device_id.clone());

    // 2. Connect WebSocket
    println!("[SIGNAL] Connecting to WebSocket: {}...", signal_url);
    let (mut ws_stream, _) = connect_async(signal_url).await.map_err(|e| e.to_string())?;
    println!("[SIGNAL] WebSocket Connected!");

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Message>(100);
    *SIGNAL_SENDER.lock().await = Some(tx);

    // 3. Send Heartbeat to register session
    let hb = SignalMessage::Heartbeat { device_id: device_id.clone() };
    ws_stream.send(Message::Text(serde_json::to_string(&hb).unwrap().into())).await.map_err(|e| e.to_string())?;

    let device_id_c = device_id.clone();
    tokio::spawn(async move {
        loop {
            // Check if we should still be running
            if !*SHARE_MANAGER.is_running.lock().await {
                break;
            }

            tokio::select! {
                Some(Ok(msg)) = ws_stream.next() => {
                    if let Message::Text(text) = msg {
                        if let Ok(signal) = serde_json::from_str::<serde_json::Value>(&text.to_string()) {
                            let msg_type = signal["type"].as_str().unwrap_or("");
                            match msg_type {
                                "offer" => {
                                    let from = signal["from_id"].as_str().unwrap_or("").to_string();
                                    let sdp = signal["sdp"].as_str().unwrap_or("").to_string();
                                    if !from.is_empty() {
                                        println!("[SIGNAL] Received Offer from: {}", from);
                                        handle_offer(device_id_c.clone(), from, sdp).await;
                                    }
                                }
                                "answer" => {
                                    let from = signal["from_id"].as_str().unwrap_or("").to_string();
                                    let sdp = signal["sdp"].as_str().unwrap_or("").to_string();
                                    if !from.is_empty() {
                                        handle_answer(from, sdp).await;
                                    }
                                }
                                "ice_candidate" => {
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
                    let _ = ws_stream.send(out_msg).await;
                }
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(500)) => {
                    // Just a small sleep to avoid tight loop if selectivity is weird, 
                    // though select! handles it.
                }
            }
        }
        println!("[SIGNAL] Sharing task stopped.");
        *SHARE_MANAGER.display_id.lock().await = None;
        *SHARE_MANAGER.is_running.lock().await = false;
        SHARE_MANAGER.peers.clear();
        *SIGNAL_SENDER.lock().await = None;
    });

    Ok("Starting".to_string())
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
                let msg = SignalMessage::IceCandidate { 
                    to_id: tid, 
                    from_id: fid,
                    candidate: candidate.to_json().unwrap().candidate 
                };
                send_signal(msg).await;
            }
        })
    }));

    let from_dc = from_c.clone();
    pc.on_data_channel(Box::new(move |d| {
        let from_cc = from_dc.clone();
        Box::pin(async move {
            setup_data_channel(from_cc, d).await;
        })
    }));

    pc.set_remote_description(RTCSessionDescription::offer(sdp).unwrap()).await.unwrap();
    let answer = pc.create_answer(None).await.unwrap();
    pc.set_local_description(answer.clone()).await.unwrap();

    let ans_msg = SignalMessage::Answer { to_id: from.clone(), from_id: my_id, sdp: answer.sdp };
    send_signal(ans_msg).await;

    let pc_c = Arc::clone(&pc);
    SHARE_MANAGER.peers.insert(from, PeerState { 
        pc: pc_c,
        channels: Vec::new()
    });
}

async fn handle_answer(from: String, sdp: String) {
    if let Some(peer) = SHARE_MANAGER.peers.get(&from) {
        let _ = peer.pc.set_remote_description(RTCSessionDescription::answer(sdp).unwrap()).await;
    }
}

async fn handle_ice_candidate(from: String, candidate: String) {
    if let Some(peer) = SHARE_MANAGER.peers.get(&from) {
        let _ = peer.pc.add_ice_candidate(RTCIceCandidateInit {
            candidate,
            ..Default::default()
        }).await;
    }
}

/// Mappings to track which DataChannel belongs to which virtual tab
static DC_TAB_MAP: Lazy<DashMap<String, String>> = Lazy::new(|| DashMap::new());

async fn setup_data_channel(peer_id: String, d: Arc<RTCDataChannel>) {
    let label = d.label().to_owned();
    
    if let Some(mut peer) = SHARE_MANAGER.peers.get_mut(&peer_id) {
        peer.channels.push(Arc::clone(&d));
    }

    // Auto-map labeled channels for terminal data routing (Client side)
    if label.starts_with("serial-") || label.starts_with("ssh-") || label.starts_with("remote-") {
        println!("[WEBRTC] Mapping data channel {} to self", label);
        DC_TAB_MAP.insert(label.clone(), label.clone());

        // Notify frontend that a new channel is ready
        if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
            let _ = ctx.app.emit("remote-channel-open", (peer_id.clone(), label.clone()));
        }
    }

    let d_c = Arc::clone(&d);
    let peer_id_c = peer_id.clone();
    d.on_message(Box::new(move |msg: DataChannelMessage| {
        let d_inner = Arc::clone(&d_c);
        let pid = peer_id_c.clone();
        Box::pin(async move {
            if msg.data.is_empty() { return; }
            let msg_type = msg.data[0];
            let payload = &msg.data[1..];
            match msg_type {
                0x01 => { // Serial Data from remote
                    let label = d_inner.label();
                    if let Some(tab_id) = DC_TAB_MAP.get(&*label) {
                        let tab_id_str: &String = tab_id.value();
                        if let Some(ctx) = MANAGER_CONTEXT.lock().await.as_ref() {
                            println!("[WEBRTC] Writing remote {} bytes to tab {}", payload.len(), tab_id_str);
                            let _ = ctx.serial.write_data(&ctx.app, tab_id_str, payload.to_vec(), "TX_REMOTE");
                        }
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
                            let _ = ctx.ssh.write_data(tab_id_str, payload.to_vec());
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
        _ => {}
    }
}

pub async fn connect_remote(tab_id: String, device_id: String) -> Result<(), String> {
    let my_id = SHARE_MANAGER.display_id.lock().await.clone().unwrap_or_else(|| "unknown".to_string());
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
                let msg = SignalMessage::IceCandidate { 
                    to_id: tid, 
                    from_id: fid,
                    candidate: candidate.to_json().unwrap().candidate 
                };
                send_signal(msg).await;
            }
        })
    }));

    let dc = pc.create_data_channel(&format!("remote-{}", tab_id), None).await.unwrap();
    setup_data_channel(device_id.clone(), dc).await;

    let offer = pc.create_offer(None).await.unwrap();
    pc.set_local_description(offer.clone()).await.unwrap();

    let off_msg = SignalMessage::Offer { 
        to_id: device_id.clone(), 
        from_id: my_id, 
        sdp: offer.sdp 
    };
    send_signal(off_msg).await;

    let pc_c = Arc::clone(&pc);
    SHARE_MANAGER.peers.insert(device_id, PeerState { 
        pc: pc_c,
        channels: Vec::new()
    });
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

// --- NEW SUPABASE BRIDGE COMMANDS ---

pub async fn handle_supabase_offer(app: AppHandle, to_id: String, from_id: String, offer_sdp: String) -> Result<String, String> {
    println!("[WEBRTC-RUST] STEP 1: Incoming offer from {}", from_id);
    
    // Heuristic: Set our display_id if it's currently missing, based on the 'to_id' of this offer
    let my_id = {
        let mut id_lock = SHARE_MANAGER.display_id.lock().await;
        if id_lock.is_none() {
             println!("[WEBRTC-RUST] HEALING: display_id was NONE. Claiming ID: {}", to_id);
             *id_lock = Some(to_id.clone());
             to_id
        } else {
            id_lock.clone().unwrap()
        }
    };
    println!("[WEBRTC-RUST] STEP 2: My Signaling ID Context: {}", my_id);
    
    let api = create_webrtc_api();
    let config = create_webrtc_config();
    let pc = Arc::new(api.new_peer_connection(config).await.map_err(|e| {
        println!("[WEBRTC-RUST] ERROR: PeerConnection creation failed: {}", e);
        e.to_string()
    })?);
    let pc_c = Arc::clone(&pc);
    println!("[WEBRTC-RUST] STEP 3: PeerConnection CREATED");
    
    // 1. ICE Candidate Handler
    let app_ice = app.clone();
    let from_ice = from_id.clone();
    let my_id_ice = my_id.clone();
    pc.on_ice_candidate(Box::new(move |c| {
        let app_inner = app_ice.clone();
        let target = from_ice.clone();
        let me = my_id_ice.clone();
        Box::pin(async move {
            if let Some(candidate) = c {
                if let Ok(json) = candidate.to_json() {
                    let msg = serde_json::json!({
                        "type": "candidate",
                        "from_id": me,
                        "to_id": target,
                        "payload": serde_json::to_string(&json).unwrap()
                    });
                    let _ = app_inner.emit("rust-signal-out", msg);
                }
            }
        })
    }));

    // 2. Data Channel Handler
    let from_dc = from_id.clone();
    let peer_id_pc = from_id.clone();
    let app_pc = app.clone();
    pc.on_data_channel(Box::new(move |d| {
        let pid = from_dc.clone();
        Box::pin(async move {
            setup_data_channel(pid, d).await;
        })
    }));

    let _ = pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
        let pid = peer_id_pc.clone();
        let app_pcc = app_pc.clone();
        Box::pin(async move {
            println!("[WEBRTC] Peer {} state changed: {}", pid, s);
            if s == RTCPeerConnectionState::Connected {
                let _ = app_pcc.emit("remote-peer-connected", pid);
            } else if s == RTCPeerConnectionState::Disconnected || s == RTCPeerConnectionState::Failed {
                let _ = app_pcc.emit("remote-peer-disconnected", pid);
            }
        })
    }));
    pc.set_remote_description(RTCSessionDescription::offer(offer_sdp).map_err(|e| {
        println!("[WEBRTC-RUST] ERROR: set_remote_description failed: {}", e);
        e.to_string()
    })?).await.map_err(|e| e.to_string())?;
    println!("[WEBRTC-RUST] STEP 4: Remote Description SET");
    
    // 4. Create Answer
    let answer = pc.create_answer(None).await.map_err(|e| {
        println!("[WEBRTC-RUST] ERROR: create_answer failed: {}", e);
        e.to_string()
    })?;
    pc.set_local_description(answer.clone()).await.map_err(|e| e.to_string())?;
    println!("[WEBRTC-RUST] STEP 5: Answer CREATED & SET locally");
    
    // 5. Store Peer
    let id_key = from_id.trim().to_string();
    SHARE_MANAGER.peers.insert(id_key.clone(), PeerState { 
        pc: pc_c,
        channels: Vec::new()
    });
    println!("[WEBRTC-RUST] SUCCESS: Peer ID {:?} INSTALLED in Manager. Total peers: {}", id_key, SHARE_MANAGER.peers.len());
    
    Ok(answer.sdp)
}

pub async fn handle_supabase_candidate(from_id: String, candidate_json: String) -> Result<(), String> {
    let from_id = from_id.trim();
    if let Some(peer) = SHARE_MANAGER.peers.get(from_id) {
        if let Ok(init) = serde_json::from_str::<RTCIceCandidateInit>(&candidate_json) {
            peer.pc.add_ice_candidate(init).await.map_err(|e| e.to_string())?;
        } else {
            // Fallback for simple string candidates if any
            peer.pc.add_ice_candidate(RTCIceCandidateInit {
                candidate: candidate_json,
                ..Default::default()
            }).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
