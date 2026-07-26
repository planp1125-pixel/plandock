import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { supabase } from '../utils/supabase';
import { RemoteSignaling } from '../utils/remote_signaling';
import { safeInvoke, safeListen, isTauri } from '../utils/tauri';

interface IncomingCall {
    fromId: string;
    accept: () => Promise<void>;
    reject: () => void;
}

interface RemoteContextType {
    deviceId: string | null;
    isSharing: boolean;
    signalingStatus: string;
    debugLogs: string[];
    incomingCall: IncomingCall | null;
    activePeers: { [id: string]: any };
    setIncomingCall: (call: IncomingCall | null) => void;
    toggleSharing: () => Promise<void>;
    addLog: (msg: string) => void;
    signaling: RemoteSignaling | null;
    deviceName: string;
    setDeviceName: (name: string) => void;
}

const RemoteContext = createContext<RemoteContextType | undefined>(undefined);

export const RemoteProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [deviceId, setDeviceId] = useState<string | null>(null);
    const [isSharing, setIsSharing] = useState(false);
    const [deviceName, setDeviceName] = useState("My Device");
    const [signalingStatus, setSignalingStatus] = useState("idle");
    const [debugLogs, setDebugLogs] = useState<string[]>([]);
    const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
    const [activePeers, setActivePeers] = useState<{ [id: string]: any }>({});
    const [signalingInstance, setSignalingInstance] = useState<RemoteSignaling | null>(null);

    const signalingRef = useRef<RemoteSignaling | null>(null);
    const channelRef = useRef<any>(null);

    useEffect(() => {
        let unlistenConn: (() => void) | undefined;
        let unlistenChan: (() => void) | undefined;
        let unlistenDisc: (() => void) | undefined;
        let unlistenOffer: (() => void) | undefined;

        const setupListeners = async () => {
            unlistenConn = await safeListen<string>('remote-peer-connected', (event) => {
                setActivePeers(prev => ({ ...prev, [event.payload]: { id: event.payload, status: 'connected' } }));
                addLog(`Peer CONNECTED: ${event.payload}`);
            });

            // Handle WebRTC Offers received by Rust (Host side)
            unlistenOffer = await safeListen<[string, string]>('remote-offer', (event) => {
                console.log("[RemoteContext] Received remote-offer event payload:", event.payload);
                const [fromId, sdp] = event.payload;
                setIncomingCall({
                    fromId,
                    accept: async () => {
                        setActivePeers(prev => ({ ...prev, [fromId]: { id: fromId, status: 'connecting' } }));
                        try {
                            await safeInvoke('accept_remote_offer', { fromId, sdp });
                        } catch (e) {
                            console.error("Failed to accept offer:", e);
                        }
                        setIncomingCall(null);
                    },
                    reject: () => { setIncomingCall(null); }
                });
            });

            // Handle WebRTC DataChannels opened by Rust (Tauri Host side)
            unlistenChan = await safeListen<[string, string]>('remote-channel-open', (event) => {
                const [peerId, label] = event.payload;
                setActivePeers(prev => ({
                    ...prev,
                    [peerId]: { id: peerId, status: 'connected', label }
                }));
                addLog(`P2P Channel OPEN (Rust): ${label} from ${peerId}`);

                window.dispatchEvent(new CustomEvent('remote-channel-open', {
                    detail: { channel: { label }, fromId: peerId }
                }));
            });

            unlistenDisc = await safeListen<string>('remote-peer-disconnected', (event) => {
                setActivePeers(prev => {
                    const next = { ...prev };
                    delete next[event.payload];
                    return next;
                });
                addLog(`Peer DISCONNECTED: ${event.payload}`);
            });
        };

        setupListeners();

        return () => {
            if (unlistenConn) unlistenConn();
            if (unlistenChan) unlistenChan();
            if (unlistenDisc) unlistenDisc();
            if (unlistenOffer) unlistenOffer();
        };
    }, []);

    const addLog = (msg: string) => {
        setDebugLogs(prev => [msg, ...prev].slice(0, 10));
    };

    const loadConfig = async () => {
        const savedName = localStorage.getItem('remote-device-name') || "My Device";
        setDeviceName(savedName);

        // Fetch real machine_id from Rust and cache it in localStorage
        try {
            const mId = await safeInvoke<string>('get_machine_id');
            if (mId) localStorage.setItem('remote-machine-id', mId);
        } catch (e) {
            // Web mode — machine_id not available from Rust
        }

        // In Tauri mode: only use the ID that Rust has confirmed is registered on the signal
        // server. Never fall back to a stale localStorage value — that would cause Supabase
        // to be upserted with an ID nobody is listening for, making the device unreachable.
        // The 'remote-id-ready' event will set the correct ID once auto-init completes.
        let dId: string | null = null;
        if (isTauri()) {
            try {
                const rId = await safeInvoke<string | null>('get_remote_device_id');
                if (rId) {
                    dId = rId;
                    console.log("[RemoteContext] Got confirmed signal-server ID from Rust:", dId);
                } else {
                    console.log("[RemoteContext] Tauri auto-init still running — waiting for remote-id-ready");
                }
            } catch (e) { /* auto-init not yet complete */ }
        } else {
            // Web mode: use localStorage cache or claim from signal server
            dId = localStorage.getItem('remote-device-id');
            if (!dId) {
                try {
                    const mId = localStorage.getItem('remote-machine-id') || "browser-" + Math.random().toString(36).substring(7);
                    const resp = await fetch("https://plan-signal.onrender.com/claim-id", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: savedName, os: "Web", machine_id: mId })
                    });
                    const data = await resp.json();
                    dId = data.device_id;
                    if (dId) localStorage.setItem('remote-device-id', dId);
                } catch (e) {
                    console.error("[RemoteContext] Failed to claim ID from server", e);
                    const segment = () => Math.floor(100 + Math.random() * 900).toString();
                    dId = `${segment()}-${segment()}-${segment()}`;
                }
            }
        }

        // Ensure Web Viewer deviceId never collides with target ID in URL
        const urlTargetId = new URLSearchParams(window.location.search).get('id');
        if (dId && urlTargetId && dId === urlTargetId) {
            console.warn("[RemoteContext] Web Viewer deviceId matched target ID! Regenerating distinct browser deviceId...");
            const segment = () => Math.floor(100 + Math.random() * 900).toString();
            dId = `${segment()}-${segment()}-${segment()}`;
            localStorage.setItem('remote-device-id', dId);
        }

        if (dId) setDeviceId(dId);

        const sharing = localStorage.getItem('remote-sharing-active') === 'true';
        if (sharing) setIsSharing(true);
    };

    const [isBackendReady, setIsBackendReady] = useState(false);

    useEffect(() => {
        const init = async () => {
            await loadConfig();
            setIsBackendReady(true);
        };
        init();
    }, []);

    // Sync ID from Rust — fires after auto-init claims the device ID from the server.
    // Also immediately upserts to Supabase so the device is discoverable right away.
    useEffect(() => {
        const unlisten = safeListen<string>('remote-id-ready', (event) => {
            const id = event.payload;
            console.log("[RemoteContext] Rust claimed device ID:", id);
            setDeviceId(id);
            localStorage.setItem('remote-device-id', id);

            // Immediately register in Supabase — don't wait for state effects to cycle
            const mId = localStorage.getItem('remote-machine-id') || 'unknown';
            const name = localStorage.getItem('remote-device-name') || 'My Device';
            supabase.from('remote_devices').upsert({
                id,
                machine_id: mId,
                name,
                status: 'available',
                last_seen: new Date().toISOString()
            }).then(({ error }) => {
                if (error) console.error("[RemoteContext] Supabase upsert failed:", error);
                else console.log("[RemoteContext] Device registered in Supabase:", id);
            });
        });
        return () => { unlisten.then(f => f()); };
    }, []);

    // Supabase presence sync — runs whenever we have a deviceId, regardless of isSharing.
    // This ensures the device is always discoverable by the web app even if sharing was never toggled.
    useEffect(() => {
        if (!deviceId) return;

        localStorage.setItem('remote-device-name', deviceName);

        const sync = async () => {
            const mId = localStorage.getItem('remote-machine-id') || 'unknown';
            await supabase.from('remote_devices').upsert({
                id: deviceId,
                machine_id: mId,
                name: deviceName,
                // Web app is always online (no sharing toggle). Tauri app uses isSharing flag.
                status: (!isTauri() || isSharing) ? 'online' : 'available',
                last_seen: new Date().toISOString()
            });
        };

        sync();
        const interval = setInterval(sync, 30000);
        return () => clearInterval(interval);
    }, [deviceId, isSharing, deviceName]);

    // Mark offline in Supabase when sharing is explicitly stopped
    useEffect(() => {
        if (!isSharing) return;
        localStorage.setItem('remote-sharing-active', 'true');
        return () => {
            localStorage.setItem('remote-sharing-active', 'false');
            if (deviceId) {
                supabase.from('remote_devices').update({ status: 'offline' }).eq('id', deviceId);
            }
        };
    }, [isSharing, deviceId]);

    // Signaling Listener
    useEffect(() => {
        let retryTimer: any;

        const start = () => {
            if (!deviceId || !isBackendReady) return;

            setSignalingStatus("initializing...");
            const sig = new RemoteSignaling(
                deviceId,
                (channel, peerId) => {
                    addLog(`P2P DataChannel OPEN: ${channel.label} from ${peerId}`);
                    setActivePeers(prev => ({ ...prev, [peerId]: { id: peerId, status: 'connected', channel } }));

                    // Log audit trail to Supabase connection_logs
                    supabase.from('connection_logs').insert({
                        host_device_id: peerId,
                        client_device_id: deviceId,
                        event_type: 'SESSION_START',
                        details: { channel: channel.label }
                    }).then(({ error }) => {
                        if (error) console.error("[AuditLog] Failed to log SESSION_START:", error);
                        else console.log("[AuditLog] Session start logged:", peerId);
                    });

                    const event = new CustomEvent('remote-channel-open', { detail: { channel, fromId: peerId } });
                    window.dispatchEvent(event);

                    channel.onclose = () => {
                        setActivePeers(prev => {
                            const next = { ...prev };
                            delete next[peerId];
                            return next;
                        });
                        addLog(`P2P DataChannel CLOSED from ${peerId}`);

                        // Log session end to Supabase connection_logs
                        supabase.from('connection_logs').insert({
                            host_device_id: peerId,
                            client_device_id: deviceId,
                            event_type: 'SESSION_END',
                            details: { channel: channel.label }
                        }).then(({ error }) => {
                            if (error) console.error("[AuditLog] Failed to log SESSION_END:", error);
                        });
                    };
                },
                (fromId, accept) => {
                    setIncomingCall({
                        fromId,
                        accept: async () => {
                            setActivePeers(prev => ({ ...prev, [fromId]: { id: fromId, status: 'connecting' } }));
                            await accept();
                            setIncomingCall(null);
                        },
                        reject: () => { setIncomingCall(null); }
                    });
                },
                (msg) => addLog(msg)
            );

            signalingRef.current = sig;
            setSignalingInstance(sig);

            sig.startListening().then(c => {
                channelRef.current = c;
                setSignalingStatus("listening");
            }).catch(() => {
                setSignalingStatus("error - retrying in 5s");
                retryTimer = setTimeout(start, 5000);
            });
        };

        start();

        return () => {
            if (retryTimer) clearTimeout(retryTimer);
            if (channelRef.current) supabase.removeChannel(channelRef.current);
            signalingRef.current = null;
            setSignalingStatus("idle");
        };
    }, [deviceId, isBackendReady]);

    const toggleSharing = async () => {
        const next = !isSharing;
        setIsSharing(next);
        localStorage.setItem('remote-sharing-active', String(next));

        if (next && deviceId) {
            try {
                await safeInvoke("start_remote_sharing", { name: deviceId });
            } catch (e) {
                console.error("[RemoteContext] Failed to start sharing backend:", e);
            }
        } else if (!next) {
            try {
                await safeInvoke("stop_remote_sharing");
            } catch (e) {
                console.error("[RemoteContext] Failed to stop sharing backend:", e);
            }
        }
    };

    return (
        <RemoteContext.Provider value={{
            deviceId, isSharing, signalingStatus, debugLogs, incomingCall,
            activePeers,
            setIncomingCall, toggleSharing, addLog, signaling: signalingInstance,
            deviceName, setDeviceName
        }}>
            {children}
        </RemoteContext.Provider>
    );
};

export const useRemote = () => {
    const context = useContext(RemoteContext);
    if (!context) throw new Error("useRemote must be used within RemoteProvider");
    return context;
};
