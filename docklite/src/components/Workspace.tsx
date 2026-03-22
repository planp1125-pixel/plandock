import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ProjectSidebar } from "./ProjectSidebar";
import { Terminal, LogEntry } from "./Terminal";
import { SequenceEditor } from "./SequenceEditor";
import { ReactionEditor } from "./ReactionEditor";
import { Project, Sequence, Reaction, PortInfo } from "../types";
import { parseData } from "../utils";
import { RotateCw, Settings, ChevronDown, LineChart as LineChartIcon, Download, FileText } from "lucide-react";
import { ChartWindow } from "./ChartWindow";
import { ChartConfig, ChartDataPoint, extractValue } from "../chart_utils";
import { useLicense, FREE_LIMITS } from "../contexts/LicenseContext";
import { handleTerminalExport } from "../utils/export";

export function Workspace({ tabId, isActive, darkMode, onConnectionStatusChange, onProjectNameChange }: { tabId: string, isActive: boolean, darkMode: boolean, onConnectionStatusChange: (tabId: string, isConnected: boolean, label: string) => void, onProjectNameChange: (tabId: string, name: string) => void }) {
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
  const [activeProtocol, setActiveProtocol] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [editingSeq, setEditingSeq] = useState<Sequence | null>(null);
  const [editingReaction, setEditingReaction] = useState<Reaction | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [isRecording, setIsRecording] = useState(false);

  // File Logging and Export State
  const { isPro } = useLicense();
  const [exportAscii, setExportAscii] = useState(false);
  const [exportHex, setExportHex] = useState(false);
  const [exportBin, setExportBin] = useState(false);
  const [exportDec, setExportDec] = useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [showLogOptions, setShowLogOptions] = useState(false);
  const [isLiveLogging, setIsLiveLogging] = useState(false);
  const lastLoggedIndexRef = useRef(0);

  // Chart State
  const [isChartOpen, setIsChartOpen] = useState(false);
  const [chartConfigs, setChartConfigs] = useState<ChartConfig[]>([]);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);

  // Refs for Chart to access latest state in listeners
  const chartConfigsRef = useRef<ChartConfig[]>([]);
  const chartDataQueue = useRef<ChartDataPoint[]>([]);

  // Playback State
  const [isPlayingBack, setIsPlayingBack] = useState(false);
  const [isPlaybackPaused, setIsPlaybackPaused] = useState(false);

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


  // Dark mode


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

  const handleToggleRecord = async () => {
    if (isRecording) {
      await invoke("stop_logging", { tabId, connType: connectionType });
      setIsRecording(false);
    } else {
      const selectedPath = await save({
        filters: [{ name: 'Plan Terminal Session', extensions: ['plog'] }],
        title: 'Save Session Recording (.plog)',
        defaultPath: `session_${Date.now()}.plog`
      });
      if (selectedPath) {
        try {
          await invoke("start_logging", { tabId, path: selectedPath, connType: connectionType });
          setIsRecording(true);
        } catch (e) {
          alert("Failed to start recording: " + String(e));
        }
      }
    }
  };

  const handlePlayRecording = async () => {
    const selectedPath = await open({
      filters: [{ name: 'Plan Terminal Session', extensions: ['plog'] }],
      title: 'Open Session Recording (.plog)',
      multiple: false
    });

    if (selectedPath && typeof selectedPath === 'string') {
      try {
        setIsPlaybackPaused(false);
        await invoke("play_recording", { tabId, path: selectedPath, speedMultiplier: 1.0 });
      } catch (e) {
        alert("Playback failed: " + String(e));
      }
    }
  };

  const handlePausePlayback = async () => {
    if (isPlaybackPaused) {
      await invoke("resume_recording", { tabId });
      setIsPlaybackPaused(false);
    } else {
      await invoke("pause_recording", { tabId });
      setIsPlaybackPaused(true);
    }
  };

  const handleStopPlayback = async () => {
    await invoke("stop_recording", { tabId });
    setIsPlayingBack(false);
    setIsPlaybackPaused(false);
  };

  const handleStartLiveLogging = async () => {
    try {
      const path = await save({
        filters: [{ name: 'Log Files', extensions: ['log', 'txt'] }],
        defaultPath: `plan_terminal_${Date.now()}.log`
      });
      if (path) {
        const format = exportAscii ? 'ascii' : exportHex ? 'hex' : 'both';
        await invoke('start_logging', { tabId, path, connType: activeProtocol, format });
        lastLoggedIndexRef.current = logs.length;
        setIsLiveLogging(true);
        setShowLogOptions(false);
      }
    } catch (error) {
      console.error(error);
      alert("Failed to start logging: " + String(error));
    }
  };

  const handleStopLiveLogging = async () => {
    try {
      await invoke('stop_logging', { tabId, connType: activeProtocol });
    } catch (e) {
      console.error(e);
    }
    setIsLiveLogging(false);
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
  const [sshAuthMode, setSshAuthMode] = useState<'password' | 'private_key'>('password');
  const [sshAuthSecret, setSshAuthSecret] = useState('');

  // Update connection fields when project loads (e.g. from .plant files)
  useEffect(() => {
    if (project.connection_type) {
      setConnectionType(project.connection_type);
    } else if (project.serial_config) {
      setConnectionType('Serial');
    } else if (project.tcp_config) {
      setConnectionType('TCP');
    } else if (project.ssh_config) {
      setConnectionType('SSH');
    }

    if (project.tcp_config) {
      setTcpHost(project.tcp_config.host);
      setTcpPort(project.tcp_config.port);
    }
    if (project.ssh_config) {
      setSshHost(project.ssh_config.host);
      setSshPort(project.ssh_config.port);
      setSshUsername(project.ssh_config.username);
      // Password is not saved.
    }
  }, [project]);

  // Synchronize Reactions Array to Rust Backend
  useEffect(() => {
    const mappedReactions = project.reactions.filter((r: Reaction) => r.enabled).map((r: Reaction) => {
      let triggerBytes = parseData(r.trigger_data, r.view_mode as "Ascii" | "Hex");

      let responseBytes: number[] = [];
      const seq = project.send_sequences.find((s: Sequence) => s.id === r.response_sequence_id);
      if (seq && seq.data) {
        responseBytes = parseData(seq.data, seq.view_mode as "Ascii" | "Hex" | "Binary" | "Decimal");
      }

      // Safeguard against NaN from bad hex typing
      triggerBytes = triggerBytes.filter((n: number) => !isNaN(n));
      responseBytes = responseBytes.filter(n => !isNaN(n));

      return { trigger_data: triggerBytes, response_data: responseBytes };
    });

    invoke("set_reactions", { tabId, newReactions: mappedReactions }).catch(e =>
      console.error("Failed to sync reactions to backend:", e)
    );
  }, [project.reactions, project.send_sequences]);

  useEffect(() => {
    // Listen for incoming data (both Serial and TCP emit this)
    const unlistenData = listen<any>('serial-data', (event) => {
      const payload = event.payload;
      if (!Array.isArray(payload) || payload[0] !== tabId) return;
      let bytes = payload[1];
      let ts = payload[2];
      let dir = payload[3] || "RX";
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
    const unlistenTcpDisconnect = listen<string>('tcp-disconnected', (event) => {
      if (event.payload !== tabId) return;
      setConnected(false); onConnectionStatusChange(tabId, false, '');
      alert("TCP Connection closed by remote host or error occurred.");
    });

    const unlistenSshDisconnect = listen<string>('ssh-disconnected', (event) => {
      if (event.payload !== tabId) return;
      setConnected(false); onConnectionStatusChange(tabId, false, '');
      alert("SSH Connection closed.");
    });

    const unlistenPlaybackStart = listen<string>('playback-started', (event) => {
      if (event.payload !== tabId) return;
      setLogs([]); // Wipes terminal log completely to prepare for incoming stream
      setChartData([]);
      incomingQueue.current = [];
      lastRef.current = null;
      setIsPlayingBack(true);
    });

    const unlistenPlaybackEnded = listen<string>('playback-ended', (event) => {
      if (event.payload !== tabId) return;
      setIsPlayingBack(false);
      setIsPlaybackPaused(false);
    });

    return () => {
      unlistenData.then(f => f());
      unlistenTcpDisconnect.then(f => f());
      unlistenSshDisconnect.then(f => f());
      unlistenPlaybackStart.then(f => f());
      unlistenPlaybackEnded.then(f => f());
    };
  }, []);

  // Periodic Intervals — handled entirely by native Rust OS threads, no setInterval
  const [activePeriodicIds, setActivePeriodicIds] = useState<Set<string>>(new Set());

  const startPeriodic = (seq: Sequence) => {
    const bytes = parseData(seq.data, seq.view_mode);
    invoke("start_periodic_sequence", {
      tabId,
      seqId: seq.id,
      data: bytes,
      intervalMs: seq.periodic_interval || 1000,
      connType: connectionType,
    }).catch(e => console.error("start_periodic_sequence failed:", e));
    setActivePeriodicIds(prev => new Set(prev).add(seq.id));
  };

  const stopPeriodic = (seqId: string) => {
    invoke("stop_periodic_sequence", {
      tabId,
      seqId,
      connType: connectionType,
    }).catch(e => console.error("stop_periodic_sequence failed:", e));
    setActivePeriodicIds(prev => {
      const next = new Set(prev);
      next.delete(seqId);
      return next;
    });
  };

  // Stop all periodic sequences when disconnected
  useEffect(() => {
    if (!connected) {
      invoke("stop_all_periodic_sequences", { tabId, connType: connectionType || "Serial" })
        .catch(() => { });
      setActivePeriodicIds(new Set());
    }
  }, [connected]);


  const handleSend = async (seq: Sequence) => {
    let bytes: number[] = parseData(seq.data, seq.view_mode);

    try {
      if (connectionType === 'Serial') {
        await invoke("send_serial_data", { tabId, data: bytes });
      } else if (connectionType === 'TCP') {
        await invoke("send_tcp_data", { tabId, data: bytes });
      } else if (connectionType === 'SSH') {
        await invoke("send_ssh_data", { tabId, data: bytes });
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
          tabId,
          portName: selectedPort,
          baudRate,
          dataBits,
          flowControl,
          parity,
          stopBits
        });
      } else if (connectionType === 'TCP') {
        await invoke("connect_tcp", {
          tabId,
          host: tcpHost,
          port: tcpPort
        });
      } else if (connectionType === 'SSH') {
        await invoke("connect_ssh", {
          tabId,
          host: sshHost,
          port: sshPort,
          user: sshUsername,
          auth_mode: sshAuthMode,
          auth_secret: sshAuthSecret
        });
      }
      setActiveProtocol(connectionType);
      setConnected(true); onConnectionStatusChange(tabId, true, connectionType === 'Serial' ? selectedPort : (connectionType === 'TCP' ? tcpHost : sshHost));
    } catch (e) {
      alert("Connection failed: " + e);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      const protocolToDisconnect = activeProtocol || connectionType;
      if (protocolToDisconnect === 'Serial') {
        await invoke("close_serial_port", { tabId });
      } else if (protocolToDisconnect === 'TCP') {
        await invoke("disconnect_tcp", { tabId });
      } else if (protocolToDisconnect === 'SSH') {
        await invoke("disconnect_ssh", { tabId });
      }
      setConnected(false);
      setActiveProtocol(null);
      onConnectionStatusChange(tabId, false, '');
    } catch (e) {
      console.error(e);
    }
  };

  const updateSequence = (updated: Sequence) => {
    const newSeqs = project.send_sequences.map((s: Sequence) => s.id === updated.id ? updated : s);
    setProject({ ...project, send_sequences: newSeqs });
    setEditingSeq(null);
  };

  return (
    <div className="h-full w-full bg-background text-foreground flex flex-col overflow-hidden" style={{ display: isActive ? 'flex' : 'none' }}>
      <header className="px-3 py-2 border-b flex justify-between items-center bg-card shadow-sm shrink-0">
        <div className="flex items-center gap-3">






          {/* Chart Toggle Button */}
          <button
            onClick={() => setIsChartOpen(!isChartOpen)}
            className={`p-1.5 rounded transition-colors ${isChartOpen ? 'bg-blue-600 text-white' : 'hover:bg-accent'}`}
            title="Toggle Real-Time Chart"
          >
            <LineChartIcon className="w-4 h-4" />
          </button>

          {/* Separator */}
          <div className="w-px h-5 bg-border mx-0.5" />

          {/* Legacy TXT/Log Buttons */}
          <div className="relative flex items-center">
            <button
              onClick={() => isLiveLogging ? handleStopLiveLogging() : setShowLogOptions(!showLogOptions)}
              className={`p-1.5 rounded transition-colors ${isLiveLogging ? 'text-red-400 bg-red-900/40 animate-pulse' : 'hover:bg-accent'}`}
              title={isLiveLogging ? "Stop Logging" : "Start Logging to File (.txt/.log)"}
            >
              <FileText className="w-4 h-4" />
              {isLiveLogging && <span className="absolute text-[8px] font-bold bottom-0 right-0">LOG</span>}
            </button>
            {showLogOptions && !isLiveLogging && (
              <div className="absolute left-0 top-full mt-1 bg-zinc-800 border border-zinc-700 rounded shadow-lg z-50 p-2 w-48 text-left">
                <div className="text-[10px] text-zinc-400 font-semibold mb-1 uppercase">Log Format</div>
                <div className="text-[10px] text-zinc-500 mb-2">Select format. Default = ASCII + HEX combined.</div>
                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer py-0.5 hover:bg-zinc-700 rounded px-1">
                  <input type="checkbox" checked={exportAscii} onChange={e => setExportAscii(e.target.checked)} />
                  ASCII only
                </label>
                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer py-0.5 hover:bg-zinc-700 rounded px-1">
                  <input type="checkbox" checked={exportHex} onChange={e => setExportHex(e.target.checked)} />
                  HEX only
                </label>
                <button onClick={handleStartLiveLogging} className="w-full mt-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded text-xs font-medium">Start Logging</button>
              </div>
            )}
          </div>

          <div className="relative flex items-center pr-1">
            <button onClick={() => setShowExportOptions(!showExportOptions)} className={`p-1.5 rounded transition-colors ${showExportOptions ? 'bg-accent' : 'hover:bg-accent'}`} title="Export Logs">
              <Download className="w-4 h-4" />
            </button>
            {showExportOptions && (
              <div className="absolute left-0 top-full mt-1 bg-zinc-800 border border-zinc-700 rounded shadow-lg z-50 p-2 w-48 text-left">
                <div className="text-[10px] text-zinc-400 font-semibold mb-1 uppercase">Export Formats</div>
                <div className="text-[10px] text-zinc-500 mb-2">Select formats for separate files. None = combined default.</div>
                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer py-0.5 hover:bg-zinc-700 rounded px-1">
                  <input type="checkbox" checked={exportAscii} onChange={e => setExportAscii(e.target.checked)} /> ASCII
                </label>
                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer py-0.5 hover:bg-zinc-700 rounded px-1">
                  <input type="checkbox" checked={exportHex} onChange={e => setExportHex(e.target.checked)} /> HEX
                </label>
                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer py-0.5 hover:bg-zinc-700 rounded px-1">
                  <input type="checkbox" checked={exportBin} onChange={e => setExportBin(e.target.checked)} /> BIN
                </label>
                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer py-0.5 hover:bg-zinc-700 rounded px-1">
                  <input type="checkbox" checked={exportDec} onChange={e => setExportDec(e.target.checked)} /> DEC
                </label>
                <button onClick={() => { handleTerminalExport(logs, isPro, FREE_LIMITS.MAX_EXPORT_LINES, { exportAscii, exportHex, exportBin, exportDec }); setShowExportOptions(false); }} className="w-full mt-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded text-xs font-medium">Download</button>
              </div>
            )}
          </div>

          {/* Separator */}
          <div className="w-px h-5 bg-border mx-0.5" />

          {/* Session Recording Controls */}
          <div className="flex bg-zinc-800/30 rounded p-0.5 ml-0.5 gap-1 items-center">
            <button
              className={`text-white rounded px-2.5 py-1 flex items-center gap-1.5 transition-colors ${connected ? (isRecording ? 'bg-zinc-700 hover:bg-zinc-600' : 'bg-rose-600 hover:bg-rose-700 shadow-sm') : 'bg-zinc-800/80 text-zinc-500 cursor-not-allowed opacity-60 font-medium'}`}
              onClick={connected ? handleToggleRecord : undefined}
              disabled={!connected}
              title={connected ? (isRecording ? "Stop Recording Session" : "Record Session to .plog file") : "Connect to a port to enable Session Recording"}
              style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.01em' }}
            >
              {isRecording ? (
                <><div className="w-1.5 h-1.5 bg-rose-500 rounded-[1px]" /> Stop</>
              ) : (
                <><div className={`w-1.5 h-1.5 ${connected ? 'bg-rose-200 shadow-[0_0_8px_rgba(251,113,133,0.8)] animate-pulse' : 'bg-zinc-600'} rounded-full`} /> Record</>
              )}
            </button>

            {!isRecording && (
              <button
                className="text-white bg-indigo-600 shadow-sm hover:bg-indigo-700 rounded px-2.5 py-1 flex items-center gap-1.5 transition-colors"
                onClick={handlePlayRecording}
                title="Open and Play a .plog session"
                style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.01em' }}
              >
                ▶️ Playback
              </button>
            )}
          </div>
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
              <span className="text-zinc-500 font-bold ml-1">Auth:</span>
              <select
                className="w-24 rounded px-1 py-1 text-sm outline-none border focus:ring-1 focus:ring-zinc-500"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                value={sshAuthMode}
                onChange={(e) => setSshAuthMode(e.target.value as 'password' | 'private_key')}
                disabled={connected}
              >
                <option value="password">Password</option>
                <option value="private_key">Key File</option>
              </select>

              {sshAuthMode === 'password' ? (
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
                  value={sshAuthSecret}
                  onChange={(e) => setSshAuthSecret(e.target.value)}
                  disabled={connected}
                />
              ) : (
                <div className="flex gap-1 items-center">
                  <input
                    type="text"
                    className="w-32 rounded px-2 py-1 text-sm outline-none border focus:ring-1 focus:ring-zinc-500"
                    style={{
                      backgroundColor: 'hsl(var(--background))',
                      borderColor: 'hsl(var(--border))',
                      color: 'hsl(var(--foreground))',
                    }}
                    placeholder="Path to private key"
                    title="Private Key File Path (saved to .plant)"
                    value={sshAuthSecret}
                    onChange={(e) => setSshAuthSecret(e.target.value)}
                    disabled={connected}
                  />
                  <button
                    className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs"
                    onClick={async () => {
                      const selected = await open({
                        multiple: false
                      });
                      if (selected && typeof selected === 'string') {
                        setSshAuthSecret(selected);
                      }
                    }}
                    disabled={connected}
                  >
                    Browse
                  </button>
                </div>
              )}
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
                connection_type: connectionType,
                serial_config: { port_name: selectedPort, baud_rate: baudRate, data_bits: dataBits, flow_control: flowControl, parity: parity, stop_bits: stopBits },
                tcp_config: { host: tcpHost, port: tcpPort },
                ssh_config: { host: sshHost, port: sshPort, username: sshUsername },
              }}
              onUpdate={(updatedProject: Project) => {
                setProject(updatedProject);
                // When loading a project, also update the local state fields immediately
                if (updatedProject.connection_type) setConnectionType(updatedProject.connection_type);
                if (updatedProject.serial_config) {
                  setSelectedPort(updatedProject.serial_config.port_name);
                  setBaudRate(updatedProject.serial_config.baud_rate);
                  setDataBits(updatedProject.serial_config.data_bits);
                  setFlowControl(updatedProject.serial_config.flow_control);
                  setParity(updatedProject.serial_config.parity);
                  setStopBits(updatedProject.serial_config.stop_bits);
                }
                if (updatedProject.tcp_config) {
                  setTcpHost(updatedProject.tcp_config.host);
                  setTcpPort(updatedProject.tcp_config.port);
                }
                if (updatedProject.ssh_config) {
                  setSshHost(updatedProject.ssh_config.host);
                  setSshPort(updatedProject.ssh_config.port);
                  setSshUsername(updatedProject.ssh_config.username);
                }
              }}
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

            {isPlayingBack && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 bg-zinc-900 border border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.2)] rounded-full px-5 py-2 flex items-center gap-3">
                {/* Status indicator */}
                <div className={`w-2.5 h-2.5 rounded-full ${isPlaybackPaused ? 'bg-amber-400' : 'bg-indigo-500 animate-pulse'}`} />
                <span className="text-sm font-semibold text-indigo-100">
                  {isPlaybackPaused ? 'Paused' : 'Playing Session...'}
                </span>
                <div className="w-px h-4 bg-zinc-700" />
                {/* Pause / Resume */}
                <button
                  onClick={handlePausePlayback}
                  className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1 rounded-full border border-zinc-700 transition-colors flex items-center gap-1"
                  title={isPlaybackPaused ? 'Resume' : 'Pause'}
                >
                  {isPlaybackPaused ? '▶ Resume' : '⏸ Pause'}
                </button>
                {/* Stop */}
                <button
                  onClick={handleStopPlayback}
                  className="text-xs bg-zinc-800 hover:bg-red-900/60 text-zinc-300 hover:text-red-300 px-3 py-1 rounded-full border border-zinc-700 hover:border-red-700 transition-colors flex items-center gap-1"
                  title="Stop Playback"
                >
                  ⏹ Stop
                </button>
              </div>
            )}
            <Terminal
              logs={logs}
              onClear={() => setLogs([])}
              onSendCommand={connectionType === 'SSH' ? async (cmd: string) => {
                try {
                  const bytes = Array.from(new TextEncoder().encode(cmd));
                  await invoke("send_ssh_data", { tabId, data: bytes });
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
          onDelete={(seq: Sequence) => {
            const newSeqs = project.send_sequences.filter((s: Sequence) => s.id !== seq.id);
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
          onSave={(updated: Reaction) => {
            const newReactions = project.reactions.map((r: Reaction) => r.id === updated.id ? updated : r);
            setProject({ ...project, reactions: newReactions });
            onProjectNameChange(tabId, project.name);
            setEditingReaction(null);
          }}
        />
      )}

      {/* License Dialog */}

    </div>
  );
}

// Wrap App with LicenseProvider

