import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { supabase } from '../utils/supabase';
import { RemoteSignaling } from '../utils/remote_signaling';
import { safeInvoke, safeListen } from '../utils/tauri';

interface IncomingCall {
    fromId: string;
    accept: () => void;
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

    const signalingRef = useRef<RemoteSignaling | null>(null);
    const channelRef = useRef<any>(null);

    useEffect(() => {
        let unlistenConn: (() => void) | undefined;
        let unlistenChan: (() => void) | undefined;
        let unlistenDisc: (() => void) | undefined;

        const setupListeners = async () => {
            unlistenConn = await safeListen<string>('remote-peer-connected', (event) => {
                setActivePeers(prev => ({ ...prev, [event.payload]: { id: event.payload, status: 'connected' } }));
                addLog(`Peer CONNECTED: ${event.payload}`);
            });

            // Handle WebRTC Offers received by Rust (Host side)
            await safeListen<[string, string]>('remote-offer', (event) => {
                const [fromId, sdp] = event.payload;
                setIncomingCall({
                    fromId,
                    accept: () => {
                        setActivePeers(prev => ({ ...prev, [fromId]: { id: fromId, status: 'connecting' } }));
                        safeInvoke('accept_remote_offer', { fromId, sdp })
                            .catch(e => console.error("Failed to accept offer:", e));
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

        // In Tauri mode, Rust auto-init will emit 'remote-id-ready' with the correct ID.
        // We still try to get the current ID synchronously in case it was already claimed.
        let dId: string | null = null;
        try {
            const rId = await safeInvoke<string | null>('get_remote_device_id');
            if (rId) {
                dId = rId;
                console.log("[RemoteContext] Got ID from Rust (already claimed):", dId);
            }
        } catch (e) { /* not yet claimed */ }

        // Web mode fallback: use localStorage or claim from server
        if (!dId) {
            dId = localStorage.getItem('remote-device-id');
        }
        if (!dId) {
            try {
                const mId = localStorage.getItem('remote-machine-id') || "browser-" + Math.random().toString(36).substring(7);
                const resp = await fetch("https://plan-signal-29066723448.asia-south1.run.app/claim-id", {
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
        setDeviceId(dId);

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
                status: isSharing ? 'online' : 'available',
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
            signalingRef.current = new RemoteSignaling(
                deviceId,
                (channel, peerId) => {
                    addLog(`P2P DataChannel OPEN: ${channel.label} from ${peerId}`);
                    setActivePeers(prev => ({ ...prev, [peerId]: { id: peerId, status: 'connected', channel } }));

                    const event = new CustomEvent('remote-channel-open', { detail: { channel, fromId: peerId } });
                    window.dispatchEvent(event);

                    channel.onclose = () => {
                        setActivePeers(prev => {
                            const next = { ...prev };
                            delete next[peerId];
                            return next;
                        });
                        addLog(`P2P DataChannel CLOSED from ${peerId}`);
                    };
                },
                (fromId, accept) => {
                    setIncomingCall({
                        fromId,
                        accept: () => {
                            setActivePeers(prev => ({ ...prev, [fromId]: { id: fromId, status: 'connecting' } }));
                            accept();
                            setIncomingCall(null);
                        },
                        reject: () => { setIncomingCall(null); }
                    });
                },
                (msg) => addLog(msg)
            );

            signalingRef.current.startListening().then(c => {
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
            setIncomingCall, toggleSharing, addLog, signaling: signalingRef.current,
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
