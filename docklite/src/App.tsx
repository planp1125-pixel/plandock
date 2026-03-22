import { useState, useEffect } from "react";
import { Workspace } from "./components/Workspace";
import { LicenseDialog } from "./components/LicenseDialog";
import { LicenseProvider } from "./contexts/LicenseContext";
import { Moon, Sun, Crown, X, Plus } from "lucide-react";
import logo from "./assets/logo.png";
import "./index.css";

interface Tab {
  id: string;
  name: string;
  connected: boolean;
  connLabel: string;
}

function App() {
  const [tabs, setTabs] = useState<Tab[]>([{ id: 'main', name: 'New Project', connected: false, connLabel: '' }]);
  const [activeTabId, setActiveTabId] = useState('main');

  const [showLicenseDialog, setShowLicenseDialog] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('darkMode');
    return saved ? saved === 'true' : true;
  });

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
    setTabs([...tabs, { id, name: 'New Project', connected: false, connLabel: '' }]);
    setActiveTabId(id);
  };

  const closeTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (tabs.length === 1) return;
    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);
    if (activeTabId === id) setActiveTabId(newTabs[newTabs.length - 1].id);
  };

  const updateTabConn = (id: string, connected: boolean, label: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, connected, connLabel: label } : t));
  };

  const updateTabName = (id: string, name: string) => {
    setTabs(prev => prev.map(t => t.id === id && t.name !== name ? { ...t, name } : t));
  };

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden">
      {/* GLOBAL HEADER */}
      <header className="px-3 py-0 border-b flex justify-between items-center bg-card shadow-sm shrink-0 h-10">
        <div className="flex items-center flex-1 overflow-x-auto h-full pr-4">
          <div className="flex items-center gap-2 mr-4 shrink-0 pl-1">
            <img src={logo} alt="Plan Terminal" className="w-5 h-5 pointer-events-none" />
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
            <button
              type="button"
              className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 outline-none focus:outline-none focus:ring-0"
              onClick={addTab}
              title="New Tab"
            >
              <Plus className="w-4 h-4 pointer-events-none" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button onClick={toggleDarkMode} className="p-1.5 hover:bg-accent rounded outline-none" title="Toggle Theme">
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <button onClick={() => setShowLicenseDialog(true)} className="p-1.5 hover:bg-accent rounded text-amber-500 outline-none" title="License Pro">
            <Crown className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* WORKSPACES */}
      <main className="flex-1 relative overflow-hidden bg-background">
        {tabs.map(tab => (
          <Workspace
            key={tab.id}
            tabId={tab.id}
            isActive={activeTabId === tab.id}
            darkMode={darkMode}
            onConnectionStatusChange={updateTabConn}
            onProjectNameChange={updateTabName}
          />
        ))}
      </main>

      <LicenseDialog isOpen={showLicenseDialog} onClose={() => setShowLicenseDialog(false)} />
    </div>
  );
}

export default function AppWithLicense() {
  return <LicenseProvider><App /></LicenseProvider>;
}
