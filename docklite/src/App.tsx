import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { Terminal, LogEntry } from "./components/Terminal";
import { SequenceEditor } from "./components/SequenceEditor";
import { ReactionEditor } from "./components/ReactionEditor";
import { LicenseDialog } from "./components/LicenseDialog";
import { LicenseProvider } from "./contexts/LicenseContext";
import { Project, Sequence, Reaction, PortInfo } from "./types";
import { parseData } from "./utils";
import { RotateCw, Settings, Moon, Sun, ChevronDown, Crown, LineChart as LineChartIcon } from "lucide-react";
import logo from "./assets/logo.png";
import "./index.css";
import { ChartWindow } from "./components/ChartWindow";
import { ChartConfig, ChartDataPoint, extractValue } from "./chart_utils";

function App() {
  const [project, setProject] = useState<Project>({
    name: "Plan Terminal",
    send_sequences: [],
    reactions: [],
    serial_config: undefined
  });

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const incomingQueue = useRef<{ bytes: number[], ts: number, dir: string }[]>([]);
  const lastRef = useRef<{ id: string, timestamp: number, direction: string } | null>(null);
  const [connected, setConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [editingSeq, setEditingSeq] = useState<Sequence | null>(null);
  const [editingReaction, setEditingReaction] = useState<Reaction | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(320);

  // Chart State
  const [isChartOpen, setIsChartOpen] = useState(false);
  const [chartConfigs, setChartConfigs] = useState<ChartConfig[]>([]);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);

  // Refs for Chart to access latest state in listeners
  const chartConfigsRef = useRef<ChartConfig[]>([]);
  const chartDataQueue = useRef<ChartDataPoint[]>([]);

  // Update refs when state changes
  useEffect(() => {
    chartConfigsRef.current = chartConfigs;
  }, [chartConfigs]);

  // Port selection state (lifted to header)
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [baudRate, setBaudRate] = useState(9600);

  // Advanced serial config
  const [dataBits, setDataBits] = useState(8);
  const [parity, setParity] = useState("None");
  const [stopBits, setStopBits] = useState(1);
  const [flowControl, setFlowControl] = useState("None");
  const [showSettings, setShowSettings] = useState(false);
  const [showLicenseDialog, setShowLicenseDialog] = useState(false);

  // Dark mode
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('darkMode');
    return saved ? saved === 'true' : true; // Default to dark
  });

  useEffect(() => {
    localStorage.setItem('darkMode', String(darkMode));
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  const refreshPorts = async () => {
    try {
      const list = await invoke<PortInfo[]>("list_serial_ports");
      setPorts(list);
      if (list.length > 0 && !selectedPort) {
        setSelectedPort(list[0].port_name);
      }
    } catch (e) {
      console.error("Failed to list ports", e);
    }
  };

  useEffect(() => {
    refreshPorts();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      // 1. Process Logs
      if (incomingQueue.current.length > 0) {
        const batch = [...incomingQueue.current];
        incomingQueue.current = [];

        setLogs(prev => {
          if (batch.length === 0) return prev;
          let next = [...prev];
          const gap = Number(localStorage.getItem('terminal-ts-gap') || '100');

          for (const item of batch) {
            const last = lastRef.current;
            if (last && next.length > 0 && next[next.length - 1].id === last.id &&
              last.direction === item.dir && (item.ts - last.timestamp) < gap) {
              const lastIdx = next.length - 1;
              next[lastIdx] = { ...next[lastIdx], data: [...next[lastIdx].data, ...item.bytes] };
            } else {
              const id = Math.random().toString(36).substr(2, 9);
              lastRef.current = { id, timestamp: item.ts, direction: item.dir };
              next.push({ id, timestamp: item.ts, direction: item.dir as any, data: item.bytes });
            }
          }
          return next.slice(-10000);
        });
      }

      // 2. Process Chart Data (Throttled update)
      if (chartDataQueue.current.length > 0) {
        const newPoints = [...chartDataQueue.current];
        chartDataQueue.current = [];

        setChartData(prev => {
          // Keep last 100 points for performance
          const combined = [...prev, ...newPoints];
          return combined.slice(-100);
        });
      }

    }, 32); // 30fps

    return () => clearInterval(interval);
  }, []);

  const [connectionType, setConnectionType] = useState<'Serial' | 'TCP' | 'SSH'>('Serial');
  const [tcpHost, setTcpHost] = useState('192.168.1.100');
  const [tcpPort, setTcpPort] = useState(8080);
  const [sshHost, setSshHost] = useState('192.168.1.100');
  const [sshPort, setSshPort] = useState(22);
  const [sshUsername, setSshUsername] = useState('pi');
  const [sshPassword, setSshPassword] = useState('');

  // Update connection fields when project loads (e.g. from .plant files)
  useEffect(() => {
    if (project.serial_config) {
      setConnectionType('Serial');
      // Serial is handled by separate logic or is already mostly in place...
    } else if (project.tcp_config) {
      setConnectionType('TCP');
      setTcpHost(project.tcp_config.host);
      setTcpPort(project.tcp_config.port);
    } else if (project.ssh_config) {
      setConnectionType('SSH');
      setSshHost(project.ssh_config.host);
      setSshPort(project.ssh_config.port);
      setSshUsername(project.ssh_config.username);
      // Password is not saved.
    }
  }, [project]);

  useEffect(() => {
    // Listen for incoming data (both Serial and TCP emit this)
    const unlistenData = listen<any>('serial-data', (event) => {
      const payload = event.payload;
      let bytes: number[] = [];
      let ts = Date.now();
      let dir = "RX";

      if (Array.isArray(payload)) {
        bytes = payload[0];
        ts = payload[1];
        dir = payload[2] || "RX";
      } else if (payload && typeof payload === 'object') {
        bytes = payload.data || payload.bytes || [];
        ts = payload.ts || payload.timestamp || Date.now();
        dir = payload.direction || payload.dir || "RX";
      }

      incomingQueue.current.push({ bytes, ts, dir });

      // Chart Processing
      if (dir === "RX" && chartConfigsRef.current.length > 0) {
        const line = String.fromCharCode(...bytes);
        let hasData = false;
        const point: ChartDataPoint = { timestamp: ts };

        chartConfigsRef.current.forEach(cfg => {
          if (cfg.enabled) {
            const val = extractValue(line, cfg);
            if (val !== null) {
              point[cfg.name] = val;
              hasData = true;
            }
          }
        });

        if (hasData) {
          chartDataQueue.current.push(point);
        }
      }
    });

    // Listen for unexpected TCP disconnects
    const unlistenTcpDisconnect = listen('tcp-disconnected', () => {
      setConnected(false);
      alert("TCP Connection closed by remote host or error occurred.");
    });

    const unlistenSshDisconnect = listen('ssh-disconnected', () => {
      setConnected(false);
      alert("SSH Connection closed.");
    });

    return () => {
      unlistenData.then(f => f());
      unlistenTcpDisconnect.then(f => f());
      unlistenSshDisconnect.then(f => f());
    };
  }, []);

  // Periodic Intervals logic ...
  // Track active periodic intervals (by sequence ID)
  const periodicIntervalsRef = useRef<Map<string, number>>(new Map());

  // Track which sequences are ACTIVELY running (separate from periodic_enabled config)
  const [activePeriodicIds, setActivePeriodicIds] = useState<Set<string>>(new Set());

  // Start periodic sending for a sequence
  const startPeriodic = (seqId: string) => {
    setActivePeriodicIds(prev => new Set(prev).add(seqId));
  };

  // Stop periodic sending for a sequence  
  const stopPeriodic = (seqId: string) => {
    setActivePeriodicIds(prev => {
      const next = new Set(prev);
      next.delete(seqId);
      return next;
    });
  };

  // Periodic send management - only runs for sequences in activePeriodicIds
  useEffect(() => {
    const activeIntervals = periodicIntervalsRef.current;

    // Start intervals for sequences that are in activePeriodicIds
    project.send_sequences.forEach(seq => {
      if (activePeriodicIds.has(seq.id) && connected && !activeIntervals.has(seq.id)) {
        const interval = window.setInterval(async () => {
          const bytes = parseData(seq.data, seq.view_mode);
          try {
            if (connectionType === 'Serial') {
              await invoke("send_serial_data", { data: bytes });
            } else if (connectionType === 'TCP') {
              await invoke("send_tcp_data", { data: bytes });
            } else if (connectionType === 'SSH') {
              await invoke("send_ssh_data", { data: bytes });
            }
            incomingQueue.current.push({ bytes, ts: Date.now(), dir: "TX" });
          } catch (e) {
            console.error("Periodic send failed:", e);
          }
        }, seq.periodic_interval || 1000);
        activeIntervals.set(seq.id, interval);
      }
    });

    // Stop intervals for sequences not in activePeriodicIds or disconnected
    activeIntervals.forEach((interval, seqId) => {
      if (!activePeriodicIds.has(seqId) || !connected) {
        clearInterval(interval);
        activeIntervals.delete(seqId);
      }
    });

    return () => {
      // Cleanup all on unmount
      activeIntervals.forEach(interval => clearInterval(interval));
    };
  }, [project.send_sequences, connected, activePeriodicIds, connectionType]);


  const handleSend = async (seq: Sequence) => {
    let bytes: number[] = parseData(seq.data, seq.view_mode);

    try {
      if (connectionType === 'Serial') {
        await invoke("send_serial_data", { data: bytes });
      } else if (connectionType === 'TCP') {
        await invoke("send_tcp_data", { data: bytes });
      } else if (connectionType === 'SSH') {
        await invoke("send_ssh_data", { data: bytes });
      }
      incomingQueue.current.push({ bytes, ts: Date.now(), dir: "TX" });
    } catch (e) {
      console.error(e);
      alert("Failed to send: " + e);
    }
  };

  const handleConnect = async () => {
    try {
      setIsConnecting(true);
      if (connectionType === 'Serial') {
        await invoke("open_serial_port", {
          portName: selectedPort,
          baudRate,
          dataBits,
          flowControl,
          parity,
          stopBits
        });
      } else if (connectionType === 'TCP') {
        await invoke("connect_tcp", {
          host: tcpHost,
          port: tcpPort
        });
      } else if (connectionType === 'SSH') {
        await invoke("connect_ssh", {
          host: sshHost,
          port: sshPort,
          user: sshUsername,
          pass: sshPassword
        });
      }
      setConnected(true);
    } catch (e) {
      alert("Connection failed: " + e);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      if (connectionType === 'Serial') {
        await invoke("close_serial_port");
      } else if (connectionType === 'TCP') {
        await invoke("disconnect_tcp");
      } else if (connectionType === 'SSH') {
        await invoke("disconnect_ssh");
      }
      setConnected(false);
    } catch (e) {
      console.error(e);
    }
  };

  const updateSequence = (updated: Sequence) => {
    const newSeqs = project.send_sequences.map(s => s.id === updated.id ? updated : s);
    setProject({ ...project, send_sequences: newSeqs });
    setEditingSeq(null);
  };

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden">
      <header className="px-3 py-2 border-b flex justify-between items-center bg-card shadow-sm shrink-0">
        <div className="flex items-center gap-3">
          <img src={logo} alt="Plan Terminal" className="w-7 h-7" />
          <h1 className="text-lg font-bold">Plan Terminal</h1>
          {project.name !== "Plan Terminal" && (
            <span className="text-xs px-2 py-0.5 bg-muted rounded text-muted-foreground">{project.name}</span>
          )}

          {/* Dark Mode Toggle */}
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="p-1.5 hover:bg-accent rounded"
            title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* License/Pro Button */}
          <button
            onClick={() => setShowLicenseDialog(true)}
            className="p-1.5 hover:bg-accent rounded"
            title="License & Pro Features"
          >
            <Crown className="w-4 h-4" />
          </button>

          {/* Chart Toggle Button */}
          <button
            onClick={() => setIsChartOpen(!isChartOpen)}
            className={`p-1.5 rounded transition-colors ${isChartOpen ? 'bg-blue-600 text-white' : 'hover:bg-accent'}`}
            title="Toggle Real-Time Chart"
          >
            <LineChartIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Connection Settings */}
        <div className="flex items-center gap-2">
          {/* Connection Type */}
          <div className="relative">
            <select
              className="rounded px-2 py-1 text-sm focus:ring-1 focus:ring-zinc-500 outline-none cursor-pointer appearance-none pr-8 font-semibold"
              style={{
                backgroundColor: darkMode ? 'transparent' : 'hsl(var(--secondary))',
                color: 'hsl(var(--foreground))',
                border: '1px solid hsl(var(--border))',
                colorScheme: darkMode ? 'dark' : 'light'
              }}
              value={connectionType}
              onChange={(e) => setConnectionType(e.target.value as 'Serial' | 'TCP' | 'SSH')}
              disabled={connected}
            >
              <option value="Serial">Serial</option>
              <option value="TCP">TCP</option>
              <option value="SSH">SSH</option>
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none opacity-50" style={{ color: 'hsl(var(--foreground))' }} />
          </div>

          <div className="w-[1px] h-6 bg-border mx-1" />

          {connectionType === 'Serial' ? (
            <>
              <button
                onClick={refreshPorts}
                className="p-1.5 rounded transition-colors"
                style={{
                  backgroundColor: darkMode ? 'transparent' : 'hsl(var(--secondary))',
                  color: 'hsl(var(--foreground))',
                  cursor: 'pointer'
                }}
                title="Refresh Ports"
              >
                <RotateCw className="w-4 h-4" />
              </button>
              <div className="relative">
                <select
                  className="rounded px-2 py-1 text-sm min-w-[120px] focus:ring-1 focus:ring-zinc-500 outline-none cursor-pointer appearance-none pr-8"
                  style={{
                    backgroundColor: 'hsl(var(--background))',
                    color: 'hsl(var(--foreground))',
                    borderColor: 'hsl(var(--border))',
                    borderWidth: '1px',
                    colorScheme: darkMode ? 'dark' : 'light'
                  }}
                  value={selectedPort}
                  onChange={e => setSelectedPort(e.target.value)}
                  disabled={connected}
                >
                  {ports.length === 0 && <option value="">No ports</option>}
                  {ports.map(p => (
                    <option key={p.port_name} value={p.port_name}>{p.port_name}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none opacity-50" style={{ color: 'hsl(var(--foreground))' }} />
              </div>

              <div className="relative">
                <select
                  className="rounded px-2 py-1 text-sm w-24 focus:ring-1 focus:ring-zinc-500 outline-none cursor-pointer appearance-none pr-8"
                  style={{
                    backgroundColor: 'hsl(var(--background))',
                    color: 'hsl(var(--foreground))',
                    borderColor: 'hsl(var(--border))',
                    borderWidth: '1px',
                    colorScheme: darkMode ? 'dark' : 'light'
                  }}
                  value={baudRate}
                  onChange={e => setBaudRate(Number(e.target.value))}
                  disabled={connected}
                >
                  {[300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(b => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none opacity-50" style={{ color: 'hsl(var(--foreground))' }} />
              </div>

              {/* Settings Button */}
              <div className="relative">
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="px-2 py-1 text-xs rounded flex items-center gap-1 transition-colors cursor-pointer"
                  style={{
                    backgroundColor: 'hsl(var(--background))',
                    color: 'hsl(var(--foreground))',
                    borderColor: 'hsl(var(--border))',
                    borderWidth: '1px'
                  }}
                  title="Advanced Settings"
                >
                  <Settings className="w-3.5 h-3.5" />
                  More
                </button>


                {/* Settings Popup */}
                {showSettings && (
                  <div
                    className="absolute right-0 top-full mt-1 border rounded-lg shadow-lg p-4 z-50 min-w-[280px]"
                    style={{
                      backgroundColor: 'hsl(var(--popover))',
                      borderColor: 'hsl(var(--border))',
                      color: 'hsl(var(--popover-foreground))'
                    }}>
                    <h4 className="font-semibold mb-3">Serial Settings</h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs block mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Data Bits</label>
                        <div className="relative">
                          <select
                            className="w-full rounded px-2 py-1 text-sm outline-none border cursor-pointer appearance-none pr-8"
                            style={{
                              backgroundColor: 'hsl(var(--background))',
                              borderColor: 'hsl(var(--border))',
                              color: 'hsl(var(--foreground))',
                              colorScheme: darkMode ? 'dark' : 'light'
                            }}
                            value={dataBits} onChange={e => setDataBits(Number(e.target.value))} disabled={connected}>
                            {[5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none opacity-50" style={{ color: 'hsl(var(--foreground))' }} />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs block mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Stop Bits</label>
                        <div className="relative">
                          <select
                            className="w-full rounded px-2 py-1 text-sm outline-none border cursor-pointer appearance-none pr-8"
                            style={{
                              backgroundColor: 'hsl(var(--background))',
                              borderColor: 'hsl(var(--border))',
                              color: 'hsl(var(--foreground))',
                              colorScheme: darkMode ? 'dark' : 'light'
                            }}
                            value={stopBits} onChange={e => setStopBits(Number(e.target.value))} disabled={connected}>
                            {[1, 2].map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none opacity-50" style={{ color: 'hsl(var(--foreground))' }} />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs block mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Parity</label>
                        <div className="relative">
                          <select
                            className="w-full rounded px-2 py-1 text-sm outline-none border cursor-pointer appearance-none pr-8"
                            style={{
                              backgroundColor: 'hsl(var(--background))',
                              borderColor: 'hsl(var(--border))',
                              color: 'hsl(var(--foreground))',
                              colorScheme: darkMode ? 'dark' : 'light'
                            }}
                            value={parity} onChange={e => setParity(e.target.value)} disabled={connected}>
                            {["None", "Odd", "Even"].map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none opacity-50" style={{ color: 'hsl(var(--foreground))' }} />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs block mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Flow Control</label>
                        <div className="relative">
                          <select
                            className="w-full rounded px-2 py-1 text-sm outline-none border cursor-pointer appearance-none pr-8"
                            style={{
                              backgroundColor: 'hsl(var(--background))',
                              borderColor: 'hsl(var(--border))',
                              color: 'hsl(var(--foreground))',
                              colorScheme: darkMode ? 'dark' : 'light'
                            }}
                            value={flowControl} onChange={e => setFlowControl(e.target.value)} disabled={connected}>
                            {["None", "Software", "Hardware"].map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none opacity-50" style={{ color: 'hsl(var(--foreground))' }} />
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowSettings(false)}
                      className="mt-3 w-full bg-secondary hover:bg-secondary/80 rounded py-1 text-sm"
                    >
                      Close
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : connectionType === 'TCP' ? (
            <>
              <input
                type="text"
                className="w-32 rounded px-2 py-1 text-sm outline-none border focus:ring-1 focus:ring-zinc-500"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                placeholder="192.168.1.100"
                value={tcpHost}
                onChange={(e) => setTcpHost(e.target.value)}
                disabled={connected}
              />
              <span className="text-zinc-500 font-bold">:</span>
              <input
                type="number"
                className="w-20 rounded px-2 py-1 text-sm outline-none border focus:ring-1 focus:ring-zinc-500 no-spinner"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                placeholder="8080"
                value={tcpPort}
                onChange={(e) => setTcpPort(Number(e.target.value))}
                disabled={connected}
              />
            </>
          ) : (
            <>
              <input
                type="text"
                className="w-32 rounded px-2 py-1 text-sm outline-none border focus:ring-1 focus:ring-zinc-500"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                placeholder="pi@192.168.1.100"
                title="SSH Username"
                value={sshUsername}
                onChange={(e) => setSshUsername(e.target.value)}
                disabled={connected}
              />
              <span className="text-zinc-500 font-bold">@</span>
              <input
                type="text"
                className="w-32 rounded px-2 py-1 text-sm outline-none border focus:ring-1 focus:ring-zinc-500"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                placeholder="Host"
                title="SSH Host URL or IP"
                value={sshHost}
                onChange={(e) => setSshHost(e.target.value)}
                disabled={connected}
              />
              <span className="text-zinc-500 font-bold">:</span>
              <input
                type="number"
                className="w-16 rounded px-2 py-1 text-sm outline-none border focus:ring-1 focus:ring-zinc-500 no-spinner"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                placeholder="22"
                title="SSH Port"
                value={sshPort}
                onChange={(e) => setSshPort(Number(e.target.value))}
                disabled={connected}
              />
              <span className="text-zinc-500 font-bold"></span>
              <input
                type="password"
                className="w-28 rounded px-2 py-1 text-sm outline-none border focus:ring-1 focus:ring-zinc-500"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                placeholder="Password"
                title="SSH Password (not saved to .plant)"
                value={sshPassword}
                onChange={(e) => setSshPassword(e.target.value)}
                disabled={connected}
              />
            </>
          )}

          {!connected ? (
            <button
              className={`text-white rounded px-3 py-1 text-sm font-medium ${isConnecting ? 'bg-zinc-600 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'}`}
              onClick={handleConnect}
              disabled={isConnecting || (connectionType === 'Serial' && !selectedPort)}
            >
              {isConnecting ? 'Connecting...' : 'Connect'}
            </button>
          ) : (
            <button
              className="bg-red-600 hover:bg-red-700 text-white rounded px-3 py-1 text-sm font-medium"
              onClick={handleDisconnect}
            >
              Disconnect
            </button>
          )}

          <div className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
        </div>
      </header>

      <main className="flex-1 p-2 overflow-hidden">
        <div className="flex h-full gap-0">
          {/* Resizable Sidebar */}
          <div
            className="border rounded-lg p-2 bg-card overflow-hidden shrink-0"
            style={{ width: sidebarWidth, minWidth: 200, maxWidth: 600 }}
          >
            <ProjectSidebar
              project={{
                ...project,
                tcp_config: connectionType === 'TCP' ? { host: tcpHost, port: tcpPort } : undefined,
                ssh_config: connectionType === 'SSH' ? { host: sshHost, port: sshPort, username: sshUsername } : undefined,
              }}
              onUpdate={setProject}
              onSend={handleSend}
              onEditSequence={setEditingSeq}
              onEditReaction={setEditingReaction}
              connected={connected}
              activePeriodicIds={activePeriodicIds}
              onStartPeriodic={startPeriodic}
              onStopPeriodic={stopPeriodic}
            />
          </div>

          {/* Resize Handle */}
          <div
            className="w-2 cursor-col-resize flex items-center justify-center hover:bg-primary/20 transition-colors"
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startWidth = sidebarWidth;
              const onMouseMove = (moveEvent: MouseEvent) => {
                const delta = moveEvent.clientX - startX;
                const newWidth = Math.max(200, Math.min(600, startWidth + delta));
                setSidebarWidth(newWidth);
              };
              const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
              };
              document.addEventListener('mousemove', onMouseMove);
              document.addEventListener('mouseup', onMouseUp);
            }}
          >
            <div className="w-1 h-8 bg-border rounded-full" />
          </div>

          {/* Main Terminal */}
          <div className="flex-1 h-full overflow-hidden">
            {/* Chart Window Overlay */}
            <ChartWindow
              isOpen={isChartOpen}
              onClose={() => setIsChartOpen(false)}
              data={chartData}
              configs={chartConfigs}
              onConfigChange={setChartConfigs}
              onClearData={() => setChartData([])}
            />

            <Terminal
              logs={logs}
              onClear={() => setLogs([])}
              onSendCommand={connectionType === 'SSH' ? async (cmd) => {
                try {
                  const bytes = Array.from(new TextEncoder().encode(cmd));
                  await invoke("send_ssh_data", { data: bytes });
                  // We don't push to incomingQueue directly here, because SSH usually echoes back
                  // what you type via the read channel itself. If we find it feels disconnected, we
                  // can add an artificial local echo later.
                } catch (e) {
                  console.error("Failed to send SSH command:", e);
                }
              } : undefined}
            />
          </div>
        </div>
      </main>

      {/* Modals */}
      {editingSeq && (
        <SequenceEditor
          sequence={editingSeq}
          isOpen={true}
          onClose={() => setEditingSeq(null)}
          onSave={updateSequence}
          onDelete={(seq) => {
            const newSeqs = project.send_sequences.filter(s => s.id !== seq.id);
            setProject({ ...project, send_sequences: newSeqs });
          }}
          onSend={handleSend}
        />
      )}
      {editingReaction && (
        <ReactionEditor
          reaction={editingReaction}
          sequences={project.send_sequences}
          isOpen={true}
          onClose={() => setEditingReaction(null)}
          onSave={(updated) => {
            const newReactions = project.reactions.map(r => r.id === updated.id ? updated : r);
            setProject({ ...project, reactions: newReactions });
            setEditingReaction(null);
          }}
        />
      )}

      {/* License Dialog */}
      <LicenseDialog
        isOpen={showLicenseDialog}
        onClose={() => setShowLicenseDialog(false)}
      />
    </div>
  );
}

// Wrap App with LicenseProvider
function AppWithLicense() {
  return (
    <LicenseProvider>
      <App />
    </LicenseProvider>
  );
}

export default AppWithLicense;
