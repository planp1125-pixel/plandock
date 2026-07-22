import { useState, useEffect, useCallback } from "react";
import { Workspace } from "./components/Workspace";
import { safeInvoke, safeListen } from './utils/tauri';
import { LicenseDialog } from "./components/LicenseDialog";
import { LicenseProvider } from "./contexts/LicenseContext";
import { Moon, Sun, Crown, X, Plus, Share2, Users } from "lucide-react";

import logo from "./assets/logo.png";
import { RemoteAccessDialog } from "./components/RemoteAccessDialog";
import "./index.css";

import { useRemote } from "./contexts/RemoteContext";
import { isTauri } from "./utils/tauri";
import { useRef } from "react";

interface Tab {
  id: string;
  name: string;
  connected: boolean;
  connLabel: string;
  type?: 'Serial' | 'TCP' | 'SSH' | 'Remote';
  remoteChannel?: any;
  peerId?: string;
}

function App() {
  const { incomingCall, isSharing, deviceName, activePeers, signaling, deviceId } = useRemote();
  const [tabs, setTabs] = useState<Tab[]>([{ id: 'main', name: 'New Project', connected: false, connLabel: '', type: 'Serial' }]);
  const [activeTabId, setActiveTabId] = useState('main');

  const [showLicenseDialog, setShowLicenseDialog] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('darkMode');
    return saved ? saved === 'true' : true;
  });

  const [showRemoteDialog, setShowRemoteDialog] = useState(false);
  const [autoScroll, setAutoScroll] = useState(() => {
    const saved = localStorage.getItem('terminal-autoscroll');
    return saved !== null ? saved === 'true' : true;
  });

  const [isWebViewer, setIsWebViewer] = useState(false);
  const [webTargetId, setWebTargetId] = useState<string | null>(null);
  const hasConnected = useRef(false);

  useEffect(() => {
    if (isTauri()) return;
    const searchParams = new URLSearchParams(window.location.search);
    const targetId = searchParams.get('id');
    if (targetId) {
      setIsWebViewer(true);
      setWebTargetId(targetId);
      // Ensure we start with a clean remote tab rather than 'New Project'
      setTabs([{ id: 'remote-init', name: `Connecting to ${targetId}...`, connected: false, connLabel: '', type: 'Remote' }]);
      setActiveTabId('remote-init');
    }
  }, []);

  useEffect(() => {
    if (isWebViewer && webTargetId && signaling && deviceId && !hasConnected.current) {
      hasConnected.current = true;
      console.log("[WebViewer] Auto-connecting to:", webTargetId);
      signaling.connectTo(webTargetId).catch(e => console.error("WebConnect error", e));
    }
  }, [isWebViewer, webTargetId, signaling, deviceId]);

  // Listen for global remote channel events
  useEffect(() => {
    const handleRemoteOpen = (e: any) => {
      const { channel, fromId } = e.detail;
      const label = channel.label;
      console.log(`[App] Remote DataChannel OPEN: ${label} from ${fromId}`);

      setTabs(prev => {
        if (isWebViewer) {
          return [{
            id: fromId,
            name: `Remote: ${fromId}`,
            connected: true,
            connLabel: label,
            type: 'Remote',
            remoteChannel: channel,
            peerId: fromId
          }];
        }

        // If it's a specific shared tab (e.g. serial-xxx)
        if (label.startsWith('serial-') || label.startsWith('ssh-') || label.startsWith('remote-')) {
          const existing = prev.find(t => t.id === label);
          if (existing) {
            return prev.map(t => t.id === label ? { ...t, connected: true, remoteChannel: channel } : t);
          }
          return [...prev, {
            id: label,
            name: `Remote: ${label.split('-')[0]} (${fromId})`,
            connected: true,
            connLabel: label,
            type: 'Remote',
            remoteChannel: channel,
            peerId: fromId
          }];
        }

        // Default signaling channel
        const existing = prev.find(t => t.id === fromId);
        if (existing) {
          return prev.map(t => t.id === fromId ? { ...t, connected: true, remoteChannel: channel, peerId: fromId } : t);
        }
        return [...prev, {
          id: fromId,
          name: `Remote: ${fromId}`,
          connected: true,
          connLabel: fromId,
          type: 'Remote',
          remoteChannel: channel,
          peerId: fromId
        }];
      });

      if (isWebViewer || label.startsWith('serial-') || label.startsWith('ssh-')) {
        setActiveTabId(isWebViewer ? fromId : label);
      }
    };

    window.addEventListener('remote-channel-open', handleRemoteOpen);

    // Listen for mirroring events from Rust (Host side explicitly created tabs)
    const unlistenCreatedPromise = safeListen<any>('remote-tab-created', (event) => {
      const [tabId, peerId, portName] = event.payload;
      setTabs(prev => {
        if (prev.find(t => t.id === tabId)) return prev;
        return [...prev, {
          id: tabId,
          name: `Mirror: ${portName} (${peerId})`,
          connected: true,
          connLabel: portName,
          type: 'Serial' // On host it acts like a normal serial tab
        }];
      });
      setActiveTabId(tabId);
    });

    return () => {
      window.removeEventListener('remote-channel-open', handleRemoteOpen);
      unlistenCreatedPromise.then(u => { if (u) u(); });
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('terminal-autoscroll', String(autoScroll));
  }, [autoScroll]);


  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  const toggleDarkMode = () => {
    const next = !darkMode;
    setDarkMode(next);
    localStorage.setItem('darkMode', String(next));
    if (next) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const addTab = () => {
    const id = Math.random().toString(36).substring(2, 9);
    setTabs([...tabs, { id, name: 'New Project', connected: false, connLabel: '', type: 'Serial' }]);
    setActiveTabId(id);
  };

  const closeTab = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (tabs.length === 1) return;

    // Cleanup backend connections for this tab before removing it from state
    const tab = tabs.find(t => t.id === id);
    if (tab?.type === 'Remote' && tab.remoteChannel) {
      tab.remoteChannel.close();
    } else {
      try {
        await safeInvoke("close_serial_port", { tabId: id });
        await safeInvoke("disconnect_tcp", { tabId: id });
        await safeInvoke("disconnect_ssh", { tabId: id });
      } catch (err) {
        console.error("Cleanup failed for tab", id, err);
      }
    }

    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);
    if (activeTabId === id) setActiveTabId(newTabs[newTabs.length - 1].id);
  };

  const updateTabConn = useCallback((id: string, connected: boolean, label: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, connected, connLabel: label } : t));
  }, []);

  const updateTabName = useCallback((id: string, name: string) => {
    setTabs(prev => prev.map(t => t.id === id && t.name !== name ? { ...t, name } : t));
  }, []);

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden">
      {/* GLOBAL HEADER */}
      <header className="px-3 py-0 border-b flex justify-between items-center bg-card shadow-sm shrink-0 h-10">
        <div className="flex items-center flex-1 overflow-x-auto h-full pr-4">
          <div className="flex items-center justify-center gap-1.5 mr-4 shrink-0 pl-1">
            <img src={logo} alt="Plan Terminal" className="w-5 h-5 pointer-events-none" />
            <span className="text-[10px] text-muted-foreground font-medium select-none">v0.5.11</span>
          </div>

          <div className="flex items-end h-full pt-1.5 overflow-x-auto select-none no-scrollbar">
            {tabs.map(tab => (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-t border border-b-0 cursor-pointer transition-colors max-w-[200px] min-w-[120px] ${activeTabId === tab.id
                  ? 'bg-background border-border text-foreground font-semibold relative -mb-[1px] shadow-[0_-2px_4px_rgba(0,0,0,0.05)]'
                  : 'bg-muted border-transparent text-muted-foreground hover:bg-muted/80'
                  }`}
              >
                <div className={`w-2 h-2 rounded-full shrink-0 ${tab.connected ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500/30'}`} />
                <span
                  className="text-xs truncate w-full cursor-text"
                  title={tab.name + (tab.connLabel ? ` (${tab.connLabel})` : '') + "\nDouble-click to rename"}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    const newName = prompt("Rename tab:", tab.name);
                    if (newName && newName.trim().length > 0) {
                      updateTabName(tab.id, newName.trim());
                    }
                  }}
                >
                  {tab.name}
                </span>
                {tabs.length > 1 && (
                  <button onClick={(e) => closeTab(e, tab.id)} className="p-0.5 hover:bg-black/10 dark:hover:bg-white/10 rounded-full shrink-0">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-end h-full pb-1 pl-2">
            {!isWebViewer && (
              <button
                type="button"
                className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 outline-none focus:outline-none focus:ring-0"
                onClick={addTab}
                title="New Tab"
              >
                <Plus className="w-4 h-4 pointer-events-none" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {isWebViewer && (
            <div className="px-2 py-0.5 bg-blue-500/10 text-blue-500 rounded border border-blue-500/20 text-[10px] font-bold uppercase tracking-wider mr-2">
              Web Remote Mode
            </div>
          )}
          <button onClick={toggleDarkMode} className="p-1.5 hover:bg-accent rounded outline-none" title="Toggle Theme">
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          {!isWebViewer && (
            <>
              <button onClick={() => setShowLicenseDialog(true)} className="p-1.5 hover:bg-accent rounded text-amber-500 outline-none" title="License Pro">
                <Crown className="w-4 h-4" />
              </button>
              <div className="w-px h-4 bg-border mx-1" />
              <button
                onClick={() => setShowRemoteDialog(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-600/10 hover:bg-blue-600/20 text-blue-500 border border-blue-500/30 rounded-md transition-all text-[11px] font-bold uppercase tracking-tight"
                title="Remote Access & Sharing"
              >
                <Share2 className="w-3.5 h-3.5" />
                Remote
              </button>
            </>
          )}
        </div>
      </header>

      {/* INCOMING CALL BANNER */}
      {incomingCall && (
        <div className="bg-blue-600 text-white px-4 py-2 flex items-center justify-between shadow-lg animate-in slide-in-from-top duration-300">
          <div className="flex items-center gap-3">
            <Share2 className="w-4 h-4 animate-pulse" />
            <span className="text-xs font-bold">Incoming WebRTC Call from <span className="font-mono">{incomingCall.fromId}</span></span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={incomingCall.reject}
              className="px-3 py-1 text-[10px] uppercase font-bold hover:bg-black/10 rounded"
            >
              Ignore
            </button>
            <button
              onClick={async () => {
                const callerId = incomingCall.fromId;
                await incomingCall.accept();
                // Auto-share the currently active tab with this caller (AnyDesk Style)
                if (activeTabId && !activeTabId.startsWith('remote-')) {
                   // Dispatch an event to the active Workspace to perform the share + sync
                   window.dispatchEvent(new CustomEvent('trigger-tab-share', { 
                     detail: { tabId: activeTabId, peerId: callerId } 
                   }));
                   console.log(`[Auto-Share] Triggered share for ${activeTabId} to ${callerId}`);
                }
              }}
              className="bg-white text-blue-600 px-4 py-1 rounded shadow-md text-[10px] font-bold uppercase transition-transform active:scale-95"
            >
              Accept
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-h-0 bg-background relative">
        {/* Remote Status Indicator (Visible when sharing or connected) */}
        {(isSharing || Object.keys(activePeers).length > 0) && (
          <div className="bg-blue-600/10 border-b border-blue-500/20 px-3 py-1 flex items-center justify-between animate-in slide-in-from-top duration-300">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isSharing ? 'bg-green-500 animate-pulse' : 'bg-zinc-500'}`} />
              <span className="text-[10px] font-bold uppercase tracking-tight text-blue-500">
                {isSharing ? `Hosting: ${deviceName || 'Unnamed'}` : 'Remote Engine Standby'}
              </span>
              {Object.keys(activePeers).length > 0 && (
                <div className="flex items-center gap-1.5 ml-3 pl-3 border-l border-blue-500/20">
                  <span className="text-[10px] bg-blue-500 text-white px-1.5 py-0.5 rounded-full font-bold">
                    {Object.keys(activePeers).length} PEERS
                  </span>
                  <span className="text-[9px] text-blue-500/70 font-mono">
                    {Object.keys(activePeers).map(p => p.slice(0, 11)).join(', ')}
                  </span>
                </div>
              )}
            </div>
            <button
              onClick={() => setShowRemoteDialog(true)}
              className="text-[9px] font-bold text-blue-500 hover:text-blue-400 uppercase flex items-center gap-1 transition-colors"
            >
              <Users className="w-3 h-3" />
              Manage Hub
            </button>
          </div>
        )}

        {tabs.map(tab => (
          <Workspace
            key={tab.id}
            tabId={tab.id}
            isActive={activeTabId === tab.id}
            darkMode={darkMode}
            onConnectionStatusChange={updateTabConn}
            onProjectNameChange={updateTabName}
            autoScroll={autoScroll}
            setAutoScroll={setAutoScroll}
            remoteChannel={tab.remoteChannel}
            peerId={tab.peerId}
            activePeers={activePeers}
          />
        ))}
      </main>

      <LicenseDialog isOpen={showLicenseDialog} onClose={() => setShowLicenseDialog(false)} />
      <RemoteAccessDialog isOpen={showRemoteDialog} onClose={() => setShowRemoteDialog(false)} activeTabId={activeTabId} />
    </div>
  );
}

export default function AppWithLicense() {
  return <LicenseProvider><App /></LicenseProvider>;
}
