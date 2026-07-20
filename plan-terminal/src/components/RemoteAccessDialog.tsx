import { useState, useEffect } from "react";
import { X, Share2, Search, Copy, Check, Globe, Cpu, Wifi, MonitorUp, Zap } from "lucide-react";
import { supabase } from "../utils/supabase";
import { useRemote } from "../contexts/RemoteContext";
import { invoke } from "@tauri-apps/api/core";

export function RemoteAccessDialog({ isOpen, onClose, activeTabId }: { isOpen: boolean; onClose: () => void; activeTabId: string }) {
    const {
        deviceId, isSharing, toggleSharing,
        signalingStatus, debugLogs, addLog,
        deviceName, setDeviceName, signaling, activePeers
    } = useRemote();

    const [remoteId, setRemoteId] = useState("");
    const [copied, setCopied] = useState(false);
    const [onlineDevices, setOnlineDevices] = useState<any[]>([]);
    const [finding, setFinding] = useState(false);

    // Device Discovery Effect
    useEffect(() => {
        if (!isOpen) return;

        const fetchDevices = async () => {
            const { data } = await supabase
                .from('remote_devices')
                .select('*')
                .in('status', ['online', 'available'])
                .neq('id', deviceId)
                .limit(10);
            if (data) setOnlineDevices(data);
        };

        fetchDevices();
        const interval = setInterval(fetchDevices, 10000);
        return () => clearInterval(interval);
    }, [isOpen, deviceId]);

    const findDevice = async () => {
        if (remoteId.length < 9) return;
        setFinding(true);
        try {
            const { data, error } = await supabase
                .from('remote_devices')
                .select('*')
                .eq('id', remoteId)
                .single();

            if (error) throw new Error("Device not found");
            if (data.status === 'offline') {
                alert(`Device ${remoteId} is currently OFFLINE.`);
            } else {
                if (!deviceId) return alert("Generate your ID first!");
                if (!signaling) return alert("Signaling not initialized. Try toggling Share ON.");

                await signaling.connectTo(remoteId);
                addLog(`Calling ${data.name}...`);
                onClose();
            }
        } catch (e) {
            alert("Error: " + (e as Error).message);
        } finally {
            setFinding(false);
        }
    };

    const handleShareTab = async (peerId: string) => {
        try {
            await invoke("share_active_tab", { tabId: activeTabId, peerId });
            addLog(`Shared tab ${activeTabId} with ${peerId}`);
            alert("Tab shared! The remote user should now see your session.");
        } catch (e) {
            alert("Sharing failed: " + e);
        }
    };

    const copyId = () => {
        if (deviceId) {
            navigator.clipboard.writeText(deviceId);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const [linkCopied, setLinkCopied] = useState(false);
    const copyWebLink = () => {
        if (deviceId) {
            const url = `https://plan-terminal-cloud.vercel.app/?id=${deviceId}`;
            navigator.clipboard.writeText(url);
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2000);
        }
    };

    if (!isOpen) return null;

    const peersList = Object.values(activePeers);

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 text-foreground">
            <div className="bg-card border shadow-2xl rounded-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200">
                <div className="px-5 py-4 border-b flex justify-between items-center bg-muted/30">
                    <div className="flex items-center gap-2">
                        <Share2 className="w-5 h-5 text-blue-500" />
                        <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Remote Connection Hub</h2>
                    </div>
                    <button onClick={onClose} className="p-1 hover:bg-accent rounded-full transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="max-h-[70vh] overflow-y-auto p-6 space-y-8 scrollbar-hide">
                    {/* SECTION: YOUR STATUS */}
                    <div className="space-y-4">
                        <div className="flex justify-between items-center">
                            <div>
                                <h3 className="text-sm font-semibold">Broadcasting Mode</h3>
                                <p className="text-[11px] text-muted-foreground">Make your serial/SSH sessions available via P2P.</p>
                            </div>
                            <button
                                onClick={toggleSharing}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${isSharing ? 'bg-blue-600' : 'bg-muted-foreground/30'}`}
                            >
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isSharing ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                        </div>

                        {isSharing && (
                            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 space-y-3 animate-in slide-in-from-top-2 duration-300">
                                <div className="flex justify-between items-center">
                                    <span className="text-[10px] font-bold uppercase text-blue-500">Your Signaling ID</span>
                                    <div className="flex items-center gap-1.5 text-blue-500/50">
                                        <div className={`w-2 h-2 rounded-full ${signalingStatus === 'listening' ? 'bg-green-500 animate-pulse' : 'bg-red-500'} shadow-[0_0_8px_rgba(34,197,94,0.6)]`} />
                                        <span className={`text-[10px] font-medium ${signalingStatus === 'listening' ? 'text-green-500' : 'text-red-500'}`}>{signalingStatus === 'listening' ? 'Active' : signalingStatus.toUpperCase()}</span>
                                    </div>
                                </div>
                                <div className="flex flex-col gap-2 mt-2">
                                    <div className="flex items-center gap-2">
                                        <code className="flex-1 bg-background border px-3 py-2 rounded text-xl font-mono text-center tracking-[0.2em] shadow-inner">{deviceId || "Assigning..."}</code>
                                        <button onClick={copyId} className="p-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors shadow-lg" title="Copy ID">{copied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}</button>
                                    </div>
                                    <button 
                                        onClick={copyWebLink} 
                                        className="w-full py-2 bg-white text-blue-600 hover:bg-zinc-100 rounded text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 shadow-md transition-colors"
                                    >
                                        <Globe className="w-4 h-4" />
                                        {linkCopied ? "Link Copied to Clipboard!" : "Copy Web Viewer Link"}
                                    </button>
                                </div>
                                <input type="text" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="Display Name (e.g. My PC)" className="w-full bg-background border rounded px-3 py-2 text-[11px] outline-none focus:ring-1 focus:ring-blue-500 mt-2" />
                            </div>
                        )}
                    </div>

                    {/* SECTION: ACTIVE CONNECTIONS */}
                    {peersList.length > 0 && (
                        <div className="space-y-3 animate-in slide-in-from-left-2 duration-300">
                            <div className="flex items-center gap-2 text-[11px] font-bold text-blue-500 uppercase tracking-tight">
                                <Zap className="w-3.5 h-3.5" />
                                <span>Active Connections ({peersList.length})</span>
                            </div>
                            <div className="grid gap-2">
                                {peersList.map((peer: any) => (
                                    <div key={peer.id} className="flex items-center justify-between p-3 bg-blue-600/5 border border-blue-500/20 rounded-lg">
                                        <div className="flex items-center gap-3">
                                            <div className="p-1.5 bg-blue-500 text-white rounded-md shadow-sm">
                                                <Globe className="w-3.5 h-3.5" />
                                            </div>
                                            <div className="overflow-hidden">
                                                <p className="text-xs font-bold truncate">{peer.id}</p>
                                                <p className="text-[9px] text-muted-foreground uppercase tracking-widest leading-none">P2P Established</p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleShareTab(peer.id)}
                                            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-[10px] font-bold uppercase shadow-sm active:scale-95 transition-all flex items-center gap-1.5"
                                        >
                                            <MonitorUp className="w-3 h-3" />
                                            Share Tab
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* SECTION: ONLINE DISCOVERY */}
                    {onlineDevices.length > 0 && (
                        <div className="space-y-3">
                            <div className="flex items-center gap-2 text-[11px] font-bold text-muted-foreground uppercase tracking-tight">
                                <Globe className="w-3.5 h-3.5" />
                                <span>Discovery (Online)</span>
                            </div>
                            <div className="grid gap-2">
                                {onlineDevices.map(device => (
                                    <button key={device.id} onClick={() => { setRemoteId(device.id); findDevice(); }} className="group flex items-center justify-between p-3 bg-muted/40 hover:bg-blue-500/10 border border-transparent hover:border-blue-500/30 rounded-lg transition-all text-left">
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-background rounded-full group-hover:bg-blue-500/10"><Cpu className="w-4 h-4 text-muted-foreground group-hover:text-blue-500" /></div>
                                            <div>
                                                <p className="text-xs font-bold">{device.name || "Unnamed Device"}</p>
                                                <p className="text-[10px] font-mono text-muted-foreground">{device.id}</p>
                                            </div>
                                        </div>
                                        <Wifi className="w-4 h-4 text-green-500 opacity-50 group-hover:opacity-100" />
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* SECTION: MANUAL ID */}
                    <div className="space-y-3 pt-2">
                        <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-tight">Manual Connection</label>
                        <div className="flex gap-2">
                            <div className="relative flex-1">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                <input type="text" value={remoteId} onChange={(e) => setRemoteId(e.target.value)} placeholder="XXX-XXX-XXX" className="w-full bg-background border rounded-lg pl-10 pr-4 py-2 text-lg font-mono tracking-wider outline-none focus:ring-2 focus:ring-blue-500 transition-all shadow-inner" />
                            </div>
                            <button onClick={findDevice} className="bg-zinc-800 hover:bg-zinc-700 text-white px-5 rounded-lg font-bold text-sm transition-all shadow-md active:scale-95 disabled:opacity-50" disabled={remoteId.length < 9 || finding}>{finding ? "..." : "Call"}</button>
                        </div>
                    </div>
                </div>

                <div className="px-6 py-2 border-t bg-black/5 flex flex-col gap-1">
                    <span className="text-[9px] font-bold text-muted-foreground uppercase">Console Log</span>
                    <div className="h-16 overflow-y-auto font-mono text-[9px] text-muted-foreground space-y-0.5 scrollbar-hide">
                        {debugLogs.length === 0 ? <p className="opacity-50 italic">Listening for events...</p> : debugLogs.map((log, i) => (
                            <div key={i} className="flex gap-2 items-start border-l border-blue-500/30 pl-2">
                                <span className="opacity-30">[{new Date().toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' })}]</span>
                                <span className={log.includes('CONNECTED') || log.includes('OPEN') ? 'text-green-500 font-bold' : ''}>{log}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
