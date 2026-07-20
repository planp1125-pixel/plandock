import { useState, useEffect, useRef, memo } from "react";
import { safeInvoke, safeListen, safeOpen, safeSave, isTauri } from "../utils/tauri";
import { ProjectSidebar } from "./ProjectSidebar";
import { Terminal, LogEntry } from "./Terminal";
import { SequenceEditor } from "./SequenceEditor";
import { ReactionEditor } from "./ReactionEditor";
import { Project, Sequence, Reaction, PortInfo } from "../types";
import { parseData, filterAnsi } from "../utils";
import { RotateCw, Settings, ChevronDown, LineChart as LineChartIcon, Download, FileText, Globe, MonitorUp, PanelLeftClose, PanelLeft } from "lucide-react";
import { ChartWindow } from "./ChartWindow";
import { ChartConfig, ChartDataPoint, extractValue } from "../chart_utils";
import { useLicense, FREE_LIMITS } from "../contexts/LicenseContext";
import { handleTerminalExport } from "../utils/export";
import { useRemote } from "../contexts/RemoteContext";

export const Workspace = memo(({ tabId, isActive, darkMode, onConnectionStatusChange, onProjectNameChange, autoScroll, setAutoScroll, remoteChannel, peerId, activePeers: propsActivePeers }: { tabId: string, isActive: boolean, darkMode: boolean, onConnectionStatusChange: (tabId: string, isConnected: boolean, label: string) => void, onProjectNameChange: (tabId: string, name: string) => void, autoScroll: boolean, setAutoScroll: (val: boolean) => void, remoteChannel?: any, peerId?: string, activePeers?: any }) => {
  const { activePeers: contextActivePeers, addLog, isSharing } = useRemote();
  const activePeers = propsActivePeers || contextActivePeers || {};

  const activePeersRef = useRef(activePeers);
  useEffect(() => {
    activePeersRef.current = activePeers;
  }, [activePeers]);

  const handleShareToPeer = async (peerId: string, retryCount = 0) => {
    try {
      await safeInvoke("share_active_tab", { tabId, peerId });

      const syncState = (channel: any) => {
        const statePacket = {
          type: "PROJECT_SYNC",
          project: project,
          connectionType: connectionType,
          deviceName: localStorage.getItem('remote-device-name') || 'Plan Terminal'
        };
        const bytes = new TextEncoder().encode(JSON.stringify(statePacket));
        const packet = new Uint8Array([0x02, 0x04, ...bytes]); // 0x02=Control, 0x04=StateSync
        
        if (typeof channel.send === 'function') {
           channel.send(packet);
        } else {
           safeInvoke("send_remote_data", { peerId, label: "serial-bridge", data: Array.from(packet) });
        }
        addLog(`Shared tab ${tabId} & synced state with ${peerId}`);
      };

      // Find the channel for this peer
      const currentPeers = activePeersRef.current;
      const peer = currentPeers[peerId];
      if (peer && (peer.channel || peer.label)) {
        const channelObj = peer.channel || { label: peer.label, readyState: 'open' }; 
        if (channelObj.readyState === 'open') {
          syncState(channelObj);
        } else {
          channelObj.onopen = () => syncState(channelObj);
        }
      } else {
        if (retryCount < 20) {
          console.warn(`[Remote] Peer ${peerId} not found in state yet, retrying sync in 500ms... (${retryCount + 1}/20)`);
          setTimeout(() => handleShareToPeer(peerId, retryCount + 1), 500);
        } else {
          console.error(`[Remote] Gave up waiting for peer ${peerId} channel state.`);
        }
      }
    } catch (e) {
      alert("Sharing failed: " + e);
    }
  };

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
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [rxBytes, setRxBytes] = useState(0);
  const [txBytes, setTxBytes] = useState(0);
  const [rxPackets, setRxPackets] = useState(0);
  const [txPackets, setTxPackets] = useState(0);

  // File Logging and Export State
  const { isPro } = useLicense();
  const [exportAscii, setExportAscii] = useState(false);
  const [exportHex, setExportHex] = useState(false);
  const [exportBin, setExportBin] = useState(false);
  const [exportDec, setExportDec] = useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [showLogOptions, setShowLogOptions] = useState(false);
  const [isLiveLogging, setIsLiveLogging] = useState(false);
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

  const isIncomingSyncRef = useRef(false);

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
      const list = await safeInvoke<PortInfo[]>("list_serial_ports");
      setPorts(list || []);
    } catch (e) {
      console.error("Failed to list ports:", e);
    }
  };

  const stopLogging = async () => {
    try {
      await safeInvoke("stop_logging", { tabId, connType: connectionType });
      setIsLiveLogging(false);
    } catch (e) {
      console.error("Failed to stop logging:", e);
    }
  };

  const handleToggleRecord = async () => {
    if (isRecording) {
      await safeInvoke("stop_logging", { tabId, connType: connectionType });
      setIsRecording(false);
    } else {
      const selectedPath = await safeSave({
        filters: [{ name: 'Plan Terminal Session', extensions: ['plog'] }],
        title: 'Save Session Recording (.plog)',
        defaultPath: `session_${Date.now()}.plog`
      });
      if (selectedPath) {
        try {
          await safeInvoke("start_logging", { tabId, path: selectedPath, connType: connectionType });
          setIsRecording(true);
        } catch (e) {
          alert("Failed to start recording: " + String(e));
        }
      }
    }
  };

  const handlePlayRecording = async () => {
    const selectedPath = await safeOpen({
      filters: [{ name: 'Plan Terminal Session', extensions: ['plog'] }],
      title: 'Open Session Recording (.plog)',
      multiple: false
    });

    if (selectedPath && typeof selectedPath === 'string') {
      try {
        setIsPlaybackPaused(false);
        await safeInvoke("play_recording", { tabId, path: selectedPath, speedMultiplier: 1.0 });
        setIsRecording(true);
      } catch (e) {
        alert("Playback failed: " + e);
      }
    }
  };

  const resumeRecording = async () => {
    await safeInvoke("resume_recording", { tabId });
  };
  const pauseRecording = async () => {
    await safeInvoke("pause_recording", { tabId });
  };
  const handleStopPlayback = async () => {
    await safeInvoke("stop_recording", { tabId });
    setIsPlayingBack(false);
    setIsPlaybackPaused(false);
  };

  const handleStartLiveLogging = async () => {
    if (!isLiveLogging) {
      try {
        const path = await safeSave({
          filters: [{ name: 'Log File', extensions: ['txt', 'log', 'csv'] }],
          title: 'Select Log File Location',
          defaultPath: `log_${tabId}_${Date.now()}.txt`
        });
        if (path) {
          await safeInvoke('start_logging', { tabId, path, connType: activeProtocol, format: exportAscii ? 'ascii' : 'hex' });
          setIsLiveLogging(true);
        }
      } catch (e) {
        alert("Failed to start logging: " + e);
      }
    } else {
      await safeInvoke('stop_logging', { tabId, connType: activeProtocol });
      setIsLiveLogging(false);
    }
  };

  useEffect(() => {
    refreshPorts();
  }, []);

  useEffect(() => {
    if (ports.length > 0 && !connected && !isConnecting) {
      if (!selectedPort || !ports.some(p => p.port_name === selectedPort)) {
        setSelectedPort(ports[0].port_name);
      }
    }
  }, [ports, selectedPort, connected, isConnecting]);



  useEffect(() => {
    const interval = setInterval(() => {
      // 1. Process Logs
      if (incomingQueue.current.length > 0) {
        const batch = [...incomingQueue.current];
        incomingQueue.current = [];

        const gap = Number(localStorage.getItem('terminal-ts-gap') || '100');
        const aggregatedBatch: { bytes: number[], ts: number, dir: string }[] = [];

        for (const item of batch) {
          if (!item || !Array.isArray(item.bytes)) continue;
          if (aggregatedBatch.length > 0) {
            const lastAgg = aggregatedBatch[aggregatedBatch.length - 1];
            if (lastAgg.dir === item.dir && (item.ts - lastAgg.ts) < gap && lastAgg.bytes.length < 8000) {
              for (let i = 0; i < item.bytes.length; i++) {
                lastAgg.bytes.push(item.bytes[i]);
              }
              continue;
            }
          }
          aggregatedBatch.push({ bytes: [...item.bytes], ts: item.ts, dir: item.dir });
        }

        setLogs(prev => {
          if (aggregatedBatch.length === 0) return prev;
          let next = [...prev];

          for (const item of aggregatedBatch) {
            if (!item || !Array.isArray(item.bytes)) continue;
            const last = lastRef.current;
            if (last && next.length > 0 && next[next.length - 1].id === last.id &&
              last.direction === item.dir && (item.ts - last.timestamp) < gap &&
              next[next.length - 1].data.length < 8000) {
              const lastIdx = next.length - 1;
              const newData = [...next[lastIdx].data, ...item.bytes];
              next[lastIdx] = {
                ...next[lastIdx],
                data: newData,
                processedData: filterAnsi(newData)
              };
            } else {
              const id = Math.random().toString(36).substr(2, 9);
              lastRef.current = { id, timestamp: item.ts, direction: item.dir };
              next.push({ id, timestamp: item.ts, direction: item.dir as any, data: item.bytes, processedData: filterAnsi(item.bytes) });
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

    }, 100); // 100ms throttle (matches user's high-speed data interval)

    return () => clearInterval(interval);
  }, []);

  const [connectionType, setConnectionType] = useState<'Serial' | 'TCP' | 'SSH' | 'Remote'>(
    !isTauri() || remoteChannel ? 'Remote' : 'Serial'
  );

  useEffect(() => {
    if (!isTauri() || remoteChannel) {
      setConnectionType('Remote');
    }
  }, [remoteChannel]);
  const [remoteDeviceId, setRemoteDeviceId] = useState('');

  // Handle Remote DataChannel
  useEffect(() => {
    if (!remoteChannel) return;

    if (remoteChannel.readyState === 'open') {
      setConnected(true);
      setConnectionType('Remote');
      onConnectionStatusChange(tabId, true, 'P2P Remote');
    } else {
      setConnectionType('Remote');
      remoteChannel.onopen = () => {
        setConnected(true);
        onConnectionStatusChange(tabId, true, 'P2P Remote');
      };
    }

    remoteChannel.onmessage = (e: any) => {
      const data = e.data as ArrayBuffer;
      const bytes = Array.from(new Uint8Array(data));
      const type = bytes[0];

      console.log(`[Remote] Msg Type: 0x${type.toString(16)}, Sub: 0x${bytes[1]?.toString(16)}`);

      if (type === 0x01 || type === 0x03) {
        // Serial (0x01) or SSH (0x03) data: [Type, Dir(0=RX, 1=TX), ...bytes]
        const dir = bytes[1] === 1 ? "TX" : "RX";
        incomingQueue.current.push({
          bytes: bytes.slice(2),
          ts: Date.now(),
          dir: dir
        });
      } else if (type === 0x02) {
        // Control Message: [Type, SubType, ...data]
        if (bytes[1] === 0x03) {
          // Mirror signal from Host
          setConnected(true);
          onConnectionStatusChange(tabId, true, 'Mirrored Session');
        } else if (bytes[1] === 0x04) {
          // Project State Sync
          try {
            const payload = new TextDecoder().decode(new Uint8Array(bytes.slice(2)));
            const syncData = JSON.parse(payload);
            if (syncData.type === "PROJECT_SYNC") {
              setProject(syncData.project);
              if (syncData.connectionType) {
                setConnectionType(syncData.connectionType);
                setRemoteDeviceId(syncData.deviceName || 'Remote Host');
              }
              addLog("Project state mirrored from Host.");
            }
          } catch (e) {
            console.error("Failed to parse project sync:", e);
          }
        }
      }
    };

    remoteChannel.onclose = () => {
      setConnected(false);
      onConnectionStatusChange(tabId, false, '');
    };

    return () => {
      // remoteChannel.close() is handled by App.tsx closeTab
    };
  }, [remoteChannel]);

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
    }
    if (project.serial_config) {
      setSelectedPort(project.serial_config.port_name);
      setBaudRate(project.serial_config.baud_rate);
      setDataBits(project.serial_config.data_bits);
      setParity(project.serial_config.parity);
      setStopBits(project.serial_config.stop_bits);
      setFlowControl(project.serial_config.flow_control);
    }
  }, [project.file_path, project.name]);

  // Synchronize Reactions Array to Rust Backend
  useEffect(() => {
    const activeReactions = project.reactions
      .filter(r => r.enabled)
      .map(r => {
        const triggerBytes = parseData(r.trigger_data, r.view_mode as any);
        // Backward compatibility
        let actions = r.actions || [];
        if (actions.length === 0 && r.response_sequence_id) {
          actions = [{ sequence_id: r.response_sequence_id, delay_ms: 0 }];
        }

        const mappedActions = actions.map(act => {
          const seq = project.send_sequences.find(s => s.id === act.sequence_id);
          const responseBytes = seq ? parseData(seq.data, seq.view_mode as any) : [];
          return {
            response_data: responseBytes,
            delay_ms: act.delay_ms
          };
        }).filter(act => act.response_data.length > 0);

        return {
          trigger_data: triggerBytes,
          actions: mappedActions
        };
      })
      .filter(r => r.trigger_data.length > 0);

    safeInvoke("set_reactions", { tabId, newReactions: activeReactions }).catch(e =>
      console.error("Failed to sync reactions:", e)
    );
  }, [project.reactions, project.send_sequences, tabId]);

  // Listen for serial/TCP/SSH data and connection events
  useEffect(() => {
    const unlistenData = safeListen<[string, number[], number, string]>('serial-data', (event) => {
      const [evTabId, bytes, ts, dir] = event.payload;
      if (evTabId !== tabId) return;

      const displayDir = dir.startsWith("TX") ? "TX" : "RX";
      incomingQueue.current.push({ bytes, ts, dir: displayDir });

      if (displayDir === "TX") {
        setTxBytes(prev => prev + bytes.length);
        setTxPackets(prev => prev + 1);
      } else {
        setRxBytes(prev => prev + bytes.length);
        setRxPackets(prev => prev + 1);
      }

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

    const unlistenTcpDisconnect = safeListen<string>('tcp-disconnected', (event) => {
      if (event.payload !== tabId) return;
      setConnected(false); onConnectionStatusChange(tabId, false, '');
      alert("TCP Connection closed by remote host or error occurred.");
    });

    const unlistenSshDisconnect = safeListen<string>('ssh-disconnected', (event) => {
      if (event.payload !== tabId) return;
      setConnected(false); onConnectionStatusChange(tabId, false, '');
      alert("SSH Connection closed.");
    });

    const unlistenTrigger = safeListen<[string, string, number[]]>('remote-sequence-trigger', (event) => {
      const [, , bytes] = event.payload;
      // bytes should be [0x02, 0x05, ...seq_id]
      if (bytes.length > 2) {
        const seqId = new TextDecoder().decode(new Uint8Array(bytes.slice(2)));
        const seqToRun = project.send_sequences.find(s => s.id === seqId);
        if (seqToRun) {
          addLog(`Remote Trigger: Executing sequence '${seqToRun.name}'`);
          handleSend(seqToRun);
        }
      }
    });

    const unlistenSync = safeListen<[string, string, number[]]>('remote-project-sync', (event) => {
      const [, , bytes] = event.payload;
      try {
        const payload = new TextDecoder().decode(new Uint8Array(bytes.slice(2)));
        const syncData = JSON.parse(payload);
        if (syncData.type === "PROJECT_SYNC") {
          isIncomingSyncRef.current = true;
          setProject(syncData.project);
          if (syncData.connectionType) {
            setConnectionType(syncData.connectionType);
            setRemoteDeviceId(syncData.deviceName || 'Remote Host');
          }
          addLog("Project state synced from Web Viewer.");
        }
      } catch (e) {
        console.error("Failed to parse project sync:", e);
      }
    });

    const unlistenPlaybackStart = safeListen<string>('playback-started', (event) => {
      if (event.payload !== tabId) return;
      setLogs([]);
      setChartData([]);
      incomingQueue.current = [];
      lastRef.current = null;
      setIsPlayingBack(true);
    });

    const unlistenPlaybackEnded = safeListen<string>('playback-ended', (event) => {
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
      unlistenTrigger.then(f => f());
      unlistenSync.then(f => f());
    };
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'c') {
          e.preventDefault();
          if (!connected && !isConnecting && (connectionType !== 'Serial' || selectedPort)) {
            handleConnect();
          }
        } else if (key === 'd') {
          e.preventDefault();
          if (connected) {
            handleDisconnect();
          }
        } else if (key === 'r') {
          e.preventDefault();
          if (connected) {
            handleToggleRecord();
          }
        } else if (key === 'l') {
          e.preventDefault();
          if (isLiveLogging) {
            stopLogging();
          } else {
            setShowLogOptions(prev => !prev);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, connected, isConnecting, connectionType, selectedPort, isLiveLogging, isRecording]);

  // Handle auto-share trigger (triggered when Host accepts a call)
  useEffect(() => {
    if (!isActive) return;
    const handleTrigger = (e: any) => {
      const { tabId: eventTabId, peerId } = e.detail;
      if (eventTabId === tabId) {
        handleShareToPeer(peerId);
      }
    };
    window.addEventListener('trigger-tab-share', handleTrigger);
    return () => window.removeEventListener('trigger-tab-share', handleTrigger);
  }, [isActive, tabId, project, connectionType]);

  // Project Sync Broadcaster
  useEffect(() => {
    if (isIncomingSyncRef.current) {
      isIncomingSyncRef.current = false;
      return;
    }

    const syncData = {
      type: "PROJECT_SYNC",
      project: project,
      connectionType: connectionType,
      deviceName: localStorage.getItem('remote-device-name') || 'Remote Host'
    };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(syncData));
    const payload = new Uint8Array(2 + payloadBytes.length);
    payload[0] = 0x02; // Control
    payload[1] = 0x04; // Project Sync
    payload.set(payloadBytes, 2);

    if (!isTauri() && remoteChannel) {
      // Web Viewer syncing edits back to Host
      if (typeof remoteChannel.send === 'function') {
        remoteChannel.send(payload);
      }
    } else if (isTauri() && isSharing && activePeers && Object.keys(activePeers).length > 0) {
      // Host broadcasting state to all peers
      Object.keys(activePeers).forEach(pid => {
        safeInvoke('send_remote_data', { peerId: pid, label: 'serial-bridge', data: Array.from(payload) })
          .catch(e => console.error("Sync failed:", e));
      });
    }
  }, [project, connectionType]);

  const [activePeriodicIds, setActivePeriodicIds] = useState<Set<string>>(new Set());

  const startPeriodic = (seq: Sequence) => {
    const bytes = parseData(seq.data, seq.view_mode as any);
    safeInvoke("start_periodic_sequence", {
      tabId,
      seqId: seq.id,
      data: bytes,
      intervalMs: seq.periodic_interval ?? 1000,
      connType: connectionType || "Serial"
    }).catch(e => console.error("Failed to start periodic:", e));
    setActivePeriodicIds(prev => new Set([...prev, seq.id]));
  };

  const stopPeriodic = (seqId: string) => {
    safeInvoke("stop_periodic_sequence", {
      tabId,
      seqId,
      connType: connectionType || "Serial"
    }).catch(e => console.error("Failed to stop periodic:", e));
    setActivePeriodicIds(prev => {
      const next = new Set(prev);
      next.delete(seqId);
      return next;
    });
  };

  useEffect(() => {
    return () => {
      if (connected) {
        safeInvoke("stop_all_periodic_sequences", { tabId, connType: connectionType || "Serial" })
          .catch(() => {});
      }
    };
  }, [tabId, connected, connectionType]);


  const handleSend = async (seq: Sequence) => {
    let bytes: number[] = parseData(seq.data, seq.view_mode);

    try {
      if (!isTauri() && remoteChannel) {
        // WEB VIEWER (Browser) ALWAYS sends over WebRTC, regardless of connectionType
        const seqIdBytes = new TextEncoder().encode(seq.id);
        const payload = new Uint8Array(2 + seqIdBytes.length);
        payload[0] = 0x02; // Control
        payload[1] = 0x05; // Trigger
        payload.set(seqIdBytes, 2);
        
        if (typeof remoteChannel.send === 'function') {
          remoteChannel.send(payload);
        }
        return;
      }

      if (remoteChannel) {
        // Host sending raw data over remote channel
        const payload = new Uint8Array(1 + bytes.length);
        payload[0] = 0x01; // Data
        payload.set(bytes, 1);
        if (typeof remoteChannel.send === 'function') {
          remoteChannel.send(payload);
        } else {
          // Tauri Rust backend handles the channel
          await safeInvoke('send_remote_data', { peerId, label: remoteChannel.label, data: Array.from(payload) });
        }
        incomingQueue.current.push({ bytes, ts: Date.now(), dir: "TX" });
      } else if (connectionType === 'Serial') {
        await safeInvoke("send_serial_data", { tabId, data: bytes });
      } else if (connectionType === 'TCP') {
        await safeInvoke("send_tcp_data", { tabId, data: bytes });
      } else if (connectionType === 'SSH') {
        const sshBytes = [...bytes];
        if (sshBytes.length > 0 && sshBytes[sshBytes.length - 1] !== 10 && sshBytes[sshBytes.length - 1] !== 13) {
          sshBytes.push(10); // Append LF (\n)
        }
        await safeInvoke("send_ssh_data", { tabId, data: sshBytes });
      }
    } catch (e) {
      console.error(e);
      alert("Failed to send: " + e);
    }
  };

  const handleConnect = async () => {
    try {
      setIsConnecting(true);
      setRxBytes(0);
      setTxBytes(0);
      setRxPackets(0);
      setTxPackets(0);
      const protocol = connectionType || "Serial";
      if (protocol === "Serial") {
        await safeInvoke("open_serial_port", {
          tabId,
          portName: selectedPort,
          baudRate,
          dataBits,
          flowControl,
          parity,
          stopBits
        });
      } else if (protocol === "TCP") {
        await safeInvoke("connect_tcp", {
          tabId,
          host: tcpHost,
          port: tcpPort
        });
      } else if (protocol === "SSH") {
        await safeInvoke("connect_ssh", {
          tabId,
          host: sshHost,
          port: sshPort,
          user: sshUsername,
          authMode: sshAuthMode,
          authSecret: sshAuthSecret
        });
      } else if (protocol === "Remote") {
        await safeInvoke("connect_remote", { tabId, deviceId: remoteDeviceId });
      }
      
      setActiveProtocol(protocol);
      setConnected(true);
      onConnectionStatusChange(tabId, true, protocol === "Serial" ? selectedPort : protocol === "TCP" ? tcpHost : protocol === "SSH" ? sshHost : "Remote");
    } catch (e) {
      alert("Connection failed: " + e);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      const protocolToDisconnect = activeProtocol || connectionType || "Serial";
      await safeInvoke("stop_all_periodic_sequences", { tabId, connType: protocolToDisconnect });
      
      if (protocolToDisconnect === "Serial") {
        await safeInvoke("close_serial_port", { tabId });
      } else if (protocolToDisconnect === "TCP") {
        await safeInvoke("disconnect_tcp", { tabId });
      } else if (protocolToDisconnect === "SSH") {
        await safeInvoke("disconnect_ssh", { tabId });
      } else if (protocolToDisconnect === "Remote") {
        if (remoteChannel && remoteChannel.close) {
          remoteChannel.close();
        }
      }
      setConnected(false);
      setActiveProtocol(null);
      onConnectionStatusChange(tabId, false, "Disconnected");
    } catch (e) {
      console.error("Disconnect error:", e);
    }
  };

  const updateSequence = (updated: Sequence) => {
    const newSeqs = project.send_sequences.map((s: Sequence) => s.id === updated.id ? updated : s);
    setProject({ ...project, send_sequences: newSeqs });
    setEditingSeq(null);
  };

  return (
    <div className="h-full w-full bg-background text-foreground flex flex-col overflow-hidden" style={{ display: isActive ? 'flex' : 'none' }}>
      <header className="px-3 py-2 border-b flex justify-between items-center flex-wrap gap-2 bg-card shadow-sm shrink-0">
        <div className="flex items-center flex-wrap gap-2">






          {/* Sidebar Toggle Button */}
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
            title={isSidebarOpen ? "Hide Sidebar" : "Show Sidebar"}
          >
            {isSidebarOpen ? <PanelLeftClose className="w-3.5 h-3.5" /> : <PanelLeft className="w-3.5 h-3.5" />}
          </button>

          {/* Chart Toggle Button */}
          <button
            onClick={() => setIsChartOpen(!isChartOpen)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors ${isChartOpen ? 'bg-blue-600 text-white font-medium' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'}`}
            title="Toggle Real-Time Chart"
          >
            <LineChartIcon className="w-3.5 h-3.5" />
            <span>Chart</span>
          </button>

          {/* Separator */}
          <div className="w-px h-5 bg-border mx-0.5" />

          {/* Legacy TXT/Log Buttons */}
          <div className="relative flex items-center">
            <button
              onClick={() => isLiveLogging ? stopLogging() : setShowLogOptions(!showLogOptions)}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors ${isLiveLogging ? 'text-red-400 bg-red-950 border border-red-500/50 font-medium' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'}`}
              title={isLiveLogging ? "Stop Logging" : "Start Logging to File (.txt/.log)"}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>{isLiveLogging ? 'Logging' : 'Log'}</span>
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
            <button onClick={() => setShowExportOptions(!showExportOptions)} className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors ${showExportOptions ? 'bg-zinc-800 text-white font-medium' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'}`} title="Export Logs">
              <Download className="w-3.5 h-3.5" />
              <span>Export</span>
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
              className={`text-white rounded px-2 py-0.5 flex items-center gap-1 transition-colors ${connected ? (isRecording ? 'bg-zinc-700 hover:bg-zinc-600' : 'bg-rose-600 hover:bg-rose-700') : 'bg-zinc-800/80 text-zinc-500 cursor-not-allowed opacity-60 font-medium'}`}
              onClick={connected ? handleToggleRecord : undefined}
              disabled={!connected}
              title={connected ? (isRecording ? "Stop Recording Session" : "Record Session to .plog file") : "Connect to a port to enable Session Recording"}
              style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.01em' }}
            >
              {isRecording ? (
                <><div className="w-1.5 h-1.5 bg-rose-500 rounded-[1px]" /> Stop</>
              ) : (
                <><div className={`w-1.5 h-1.5 ${connected ? 'bg-rose-200' : 'bg-zinc-600'} rounded-full`} /> Record</>
              )}
            </button>

            {!isRecording && (
              <button
                className="text-white bg-indigo-600 hover:bg-indigo-700 rounded px-2 py-0.5 flex items-center gap-1 transition-colors"
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
        <div className="flex items-center flex-wrap gap-2 justify-end">
          {/* Connection Type */}
          <div className="flex items-center gap-2 relative">
            {connectionType === 'Remote' ? (
              <div className="flex items-center gap-2 px-3 py-1 bg-blue-500/10 border border-blue-500/20 rounded shadow-sm">
                <Globe className="w-3.5 h-3.5 text-blue-500 animate-pulse" />
                <span className="text-xs font-bold text-blue-500 uppercase tracking-wider">Remote Monitor</span>
                <div className="w-[1px] h-3 bg-blue-500/20 mx-1" />
                <span className="text-[10px] font-mono text-zinc-400 truncate max-w-[120px]">
                  {peerId || remoteDeviceId || 'P2P Session'}
                </span>
                {!connected && (
                  <span className="text-[9px] font-bold text-amber-500 uppercase animate-pulse ml-2">Awaiting Session...</span>
                )}
              </div>
            ) : (
              <>
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
              </>
            )}
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
          ) : connectionType === 'Remote' ? (
             <div className="flex-1" /> // Spacer for remote mode
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
                      const selected = await safeOpen({
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

          {/* Connection Status Label */}
          <div className="flex flex-col">
            <span className={`text-[11px] font-bold truncate max-w-[120px] tracking-tight flex items-center gap-1.5 ${connected ? 'text-green-500' : 'text-zinc-500'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-zinc-500'}`} />
              {connected ? (
                (connectionType === 'Remote' && remoteDeviceId)
                  ? `Remote (${remoteDeviceId})`
                  : (activeProtocol || connectionType)
              ) : 'Disconnected'}
            </span>
            {connected && (activeProtocol === 'Remote' || tabId.startsWith('remote-')) ? (
              <span className="text-[9px] text-blue-500 font-bold uppercase tracking-widest leading-none flex items-center gap-1">
                <Globe className="w-2.5 h-2.5" />
                PEER: {peerId || tabId.split('-')[1] || 'Web'}
              </span>
            ) : (connected && (activeProtocol === 'Serial' || activeProtocol === 'TCP' || activeProtocol === 'SSH')) && (
              <span className="text-[9px] text-zinc-500 font-medium truncate max-w-[100px] leading-none">
                {activeProtocol === 'Serial' ? selectedPort : (activeProtocol === 'TCP' ? '(TCP)' : '(SSH)')}
              </span>
            )}
          </div>

          <div className="w-px h-5 bg-border mx-0.5" />
          
          {connectionType !== 'Remote' && (
            <div className="flex items-center gap-2">
              {!connected ? (
                <button
                  className={`text-white rounded px-2.5 py-0.5 text-xs font-semibold ${isConnecting ? 'bg-zinc-600 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'}`}
                  onClick={handleConnect}
                  disabled={isConnecting || (connectionType === 'Serial' && !selectedPort)}
                >
                  {isConnecting ? 'Connecting...' : 'Connect'}
                </button>
              ) : (
                <button
                  className="bg-red-600 hover:bg-red-700 text-white rounded px-2.5 py-0.5 text-xs font-semibold"
                  onClick={() => handleDisconnect()}
                >
                  Disconnect
                </button>
              )}
            </div>
          )}
          {isSharing && !tabId.startsWith('remote-') && (
            <div className="flex items-center gap-1.5 border-l border-white/10 pl-2 ml-1">
              <span className="text-[9px] font-mono text-blue-500/50 uppercase">Peers: {Object.keys(activePeers).length}</span>
              <button
                onClick={() => {
                  const peers = Object.keys(activePeers);
                  if (peers.length === 1) {
                    handleShareToPeer(peers[0]);
                  } else if (peers.length > 1) {
                    const target = prompt("Enter Peer ID to share with:", peers[0]);
                    if (target) handleShareToPeer(target);
                  }
                }}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded transition-all text-[10px] font-bold uppercase ${Object.keys(activePeers).length > 0
                  ? 'bg-blue-600/20 text-blue-500 border border-blue-500/40 hover:bg-blue-600/30'
                  : 'bg-zinc-800/50 text-zinc-500 border border-zinc-500/20 opacity-50'
                  }`}
                title="Share this terminal tab with a remote peer"
              >
                <MonitorUp className="w-3.5 h-3.5" />
                Share {Object.keys(activePeers).length > 0 && `(${Object.keys(activePeers).length})`}
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 p-2 overflow-hidden">
        <div className="flex h-full gap-0">
          {/* Resizable Sidebar */}
          {isSidebarOpen && (
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
          )}

          {/* Resize Handle */}
          {isSidebarOpen && (
            <div
              className="w-1.5 cursor-col-resize flex items-center justify-center bg-zinc-950 border-l border-r border-zinc-850 hover:bg-zinc-800/40 hover:border-zinc-700 transition-colors relative group"
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
              <div className="w-[1px] h-full bg-zinc-800 group-hover:bg-blue-500/80 transition-colors" />
              <div className="absolute w-1 h-6 bg-zinc-700 group-hover:bg-blue-400 rounded-full opacity-60 transition-colors" />
            </div>
          )}

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
                  onClick={isPlaybackPaused ? resumeRecording : pauseRecording}
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
              isActive={isActive}
              autoScroll={autoScroll}
              setAutoScroll={setAutoScroll}
              onSendCommand={connectionType === 'SSH' ? async (cmd: string) => {
                try {
                  const bytes = Array.from(new TextEncoder().encode(cmd));
                  await safeInvoke("send_ssh_data", { tabId, data: bytes });
                } catch (e) {
                  console.error("Failed to send SSH command:", e);
                }
              } : (connectionType === 'Remote' && remoteChannel) ? async (cmd: string) => {
                try {
                  const bytes = new TextEncoder().encode(cmd);
                  const packet = new Uint8Array([0x01, ...bytes]); // 0x01 = Terminal Data
                  remoteChannel.send(packet);
                  addLog(`Sent remote command: ${cmd.trim()}`);
                } catch (e) {
                  console.error("Failed to send remote data:", e);
                  addLog(`Error sending remote command: ${e}`);
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
          existingGroups={Array.from(new Set(project.send_sequences.map(s => s.group).filter(Boolean))) as string[]}
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
          onDelete={(r: Reaction) => {
            const newReactions = project.reactions.filter((reaction: Reaction) => reaction.id !== r.id);
            setProject({ ...project, reactions: newReactions });
            onProjectNameChange(tabId, project.name);
          }}
        />
      )}
      {/* Bottom Status Bar */}
      <div className="h-6 bg-zinc-950 border-t border-zinc-800 flex items-center justify-between px-3 text-[11px] text-zinc-400 select-none shrink-0 font-sans">
        {/* Left: Connection info */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-semibold">
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className={connected ? 'text-green-500' : 'text-zinc-500'}>
              {connected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
          </div>
          {connected && (
            <>
              <span className="text-zinc-600">|</span>
              <span className="text-zinc-300 font-medium">{activeProtocol || connectionType}</span>
              <span className="text-zinc-500 font-mono">
                {activeProtocol === 'Serial' && `(${selectedPort} @ ${baudRate} bps, ${dataBits}-${parity.substring(0, 1).toUpperCase()}-${stopBits})`}
                {activeProtocol === 'TCP' && `(${tcpHost}:${tcpPort})`}
                {activeProtocol === 'SSH' && `(${sshUsername}@${sshHost}:${sshPort})`}
                {activeProtocol === 'Remote' && `(Remote ID: ${remoteDeviceId || peerId || 'N/A'})`}
              </span>
            </>
          )}
        </div>

        {/* Center: Live Logging / Recording state */}
        <div className="flex items-center gap-2">
          {isLiveLogging && (
            <span className="text-red-400 font-bold bg-red-950/40 border border-red-500/30 px-1.5 py-px rounded-[3px] text-[9px] uppercase tracking-wider">
              ● Live Logging Active
            </span>
          )}
          {isRecording && (
            <span className="text-rose-400 font-bold bg-rose-950/40 border border-rose-500/30 px-1.5 py-px rounded-[3px] text-[9px] uppercase tracking-wider">
              ● Recording Session
            </span>
          )}
        </div>

        {/* Right: Counters */}
        <div className="flex items-center gap-3 font-mono text-[10px] text-zinc-400">
          <div className="flex items-center gap-1">
            <span className="text-zinc-500 font-sans">TX:</span>
            <span className="text-zinc-300 font-bold">{txBytes > 1024 ? `${(txBytes/1024).toFixed(2)} KB` : `${txBytes} B`}</span>
            <span className="text-zinc-600 font-sans">({txPackets})</span>
          </div>
          <span className="text-zinc-700">|</span>
          <div className="flex items-center gap-1">
            <span className="text-zinc-500 font-sans">RX:</span>
            <span className="text-zinc-300 font-bold">{rxBytes > 1024 ? `${(rxBytes/1024).toFixed(2)} KB` : `${rxBytes} B`}</span>
            <span className="text-zinc-600 font-sans">({rxPackets})</span>
          </div>
        </div>
      </div>
    </div>
  );
});

// Wrap App with LicenseProvider

