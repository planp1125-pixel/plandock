import { supabase } from './supabase';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export type SignalType = 'offer' | 'answer' | 'candidate';

export interface SignalMessage {
    from_id: string;
    to_id: string;
    type: SignalType;
    payload: string;
}

export class RemoteSignaling {
    private myId: string;
    private peerConnection: RTCPeerConnection | null = null;
    private onDataChannelCallback: (channel: RTCDataChannel, peerId: string) => void;
    private onIncomingCallCallback?: (fromId: string, accept: () => void) => void;
    private onLogCallback?: (msg: string) => void;
    private lastTargetId: string | null = null;
    private isTauri: boolean = !!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__ || !!(window as any).rpc;
    private unlisten: UnlistenFn | null = null;

    constructor(
        myId: string,
        onDataChannel: (channel: RTCDataChannel, peerId: string) => void,
        onIncomingCall?: (fromId: string, accept: () => void) => void,
        onLog?: (msg: string) => void
    ) {
        this.myId = myId;
        this.onDataChannelCallback = onDataChannel;
        this.onIncomingCallCallback = onIncomingCall;
        this.onLogCallback = onLog;

        // Setup Rust Signal Listener
        if (this.isTauri) {
            listen("rust-signal-out", (event: any) => {
                const msg = event.payload;
                console.log(`[Signaling] Relay from RUST: ${msg.type} to ${msg.to_id}`);
                this.sendSignal(msg.to_id, msg.type, msg.payload);
            }).then(u => this.unlisten = u);
        }
    }

    // 1. LISTEN FOR INCOMING SIGNALS
    public async startListening() {
        console.log(`[Signaling] Listening for signals to ${this.myId}...`);

        const channel = supabase
            .channel('signaling_relay')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'signaling',
                },
                (payload: any) => {
                    const msg = payload.new as SignalMessage;
                    this.onLogCallback?.(`Row: to=${msg.to_id}, type=${msg.type}`);

                    if (msg.to_id.trim() !== this.myId.trim()) return;

                    this.onLogCallback?.(`MATCH! ${msg.type}`);
                    this.handleIncomingSignal(msg);
                }
            )
            .subscribe((status) => {
                console.log(`[Signaling] Connection Status: ${status}`);
                if (status === 'CHANNEL_ERROR') {
                    console.warn("[Signaling] Realtime error! Possibly missing Publication/RLS.");
                }
            });

        return channel;
    }

    // 2. INITIALIZE PEER CONNECTION
    private initPeerConnection() {
        if (this.peerConnection) return this.peerConnection;

        const config: RTCConfiguration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ]
        };

        // RTCPeerConnection is now polyfilled by webrtc-adapter
        this.peerConnection = new RTCPeerConnection(config);

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.lastTargetId) {
                this.sendSignal(this.lastTargetId, 'candidate', JSON.stringify(event.candidate));
            }
        };

        this.peerConnection.ondatachannel = (event) => {
            console.log("[WebRTC] Inbound DataChannel detected");
            this.setupDataChannel(event.channel, this.lastTargetId || "unknown");
        };

        return this.peerConnection;
    }

    // 3. SEND SIGNAL VIA SUPABASE
    public async sendSignal(toId: string, type: SignalType, payload: string) {
        this.lastTargetId = toId;
        const { error } = await supabase
            .from('signaling')
            .insert({
                from_id: this.myId,
                to_id: toId,
                type: type,
                payload: payload
            });

        if (error) {
            this.onLogCallback?.(`Error: Send failed`);
            alert("Database write FAILED: " + error.message);
            console.error("[Signaling] Send failed", error);
        } else {
            this.onLogCallback?.(`Sent: ${type} to ${toId}`);
            // Only alert for 'TEST' type to avoid annoying the user during real handshakes
            if (payload === 'TEST') alert("Test signal SENT to Supabase for " + toId);
        }
    }

    public cleanup() {
        if (this.unlisten) this.unlisten();
    }

    // 4. HANDLE INCOMING MESSAGES
    private async handleIncomingSignal(msg: SignalMessage) {
        if (msg.type === 'offer') {
            console.log(`[WebRTC] Evaluating offer from ${msg.from_id}`);
            if (this.onIncomingCallCallback) {
                // MANUAL ACCEPT MODE
                this.onIncomingCallCallback(msg.from_id, async () => {
                    this.lastTargetId = msg.from_id; // Set target for candidates
                    if (this.isTauri) {
                        try {
                            const parsed = typeof msg.payload === 'string' && msg.payload.startsWith('{')
                                ? JSON.parse(msg.payload)
                                : { sdp: msg.payload };

                            const answerSdp = await invoke('process_supabase_offer', {
                                toId: this.myId,
                                fromId: msg.from_id,
                                sdp: parsed.sdp || msg.payload
                            }) as string;
                            this.sendSignal(msg.from_id, 'answer', JSON.stringify({ type: 'answer', sdp: answerSdp }));
                        } catch (e) {
                            console.error("[WebRTC] Rust failed to process offer", e);
                        }
                    } else {
                        const pc = this.initPeerConnection();
                        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.payload)));
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        this.sendSignal(msg.from_id, 'answer', JSON.stringify(answer));
                    }
                });
            }
        }
        else if (msg.type === 'answer') {
            if (!this.isTauri) {
                const pc = this.initPeerConnection();
                await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.payload)));
            }
        }
        else if (msg.type === 'candidate') {
            if (this.isTauri) {
                invoke('process_supabase_candidate', {
                    fromId: msg.from_id,
                    candidate: msg.payload
                }).catch(e => console.error("[WebRTC] Rust failed to add candidate", e));
            } else {
                const pc = this.initPeerConnection();
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(msg.payload)));
                } catch (e) {
                    console.error("[WebRTC] Error adding received ice candidate", e);
                }
            }
        }
    }

    // 5. INITIATE CONNECTION (Client side)
    public async connectTo(targetId: string) {
        console.log(`[WebRTC] Initiating connection to ${targetId}...`);

        if (this.isTauri) {
            // tab_id is needed for Rust's mapping
            // we'll use a generic "remote-id" for now as it's for global access
            const tabId = "remote-" + Math.random().toString(36).substring(7);
            await invoke('connect_remote', { tabId, deviceId: targetId });
            return null; // Rust handles the connection internally
        } else {
            const pc = this.initPeerConnection();

            // Create Data Channel
            const channel = pc.createDataChannel("serial-bridge");
            this.setupDataChannel(channel, targetId);

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            await this.sendSignal(targetId, 'offer', JSON.stringify(offer));
            return pc;
        }
    }

    private setupDataChannel(channel: RTCDataChannel, peerId: string) {
        channel.onopen = () => {
            console.log("[WebRTC] DataChannel is now OPEN");
            this.onDataChannelCallback(channel, peerId);
        };
        channel.onclose = () => console.log("[WebRTC] DataChannel CLOSED");
        channel.onerror = (e) => console.error("[WebRTC] DataChannel Error", e);
    }
}
