import { safeInvoke, isTauri } from './tauri';

export type SignalType = 'offer' | 'answer' | 'ice_candidate' | 'heartbeat';

export interface SignalMessage {
    type: SignalType;
    from_id?: string;
    to_id?: string;
    sdp?: string;
    candidate?: string;
    device_id?: string;
}

export class RemoteSignaling {
    private myId: string;
    private ws: WebSocket | null = null;
    private peerConnection: RTCPeerConnection | null = null;
    private onDataChannelCallback: (channel: RTCDataChannel, peerId: string) => void;
    private onIncomingCallCallback?: (fromId: string, accept: () => void) => void;
    private onLogCallback?: (msg: string) => void;
    private lastTargetId: string | null = null;
    private isTauriPlatform: boolean = isTauri();
    private unlisten: any = null;
    private heartbeatInterval: any = null;

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


    }

    // 1. LISTEN FOR INCOMING SIGNALS
    public async startListening() {
        if (this.ws) return;

        // In Tauri, the Rust backend handles the signaling WebSocket centrally.
        // We skip the JS-side connection to prevent duplicate handling and conflicts.
        if (this.isTauriPlatform) {
            console.log("[Signaling] Running in Tauri, delegating signaling to Rust.");
            return;
        }

        // const wsUrl = "wss://plan-signal-29066723448.asia-south1.run.app/ws"; // GCP Server (Saved for future use)
        const wsUrl = "wss://plan-signal.onrender.com/ws";
        console.log(`[Signaling] Connecting to ${wsUrl} as ${this.myId}...`);

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log("[Signaling] WebSocket Connected");
            this.onLogCallback?.("Ready (WS)");
            // Heartbeat
            this.ws?.send(JSON.stringify({ type: 'heartbeat', device_id: this.myId }));
            this.heartbeatInterval = setInterval(() => {
                this.ws?.send(JSON.stringify({ type: 'heartbeat', device_id: this.myId }));
            }, 15000);
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data) as SignalMessage;
                if (msg.to_id === this.myId) {
                    this.onLogCallback?.(`Recv: ${msg.type}`);
                    this.handleIncomingSignal(msg);
                }
            } catch (e) {
                console.error("[Signaling] Failed to parse message", e);
            }
        };

        this.ws.onclose = () => {
            console.warn("[Signaling] WebSocket Closed");
            this.onLogCallback?.("Disconnected (WS)");
            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
            this.ws = null;
        };

        this.ws.onerror = (e) => {
            console.error("[Signaling] WS Error", e);
        };
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

        this.peerConnection = new RTCPeerConnection(config);

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.lastTargetId) {
                this.sendSignal(this.lastTargetId, 'ice_candidate', JSON.stringify(event.candidate));
            }
        };

        this.peerConnection.ondatachannel = (event) => {
            console.log("[WebRTC] Inbound DataChannel detected");
            this.setupDataChannel(event.channel, this.lastTargetId || "unknown");
        };

        return this.peerConnection;
    }

    // 4. SEND SIGNAL
    public async sendSignal(toId: string, type: string, payload: string) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error("[Signaling] Cannot send: WS not connected");
            return;
        }
        this.lastTargetId = toId;

        let msg: SignalMessage;
        if (type === 'offer' || type === 'answer') {
            msg = { type: type as SignalType, from_id: this.myId, to_id: toId, sdp: payload };
        } else if (type === 'ice_candidate') {
            msg = { type: 'ice_candidate', from_id: this.myId, to_id: toId, candidate: payload };
        } else {
            return;
        }

        this.ws.send(JSON.stringify(msg));
        this.onLogCallback?.(`Sent: ${type}`);
    }

    public cleanup() {
        if (this.unlisten) this.unlisten();
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.ws) this.ws.close();
    }

    // 4. HANDLE INCOMING MESSAGES
    private async handleIncomingSignal(msg: SignalMessage) {
        const fromId = msg.from_id || "unknown";

        if (msg.type === 'offer') {
            console.log(`[WebRTC] Evaluating offer from ${fromId}`);
            if (this.onIncomingCallCallback) {
                this.onIncomingCallCallback(fromId, async () => {
                    this.lastTargetId = fromId;
                    const pc = this.initPeerConnection();
                    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp! }));
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    this.sendSignal(fromId, 'answer', answer.sdp!);
                });
            }
        }
        else if (msg.type === 'answer') {
            await this.peerConnection?.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp! }));
        }
        else if (msg.type === 'ice_candidate') {
            const pc = this.initPeerConnection();
            try {
                await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(msg.candidate!)));
            } catch (e) {
                console.error("[WebRTC] Error adding received ice candidate", e);
            }
        }
    }

    // 5. INITIATE CONNECTION (Client side)
    public async connectTo(targetId: string) {
        console.log(`[WebRTC] Initiating connection to ${targetId}...`);
        this.lastTargetId = targetId;

        // Wait for WebSocket to be open if it's still connecting
        if (!this.isTauriPlatform) {
            if (!this.ws) throw new Error("WebSocket not initialized");
            if (this.ws.readyState !== WebSocket.OPEN) {
                console.log("[WebRTC] WebSocket not OPEN yet. Waiting...");
                await new Promise<void>((resolve, reject) => {
                    const checkInterval = setInterval(() => {
                        if (this.ws?.readyState === WebSocket.OPEN) {
                            clearInterval(checkInterval);
                            resolve();
                        } else if (this.ws?.readyState === WebSocket.CLOSED || this.ws?.readyState === WebSocket.CLOSING) {
                            clearInterval(checkInterval);
                            reject(new Error("WebSocket closed before connection could be established"));
                        }
                    }, 100);
                    // timeout after 10s
                    setTimeout(() => {
                        clearInterval(checkInterval);
                        reject(new Error("Timeout waiting for WebSocket to open"));
                    }, 10000);
                });
                console.log("[WebRTC] WebSocket now OPEN, proceeding with connectTo");
            }
        }

        if (this.isTauriPlatform) {
            const tabId = "remote-" + Math.random().toString(36).substring(7);
            safeInvoke('connect_remote', { tabId, deviceId: targetId })
                .catch(e => console.error("Failed to connect via Rust:", e));
            return null;
        } else {
            const pc = this.initPeerConnection();
            const channel = pc.createDataChannel("serial-bridge");
            this.setupDataChannel(channel, targetId);

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            this.sendSignal(targetId, 'offer', offer.sdp!);
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
