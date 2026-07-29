import React, { useEffect, useRef, useState, useCallback } from 'react';
// @ts-ignore
import RFB from '@novnc/novnc';
import { safeInvoke, safeListen, isTauri } from '../utils/tauri';
import { Monitor, Maximize2, Minimize2, Eye, EyeOff, RefreshCw, Power } from 'lucide-react';

interface VncCanvasProps {
    tabId: string;
    host: string;
    port: number;
    password?: string;
    viewOnly?: boolean;
    isActive: boolean;
    connected: boolean;
    remoteChannel?: any;
    peerId?: string;
    onDisconnect?: () => void;
}

class VncTransportAdapter extends EventTarget {
    binaryType: string = 'arraybuffer';
    readyState: number = 0; // 0 = CONNECTING, 1 = OPEN
    url: string = 'wss://vnc.local';
    protocol: string = '';
    extensions: string = '';
    bufferedAmount: number = 0;

    private _onopen: ((ev: Event) => void) | null = null;
    private _onmessage: ((ev: MessageEvent) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;

    private pendingBuffer: Uint8Array[] = [];
    private sendCallback: (data: Uint8Array) => void;
    private closeCallback: () => void;

    constructor(sendCallback: (data: Uint8Array) => void, closeCallback: () => void) {
        super();
        this.sendCallback = sendCallback;
        this.closeCallback = closeCallback;

        // Asynchronously dispatch open event so noVNC attaches listeners first
        setTimeout(() => {
            this.readyState = 1; // 1 = OPEN
            const openEv = new Event('open');
            this.dispatchEvent(openEv);
            if (this._onopen) this._onopen(openEv);
        }, 0);
    }

    get onopen(): ((ev: Event) => void) | null {
        return this._onopen;
    }

    set onopen(fn: ((ev: Event) => void) | null) {
        this._onopen = fn;
    }

    get onmessage(): ((ev: MessageEvent) => void) | null {
        return this._onmessage;
    }

    set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        this._onmessage = fn;
        if (fn && this.pendingBuffer.length > 0) {
            const buffered = [...this.pendingBuffer];
            this.pendingBuffer = [];
            for (const bytes of buffered) {
                try {
                    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
                    const arrayBuffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
                    const msgEv = new MessageEvent('message', { data: arrayBuffer });
                    fn(msgEv);
                } catch (e) {
                    console.error('[VNC UI] Error in pendingBuffer flush:', e);
                }
            }
        }
    }

    send(data: ArrayBuffer | Uint8Array | string) {
        if (typeof data === 'string') {
            const encoder = new TextEncoder();
            this.sendCallback(encoder.encode(data));
        } else if (data instanceof ArrayBuffer) {
            this.sendCallback(new Uint8Array(data));
        } else if (data instanceof Uint8Array) {
            this.sendCallback(data);
        }
    }

    close() {
        this.readyState = 3; // CLOSED
        this.closeCallback();
        const closeEv = new CloseEvent('close');
        this.dispatchEvent(closeEv);
        if (this.onclose) this.onclose(closeEv);
    }

    receiveData(bytes: Uint8Array | number[]) {
        try {
            const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            if (!this._onmessage) {
                console.log('[VNC UI] receiveData queued in pendingBuffer:', uint8.length, 'bytes');
                this.pendingBuffer.push(uint8);
                return;
            }
            const arrayBuffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
            const msgEv = new MessageEvent('message', { data: arrayBuffer });
            this.dispatchEvent(msgEv);
            if (this._onmessage) {
                this._onmessage(msgEv);
            }
        } catch (e) {
            console.error('[VNC UI] Error in receiveData:', e);
        }
    }
}

