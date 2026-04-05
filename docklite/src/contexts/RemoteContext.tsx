import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { supabase } from '../utils/supabase';
import { RemoteSignaling } from '../utils/remote_signaling';

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
        // Listen for mirroring events from Rust (Host side)
        let unlistenConn: any;
        let unlistenDisc: any;

        import("@tauri-apps/api/event").then(({ listen }) => {
            unlistenConn = listen<string>('remote-peer-connected', (event) => {
                setActivePeers(prev => ({ ...prev, [event.payload]: { id: event.payload, status: 'connected' } }));
                addLog(`Peer CONNECTED: ${event.payload}`);
            });
            listen<any>('remote-channel-open', (event) => {
                const [fromId, label] = event.payload;
                addLog(`P2P Channel OPEN: ${label} from ${fromId}`);
                // Relay to internal JS event system so App.tsx works the same way
                const customEvent = new CustomEvent('remote-channel-open', {
                    detail: {
                        channel: { label, send: (data: any) => invoke('send_remote_data', { peerId: fromId, label, data: Array.from(new Uint8Array(data)) }) },
                        fromId
                    }
                });
                window.dispatchEvent(customEvent);
            });
            unlistenDisc = listen<string>('remote-peer-disconnected', (event) => {
                setActivePeers(prev => {
                    const next = { ...prev };
                    delete next[event.payload];
                    return next;
                });
                addLog(`Peer DISCONNECTED: ${event.payload}`);
            });
        }).catch(() => { });

        return () => {
            if (unlistenConn) unlistenConn.then((f: any) => f());
            if (unlistenDisc) unlistenDisc.then((f: any) => f());
        };
    }, []);

    const addLog = (msg: string) => {
        setDebugLogs(prev => [msg, ...prev].slice(0, 10));
    };

    const loadConfig = async () => {
        let dId = localStorage.getItem('remote-device-id');
        if (!dId) {
            // Generate unique ID initially
            const segment = () => Math.floor(100 + Math.random() * 900).toString();
            dId = `${segment()}-${segment()}-${segment()}`;
            localStorage.setItem('remote-device-id', dId);
        }
        setDeviceId(dId);

        const savedName = localStorage.getItem('remote-device-name');
        if (savedName) setDeviceName(savedName);

        const sharing = localStorage.getItem('remote-sharing-active') === 'true';
        if (sharing) setIsSharing(true);
    };

    const [isBackendReady, setIsBackendReady] = useState(false);

    useEffect(() => {
        const init = async () => {
            await loadConfig();
            // Re-sync with Rust if we were sharing
            const sharing = localStorage.getItem('remote-sharing-active') === 'true';
            const dId = localStorage.getItem('remote-device-id');
            if (sharing && dId) {
                console.log("[RemoteContext] Restoring Rust sharing state for:", dId);
                try {
                    await invoke('start_remote_sharing', { name: dId });
                } catch (e) {
                    // Ignore on WEB since no backend exists
                    if (!(window as any).__TAURI_INTERNALS__) {
                        console.log("[RemoteContext] Running on Web, bypassing Rust init.");
                    } else {
                        console.error("[RemoteContext] Failed to restore Rust sharing state", e);
                    }
                }
                setIsBackendReady(true);
            } else {
                setIsBackendReady(true);
            }
        };
        init();
    }, []);

    // Heartbeat & Name Sync
    useEffect(() => {
        if (!isSharing || !deviceId) return;

        localStorage.setItem('remote-sharing-active', 'true');
        localStorage.setItem('remote-device-name', deviceName);

        const sync = async () => {
            const mId = localStorage.getItem('remote-machine-id') || 'unknown';
            await supabase.from('remote_devices').upsert({
                id: deviceId,
                machine_id: mId,
                name: deviceName,
                status: 'online',
                last_seen: new Date().toISOString()
            });
        };

        sync();
        const interval = setInterval(sync, 30000);
        return () => clearInterval(interval);
    }, [isSharing, deviceId, deviceName]);

    // Signaling Listener
    useEffect(() => {
        if (deviceId && isBackendReady) {
            setSignalingStatus("initializing...");
            signalingRef.current = new RemoteSignaling(
                deviceId,
                (channel, peerId) => {
                    // Global DataChannel handler
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
            }).catch(() => setSignalingStatus("error"));
        }

        return () => {
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
                await invoke("start_remote_sharing", { name: deviceId });
            } catch (e) {
                console.error("[RemoteContext] Failed to start sharing backend:", e);
            }
        } else if (!next) {
            if (deviceId) {
                await supabase.from('remote_devices').update({ status: 'offline' }).eq('id', deviceId);
            }
            try {
                await invoke("stop_remote_sharing");
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