export const VncCanvas: React.FC<VncCanvasProps> = ({
    tabId,
    host,
    port,
    password = '',
    viewOnly: initialViewOnly = false,
    isActive,
    connected,
    remoteChannel,
    peerId,
    onDisconnect
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const rfbRef = useRef<any>(null);
    const adapterRef = useRef<VncTransportAdapter | null>(null);

    const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');
    const [statusText, setStatusText] = useState<string>('Initializing VNC...');
    const [viewOnly, setViewOnly] = useState<boolean>(initialViewOnly);
    const [scaleViewport, setScaleViewport] = useState<boolean>(true);
    const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

    // Send binary RFB bytes to host backend or remote WebRTC DataChannel
    const sendRfbBytes = useCallback(async (bytes: Uint8Array) => {
        try {
            console.log('[VNC UI] sendRfbBytes sending:', bytes.length, 'bytes');
            if (!isTauri() && remoteChannel) {
                const payload = new Uint8Array(2 + bytes.length);
                payload[0] = 0x06; // VNC RFB Packet Type
                payload[1] = 0x01; // Direction: TX (Viewer -> Host)
                payload.set(bytes, 2);

                if (typeof remoteChannel.send === 'function') {
                    remoteChannel.send(payload);
                } else {
                    await safeInvoke('send_remote_data', { peerId, label: remoteChannel.label, data: Array.from(payload) });
                }
            } else if (remoteChannel) {
                const payload = new Uint8Array(2 + bytes.length);
                payload[0] = 0x06;
                payload[1] = 0x01;
                payload.set(bytes, 2);
                if (typeof remoteChannel.send === 'function') {
                    remoteChannel.send(payload);
                } else {
                    await safeInvoke('send_remote_data', { peerId, label: remoteChannel.label, data: Array.from(payload) });
                }
            } else {
                await safeInvoke('send_vnc_data', { tabId, data: Array.from(bytes) });
            }
        } catch (e) {
            console.error('[VNC] Error sending RFB data:', e);
        }
    }, [tabId, remoteChannel, peerId]);

    // Handle incoming VNC data stream
    useEffect(() => {
        const unlistenData = safeListen<[string, number[], number, string]>('vnc-data', (event: any) => {
            const [evTabId, bytes] = event.payload;
            if (evTabId !== tabId) return;
            console.log('[VNC UI] vnc-data received:', bytes.length, 'bytes');
            if (bytes.length > 100) {
                setStatus((prev) => (prev === 'connecting' ? 'connected' : prev));
                setStatusText((prev) => (prev.startsWith('Connecting') ? `Connected to VNC Remote Desktop (${host}:${port})` : prev));
            }
            if (adapterRef.current) {
                adapterRef.current.receiveData(new Uint8Array(bytes));
            }
        });

        const unlistenDisconnect = safeListen<string>('vnc-disconnected', (event: any) => {
            if (event.payload !== tabId) return;
            console.log('[VNC UI] vnc-disconnected event received for tab:', tabId);
            setStatus('disconnected');
            setStatusText('VNC session disconnected by host');
            if (rfbRef.current) {
                try { rfbRef.current.disconnect(); } catch (_) {}
            }
        });

        const handleRemoteBytes = (e: any) => {
            const bytes = e.detail;
            if (!bytes) return;
            console.log('[VNC UI] WebRTC vnc-remote-bytes received:', bytes.length, 'bytes');
            if (bytes.length > 100) {
                setStatus((prev) => (prev === 'connecting' ? 'connected' : prev));
                setStatusText((prev) => (prev.startsWith('Connecting') ? `Connected to VNC Remote Desktop (${host}:${port})` : prev));
            }
            if (adapterRef.current) {
                adapterRef.current.receiveData(new Uint8Array(bytes));
            }
        };
        window.addEventListener('vnc-remote-bytes', handleRemoteBytes);

        return () => {
            unlistenData.then((fn: any) => fn());
            unlistenDisconnect.then((fn: any) => fn());
            window.removeEventListener('vnc-remote-bytes', handleRemoteBytes);
        };
    }, [tabId]);

    // Initialize noVNC RFB engine
    const initVncEngine = useCallback(async () => {
        if (!containerRef.current) return;

        console.log('[VNC UI] initVncEngine connecting to:', host, port, 'connected:', connected);
        setStatus('connecting');
        setStatusText(`Connecting to VNC server at ${host}:${port}...`);

        if (rfbRef.current) {
            try { rfbRef.current.disconnect(); } catch (_) {}
            rfbRef.current = null;
        }

        try {
            // 1. Establish TCP socket connection first
            if (isTauri() && !tabId.startsWith('remote-')) {
                await safeInvoke('open_vnc', { tabId, host, port });
            }

            // 2. Instantiate noVNC RFB Engine AFTER socket is active
            const adapter = new VncTransportAdapter(
                (bytes) => sendRfbBytes(bytes),
                () => {
                    console.log('[VNC UI] Adapter closed');
                    setStatus('disconnected');
                    setStatusText('VNC transport closed');
                }
            );
            adapterRef.current = adapter;

            const rfb = new RFB(containerRef.current, adapter as any, {
                credentials: { password }
            });

            rfb.scaleViewport = scaleViewport;
            rfb.viewOnly = viewOnly;
            rfb.clipViewport = false;
            rfb.dragViewport = false;

            rfb.addEventListener('connect', () => {
                console.log('[VNC UI] RFB connected successfully!');
                setStatus('connected');
                setStatusText(`Connected to VNC Remote Desktop (${host}:${port})`);
            });

            rfb.addEventListener('desktopname', (e: any) => {
                console.log('[VNC UI] RFB desktopname event:', e.detail?.name);
                setStatus('connected');
                setStatusText(`Connected: ${e.detail?.name || 'Desktop'} (${host}:${port})`);
            });

            rfb.addEventListener('disconnect', (e: any) => {
                console.log('[VNC UI] RFB disconnected:', e.detail);
                setStatus('disconnected');
                setStatusText(e.detail?.clean ? 'Disconnected' : `Disconnected: ${e.detail?.reason || 'Connection lost'}`);
            });

            rfb.addEventListener('securityfailure', (e: any) => {
                console.error('[VNC UI] RFB securityfailure:', e.detail);
                setStatus('error');
                const reason = e.detail?.reason || 'Incorrect VNC Password';
                setStatusText(`VNC Authentication Failed: ${reason}`);
            });

            rfb.addEventListener('credentialsrequired', () => {
                console.log('[VNC UI] RFB credentialsrequired triggered, password present?:', Boolean(password));
                if (password) {
                    rfb.sendCredentials({ password });
                } else {
                    setStatus('connecting');
                    setStatusText('VNC Server requires a password...');
                    const userPass = prompt(`VNC Server at ${host}:${port} requires a password. Please enter VNC password:`);
                    if (userPass) {
                        rfb.sendCredentials({ password: userPass });
                    } else {
                        setStatus('error');
                        setStatusText('VNC Authentication required but password entry was cancelled');
                    }
                }
            });

            rfbRef.current = rfb;
        } catch (e: any) {
            console.error('[VNC] Engine init error:', e);
            setStatus('error');
            setStatusText(`Failed to connect to VNC: ${e.message || e}`);
        }
    }, [host, port, password, scaleViewport, viewOnly, sendRfbBytes, tabId]);

    useEffect(() => {
        if (isActive && connected) {
            initVncEngine();
        } else if (!connected && rfbRef.current) {
            try { rfbRef.current.disconnect(); } catch (_) {}
            rfbRef.current = null;
            setStatus('disconnected');
            setStatusText('Disconnected');
        }
        return () => {
            if (rfbRef.current) {
                try { rfbRef.current.disconnect(); } catch (_) {}
                rfbRef.current = null;
            }
            adapterRef.current = null;
        };
    }, [tabId, isActive, connected]);

    // Update settings when toggles change
    useEffect(() => {
        if (rfbRef.current) {
            rfbRef.current.scaleViewport = scaleViewport;
            rfbRef.current.viewOnly = viewOnly;
        }
    }, [scaleViewport, viewOnly]);

    const toggleFullscreen = () => {
        if (!containerRef.current) return;
        if (!document.fullscreenElement) {
            containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
        } else {
            document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
        }
    };

    return (
        <div className="flex flex-col h-full w-full bg-zinc-950 font-mono text-zinc-200 select-none overflow-hidden">
            {/* VNC Toolbar Header */}
            <div className="h-10 bg-zinc-900 border-b border-zinc-800 px-3 flex items-center justify-between text-xs flex-shrink-0">
                <div className="flex items-center gap-2">
                    <Monitor className="w-4 h-4 text-emerald-400" />
                    <span className="font-bold text-zinc-200">VNC Remote Desktop</span>
                    <span className="text-zinc-500">({host}:{port})</span>
                    
                    <div className="h-4 w-px bg-zinc-800 mx-1" />

                    <div className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full ${
                            status === 'connected' ? 'bg-emerald-500 animate-pulse' :
                            status === 'connecting' ? 'bg-amber-400 animate-ping' :
                            status === 'error' ? 'bg-red-500' : 'bg-zinc-600'
                        }`} />
                        <span className="text-[11px] text-zinc-400">{statusText}</span>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {/* View Only Toggle */}
                    <button
                        onClick={() => setViewOnly(prev => !prev)}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold transition-colors border ${
                            viewOnly 
                                ? 'bg-amber-950/60 border-amber-600/50 text-amber-300' 
                                : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-zinc-300'
                        }`}
                        title={viewOnly ? 'View Only (Input Blocked)' : 'Full Interactive Control'}
                    >
                        {viewOnly ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        <span>{viewOnly ? 'View Only' : 'Control'}</span>
                    </button>

                    {/* Scale Viewport Toggle */}
                    <button
                        onClick={() => setScaleViewport(prev => !prev)}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold transition-colors border ${
                            scaleViewport 
                                ? 'bg-indigo-950/60 border-indigo-600/50 text-indigo-300' 
                                : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-zinc-300'
                        }`}
                        title={scaleViewport ? 'Scaled to Window' : 'Original Resolution (1:1)'}
                    >
                        <span>{scaleViewport ? 'Fit View' : '1:1 Scale'}</span>
                    </button>

                    {/* Fullscreen Button */}
                    <button
                        onClick={toggleFullscreen}
                        className="p-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded border border-zinc-700 transition-colors"
                        title="Toggle Fullscreen"
                    >
                        {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                    </button>

                    {/* Reconnect Button */}
                    <button
                        onClick={initVncEngine}
                        className="p-1.5 bg-zinc-800 hover:bg-zinc-700 text-emerald-400 rounded border border-zinc-700 transition-colors"
                        title="Reconnect VNC"
                    >
                        <RefreshCw className="w-3.5 h-3.5" />
                    </button>

                    {/* Disconnect Button */}
                    {onDisconnect && (
                        <button
                            onClick={onDisconnect}
                            className="p-1.5 bg-red-950/60 hover:bg-red-900 text-red-400 rounded border border-red-800/50 transition-colors"
                            title="Disconnect VNC"
                        >
                            <Power className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            </div>

            {/* VNC Canvas Container */}
            <div 
                ref={containerRef}
                className="flex-1 w-full h-full relative overflow-auto flex items-center justify-center bg-black cursor-crosshair"
            >
                {status === 'connecting' && (
                    <div className="absolute inset-0 z-10 bg-zinc-950/90 backdrop-blur flex flex-col items-center justify-center gap-3">
                        <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin" />
                        <p className="text-sm font-semibold text-zinc-300">{statusText}</p>
                    </div>
                )}
            </div>
        </div>
    );
};
