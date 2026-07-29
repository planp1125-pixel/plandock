import { useState, useEffect, useRef, useCallback, memo } from "react";
import { safeInvoke, safeListen, safeOpen, safeSave, isTauri, safeWriteTextFile } from "../utils/tauri";
import { ProjectSidebar } from "./ProjectSidebar";
import { Terminal, LogEntry } from "./Terminal";
import { VncCanvas } from "./VncCanvas";
import { SequenceEditor } from "./SequenceEditor";
import { ReactionEditor } from "./ReactionEditor";
import { Project, Sequence, Reaction, PortInfo } from "../types";
import { parseData, filterAnsi } from "../utils";
import { RotateCw, Settings, ChevronDown, LineChart as LineChartIcon, Download, FileText, Globe, MonitorUp, PanelLeftClose, PanelLeft, Unplug, VideoOff } from "lucide-react";
import { ChartWindow } from "./ChartWindow";
import { ChartConfig, ChartDataPoint, extractValue } from "../chart_utils";
import { useLicense, FREE_LIMITS } from "../contexts/LicenseContext";
import { handleTerminalExport } from "../utils/export";
import { useRemote } from "../contexts/RemoteContext";

export const Workspace = memo(({ tabId, isActive, darkMode, onConnectionStatusChange, onProjectNameChange, autoScroll, setAutoScroll, remoteChannel, peerId, activePeers: propsActivePeers }: { tabId: string, isActive: boolean, darkMode: boolean, onConnectionStatusChange: (tabId: string, isConnected: boolean, label: string) => void, onProjectNameChange: (tabId: string, name: string) => void, autoScroll: boolean, setAutoScroll: (val: boolean) => void, remoteChannel?: any, peerId?: string, activePeers?: any }) => {
  const { activePeers: contextActivePeers, addLog, isSharing, signaling } = useRemote();
  const activePeers = propsActivePeers || contextActivePeers || {};

  const activePeersRef = useRef(activePeers);
  useEffect(() => {
    activePeersRef.current = activePeers;
  }, [activePeers]);

  const handleShareToPeer = async (peerId: string, retryCount = 0) => {
    try {
      try {
        await safeInvoke("share_active_tab", { tabId, peerId });
      } catch (e: any) {
        if (e && typeof e === 'string' && e.includes('Waiting')) {
          if (retryCount < 20) {
            console.warn(`[Remote] Peer ${peerId} channel not ready, retrying sync in 500ms... (${retryCount + 1}/20)`);
            setTimeout(() => handleShareToPeer(peerId, retryCount + 1), 500);
          } else {
            console.error(`[Remote] Gave up waiting for peer ${peerId} channel state.`);
          }
          return;
        }
        throw e;
      }

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
      console.error(e);
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
  const recordingBufferRef = useRef<string[]>([]);
  const liveLogBufferRef = useRef<string[]>([]);
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

  // Screen Share State
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaPeerRef = useRef<RTCPeerConnection | null>(null);

  // Refs for Chart to access latest state in listeners
  const chartConfigsRef = useRef<ChartConfig[]>(project.chart_configs || []);
  const chartDataQueue = useRef<ChartDataPoint[]>([]);

  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

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
    if (!isTauri()) {
      if (isRecording) {
        setIsRecording(false);
        const selectedPath = await safeSave({
          filters: [{ name: 'Plan Terminal Session', extensions: ['plog'] }],
          title: 'Save Session Recording (.plog)',
          defaultPath: `session_${Date.now()}.plog`
        });
        if (selectedPath) {
          try {
            await safeWriteTextFile(selectedPath as string, recordingBufferRef.current.join("\n") + "\n");
            alert("Session recording saved successfully.");
          } catch (e) {
            alert("Failed to save recording: " + String(e));
          }
        }
        recordingBufferRef.current = [];
      } else {
        recordingBufferRef.current = [];
        setIsRecording(true);
      }
      return;
    }

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
    if (!isTauri()) {
      if (isLiveLogging) {
        setIsLiveLogging(false);
        const path = await safeSave({
          filters: [{ name: 'Log File', extensions: ['txt', 'log', 'csv'] }],
          title: 'Select Log File Location',
          defaultPath: `log_${tabId}_${Date.now()}.txt`
        });
        if (path) {
          try {
            await safeWriteTextFile(path as string, liveLogBufferRef.current.join("\n") + "\n");
            alert("Log file saved successfully.");
          } catch (e) {
            alert("Failed to save log: " + String(e));
          }
        }
        liveLogBufferRef.current = [];
      } else {
        liveLogBufferRef.current = [];
        setIsLiveLogging(true);
      }
      return;
    }

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

        if (!isTauri() && (isRecording || isLiveLogging)) {
          for (const item of batch) {
            if (isRecording) {
              if (recordingBufferRef.current.length >= 100000) {
                setIsRecording(false);
                alert("Recording buffer limit reached (100,000 logs). Recording auto-stopped. Please click the Record button again to save the file.");
              } else {
                const date = new Date(item.ts);
                const timeStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}000`;
                const asciiStr = String.fromCharCode(...item.bytes.map(b => (b >= 32 && b < 127) ? b : 46)).replace(/"/g, '\\"').replace(/\\/g, '\\\\');
                recordingBufferRef.current.push(`{"ts":${item.ts},"time":"${timeStr}","dir":"${item.dir}","data":[${item.bytes.join(',')}],"ascii":"${asciiStr}"}`);
              }
            }

            if (isLiveLogging) {
              if (liveLogBufferRef.current.length >= 100000) {
                setIsLiveLogging(false);
                alert("Live Log buffer limit reached (100,000 logs). Logging auto-stopped.");
              } else {
                const date = new Date(item.ts);
                const timeStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}000`;

                let formattedData = "";
                if (exportAscii) {
                  formattedData = String.fromCharCode(...item.bytes.map(b => (b >= 32 && b < 127) ? b : 46));
                } else {
                  formattedData = item.bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
                }
                liveLogBufferRef.current.push(`[${timeStr}] ${item.dir} ${formattedData}`);
              }
            }
          }
        }

        const gap = Number(localStorage.getItem('terminal-ts-gap') || '500');
        const aggregatedBatch: { bytes: number[], ts: number, dir: string }[] = [];

        for (const item of batch) {
          if (!item || !Array.isArray(item.bytes)) continue;
          if (aggregatedBatch.length > 0) {
            const lastAgg = aggregatedBatch[aggregatedBatch.length - 1];
            if (lastAgg.dir === item.dir && (item.ts - lastAgg.ts) < gap && lastAgg.bytes.length < 8000) {
              for (let i = 0; i < item.bytes.length; i++) {
                lastAgg.bytes.push(item.bytes[i]);
              }
              // Slide timestamp forward for continuous coalescing
              lastAgg.ts = item.ts;
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
              // Slide the timestamp window forward so continuous typing keeps merging
              lastRef.current = { ...last, timestamp: item.ts };
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

  const [connectionType, setConnectionType] = useState<'Serial' | 'TCP' | 'SSH' | 'Terminal' | 'VNC' | 'Remote'>('Serial');

  useEffect(() => {
    // Removed forced 'Remote' connection type
  }, [remoteChannel]);
  const [remoteDeviceId, setRemoteDeviceId] = useState('');

  // --- Screen Sharing Logic ---
  const sendMediaSignal = async (payload: any) => {
    const jsonStr = JSON.stringify(payload);
    if (isTauri()) {
      await safeInvoke('broadcast_media_signal', { signalJson: jsonStr });
    } else {
      if (remoteChannel && remoteChannel.readyState === 'open') {
        const bytes = new TextEncoder().encode(jsonStr);
        const packet = new Uint8Array(2 + bytes.length);
        packet[0] = 0x02; // Control
        packet[1] = 0x14; // Media Signal
        packet.set(bytes, 2);
        remoteChannel.send(packet);
      }
    }
  };

  const setupMediaPeerConnection = () => {
    if (mediaPeerRef.current) {
      mediaPeerRef.current.close();
    }
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendMediaSignal({ type: 'candidate', candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      console.log("[Media] Track received from remote peer:", event.streams);
      if (event.streams && event.streams[0]) {
        mediaStreamRef.current = event.streams[0];
        setIsSharingScreen(true);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
          remoteVideoRef.current.play().catch(e => console.warn("[Media] Play error:", e));
        }
      }
    };

    mediaPeerRef.current = pc;
    return pc;
  };

  const mediaPendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  const handleMediaSignal = async (payloadStr: string) => {
    try {
      const signal = JSON.parse(payloadStr);
      if (signal.type === 'stop') {
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        if (mediaPeerRef.current) {
          mediaPeerRef.current.close();
          mediaPeerRef.current = null;
        }
        setIsSharingScreen(false);
        mediaPendingCandidatesRef.current = [];
        return;
      }

      let pc = mediaPeerRef.current;

      if (signal.type === 'offer') {
        setIsSharingScreen(true);
        pc = setupMediaPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendMediaSignal({ type: 'answer', sdp: answer.sdp });

        // Process queued candidates
        for (const cand of mediaPendingCandidatesRef.current) {
          await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.error(e));
        }
        mediaPendingCandidatesRef.current = [];
      } else if (signal.type === 'answer') {
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
          // Process queued candidates
          for (const cand of mediaPendingCandidatesRef.current) {
            await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.error(e));
          }
          mediaPendingCandidatesRef.current = [];
        }
      } else if (signal.type === 'candidate') {
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(e => console.error(e));
        } else {
          console.log("[Media] Queuing ICE candidate for video stream");
          mediaPendingCandidatesRef.current.push(signal.candidate);
        }
      }
    } catch (e) {
      console.error("Failed to handle media signal", e);
    }
  };
  // --- End Screen Sharing Logic ---

  // Handle Remote DataChannel
  useEffect(() => {
    if (!remoteChannel) return;

    if (remoteChannel.readyState === 'open') {
      // Just visually indicate WebRTC is ready, but wait for Host sync to set `connected`
      // We can request port list here
      const reqPorts = new Uint8Array([0x02, 0x0E]); // Request Port List
      if (typeof remoteChannel.send === 'function') {
        remoteChannel.send(reqPorts);
      }
    } else {
      remoteChannel.onopen = () => {
        const reqPorts = new Uint8Array([0x02, 0x0E]); // Request Port List
        if (typeof remoteChannel.send === 'function') {
          remoteChannel.send(reqPorts);
        }
      };
    }

    remoteChannel.onmessage = (e: any) => {
      const data = e.data as ArrayBuffer;
      const bytes = Array.from(new Uint8Array(data));
      const type = bytes[0];

      console.log(`[Remote] Msg Type: 0x${type.toString(16)}, Sub: 0x${bytes[1]?.toString(16)}`);

      if (type === 0x06) {
        // VNC RFB Stream (0x06): [0x06, Dir(0=RX, 1=TX), ...bytes]
        const payloadBytes = bytes.slice(2);
        window.dispatchEvent(new CustomEvent('vnc-remote-bytes', { detail: payloadBytes }));
      } else if (type === 0x01 || type === 0x03) {
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
              isIncomingSyncRef.current = true; // prevent reflection loop
              setProject(syncData.project);
              if (syncData.connectionType) {
                setConnectionType(syncData.connectionType);
                setRemoteDeviceId(syncData.deviceName || 'Remote Host');
              }
              if (typeof syncData.connected === 'boolean') {
                setConnected(syncData.connected);
                if (syncData.connected) {
                  onConnectionStatusChange(tabId, true, syncData.connectionType === "Serial" ? syncData.project.serial_config?.port_name : "Connected");
                } else {
                  onConnectionStatusChange(tabId, false, "Disconnected");
                }
              }
              if (syncData.ports) {
                setPorts(syncData.ports);
              }
              addLog("Host state mirrored.");
            }
          } catch (e) {
            console.error("Failed to parse project sync:", e);
          }
        } else if (bytes[1] === 0x0B) {
          // Connect Success from Host
          try {
            const configStr = new TextDecoder().decode(new Uint8Array(bytes.slice(2)));
            const config = JSON.parse(configStr);
            setConnected(true);
            setIsConnecting(false);
            setActiveProtocol(config.protocol || "Serial");
            onConnectionStatusChange(
              tabId,
              true,
              config.protocol === "Serial" ? (config.portName || "Serial") :
                config.protocol === "TCP" ? (config.tcpMode === 'server' ? `Listening on ${config.tcpPort}` : config.tcpHost) :
                  config.sshHost || "Connected"
            );
            addLog(`Hardware connected via ${config.protocol || 'Serial'}.`);
          } catch (e) {
            console.error("Failed to parse connect success:", e);
          }
        } else if (bytes[1] === 0x0D) {
          // Connect Error from Host
          try {
            const errStr = new TextDecoder().decode(new Uint8Array(bytes.slice(2)));
            alert("Hardware Connection Failed on Host:\n" + errStr);
            setConnected(false);
            setIsConnecting(false);
            setActiveProtocol(null);
            onConnectionStatusChange(tabId, false, "Disconnected");
            addLog(`Hardware connection failed: ${errStr}`);
          } catch (e) {
            console.error("Failed to parse connect error:", e);
          }
        } else if (bytes[1] === 0x10) {
          // State Sync (Host -> Viewer)
          try {
            const payloadStr = new TextDecoder().decode(new Uint8Array(bytes.slice(2)));
            const state = JSON.parse(payloadStr);
            applyRemoteStateSync(state);
          } catch (err) {
            console.error("Failed to parse state sync:", err);
          }
        } else if (bytes[1] === 0x12) {
          // Recording Sync
          try {
            const payloadStr = new TextDecoder().decode(new Uint8Array(bytes.slice(2)));
            const recState = JSON.parse(payloadStr);
            if (typeof recState.isRecording === 'boolean') {
              setIsRecording(recState.isRecording);
            }
          } catch (err) {
            console.error("Failed to parse recording sync:", err);
          }
        } else if (bytes[1] === 0x14) {
          // Media Signal (Video)
          try {
            const payloadStr = new TextDecoder().decode(new Uint8Array(bytes.slice(2)));
            handleMediaSignal(payloadStr);
          } catch (e) {
            console.error("Failed to parse media signal:", e);
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
  const [tcpMode, setTcpMode] = useState<'client' | 'server'>('client');
  const [sshHost, setSshHost] = useState('192.168.1.100');
  const [sshPort, setSshPort] = useState(22);
  const [sshUsername, setSshUsername] = useState('pi');
  const [sshAuthMode, setSshAuthMode] = useState<'password' | 'private_key'>('password');
  const [sshAuthSecret, setSshAuthSecret] = useState('');
  const [shellCmd, setShellCmd] = useState('Auto');
  const [vncHost, setVncHost] = useState('127.0.0.1');
  const [vncPort, setVncPort] = useState(5900);
  const [vncPassword, setVncPassword] = useState('');

  const tcpStateRef = useRef({ type: connectionType, mode: tcpMode, port: tcpPort });

  const isApplyingRemoteSyncRef = useRef(false);

  const applyRemoteStateSync = useCallback((state: any) => {
    isApplyingRemoteSyncRef.current = true;
    if (state.protocol) {
      setConnectionType(state.protocol);
      setProject(p => ({ ...p, connection_type: state.protocol }));
    }
    if (state.activeProtocol !== undefined) setActiveProtocol(state.activeProtocol);
    if (state.portName !== undefined) setSelectedPort(state.portName);
    if (state.baudRate !== undefined) setBaudRate(Number(state.baudRate));
    if (state.dataBits !== undefined) setDataBits(Number(state.dataBits));
    if (state.stopBits !== undefined) setStopBits(Number(state.stopBits));
    if (state.parity !== undefined) setParity(state.parity);
    if (state.flowControl !== undefined) setFlowControl(state.flowControl);
    if (state.tcpHost !== undefined) setTcpHost(state.tcpHost);
    if (state.tcpPort !== undefined) setTcpPort(Number(state.tcpPort));
    if (state.tcpMode !== undefined) setTcpMode(state.tcpMode);
    if (state.sshHost !== undefined) setSshHost(state.sshHost);
    if (state.sshPort !== undefined) setSshPort(Number(state.sshPort));
    if (state.sshUsername !== undefined) setSshUsername(state.sshUsername);
    if (state.sshAuthMode !== undefined) setSshAuthMode(state.sshAuthMode);
    if (state.sshAuthSecret !== undefined) setSshAuthSecret(state.sshAuthSecret);
    if (typeof state.isRecording === 'boolean') setIsRecording(state.isRecording);
    if (typeof state.connected === 'boolean') {
      setConnected(state.connected);
      onConnectionStatusChange(
        tabId,
        state.connected,
        state.protocol === "Serial" ? (state.portName || "Serial") :
          state.protocol === "TCP" ? (state.tcpMode === 'server' ? `Listening on ${state.tcpPort}` : state.tcpHost) :
            state.protocol === "SSH" ? state.sshHost : "Remote"
      );
    }

    if (state.editingSeqId !== undefined) {
      if (state.editingSeqId === null) {
        setEditingSeq(null);
      } else if (projectRef.current) {
        const found = projectRef.current.send_sequences.find((s: Sequence) => s.id === state.editingSeqId);
        if (found) setEditingSeq(found);
      }
    }
    if (state.editingReactionId !== undefined) {
      if (state.editingReactionId === null) {
        setEditingReaction(null);
      } else if (projectRef.current) {
        const found = projectRef.current.reactions.find((r: Reaction) => r.id === state.editingReactionId);
        if (found) setEditingReaction(found);
      }
    }

    setTimeout(() => {
      isApplyingRemoteSyncRef.current = false;
    }, 150);
  }, [tabId, onConnectionStatusChange]);

  const broadcastHostStateRef = useRef<() => void>(() => { });

  const broadcastHostState = useCallback((overrideState?: Record<string, any>) => {
    if (isApplyingRemoteSyncRef.current) return;
    const stateObj = {
      connected,
      protocol: connectionType,
      activeProtocol,
      portName: selectedPort,
      baudRate,
      dataBits,
      stopBits,
      parity,
      flowControl,
      tcpHost,
      tcpPort,
      tcpMode,
      sshHost,
      sshPort,
      sshUsername,
      sshAuthMode,
      sshAuthSecret,
      isRecording,
      editingSeqId: editingSeq ? editingSeq.id : null,
      editingReactionId: editingReaction ? editingReaction.id : null,
      ...overrideState
    };

    if (isTauri()) {
      safeInvoke("broadcast_state_sync", { stateJson: JSON.stringify(stateObj) }).catch(() => { });
    } else if (remoteChannel && remoteChannel.readyState === 'open') {
      const jsonBytes = new TextEncoder().encode(JSON.stringify(stateObj));
      const payload = new Uint8Array(2 + jsonBytes.length);
      payload[0] = 0x02; // Control
      payload[1] = 0x10; // State Sync
      payload.set(jsonBytes, 2);
      if (typeof remoteChannel.send === 'function') {
        remoteChannel.send(payload);
      }
    }
  }, [connected, connectionType, activeProtocol, selectedPort, baudRate, dataBits, stopBits, parity, flowControl, tcpHost, tcpPort, tcpMode, sshHost, sshPort, sshUsername, sshAuthMode, sshAuthSecret, isRecording, remoteChannel]);

  useEffect(() => {
    broadcastHostStateRef.current = broadcastHostState;
  }, [broadcastHostState]);

  useEffect(() => {
    broadcastHostState();
  }, [connected, activeProtocol, connectionType, selectedPort, baudRate, dataBits, stopBits, parity, flowControl, tcpHost, tcpPort, tcpMode, sshHost, sshPort, sshUsername, sshAuthMode, sshAuthSecret, isRecording, broadcastHostState]);

  useEffect(() => {
    tcpStateRef.current = { type: connectionType, mode: tcpMode, port: tcpPort };
  }, [connectionType, tcpMode, tcpPort]);

  // Update connection fields when project loads (e.g. from .plant files)
  useEffect(() => {
    if (project.connection_type) {
      setConnectionType(project.connection_type);
    }

    if (project.tcp_config) {
      setTcpHost(project.tcp_config.host);
      setTcpPort(project.tcp_config.port);
      if (project.tcp_config.mode) setTcpMode(project.tcp_config.mode);
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
      const st = tcpStateRef.current;
      if (st.type === 'TCP' && st.mode === 'server') {
        // Auto-resume listening UI state
        onConnectionStatusChange(tabId, true, `Listening on ${st.port}`);
      } else {
        setConnected(false); onConnectionStatusChange(tabId, false, '');
        alert("TCP Connection closed by remote host or error occurred.");
      }
    });

    const unlistenTcpClientConnected = safeListen<string>('tcp-client-connected', (event) => {
      if (event.payload !== tabId) return;
      setConnected(true);
      onConnectionStatusChange(tabId, true, "Client Connected");
    });

    const unlistenSshDisconnect = safeListen<string>('ssh-disconnected', (event) => {
      if (event.payload !== tabId) return;
      setConnected(false); onConnectionStatusChange(tabId, false, '');
      alert("SSH Connection closed.");
    });

    const unlistenTrigger = safeListen<[string, string, number[]]>('remote-sequence-trigger', (event) => {
      const [, , bytes] = event.payload;
      // bytes is [0x05, ...seq_id] from Rust handle_control_message
      if (bytes.length > 1) {
        const seqId = new TextDecoder().decode(new Uint8Array(bytes.slice(1)));
        const seqToRun = projectRef.current.send_sequences.find(s => s.id === seqId);
        if (seqToRun) {
          addLog(`Remote Trigger: Executing sequence '${seqToRun.name}'`);
          handleSend(seqToRun);
        }
      }
    });

    const unlistenSync = safeListen<[string, string, number[]]>('remote-project-sync', (event) => {
      const [, , bytes] = event.payload;
      try {
        // bytes is [0x04, ...json] from Rust handle_control_message
        const payload = new TextDecoder().decode(new Uint8Array(bytes.slice(1)));
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

    const unlistenStateSync = safeListen<any>('remote-state-sync', (event) => {
      try {
        const payloadStr = new TextDecoder().decode(new Uint8Array(event.payload[2].slice(1)));
        const state = JSON.parse(payloadStr);
        applyRemoteStateSync(state);
      } catch (e) {
        console.error("Failed to parse remote-state-sync:", e);
      }
    });

    const unlistenConnectApplied = safeListen<any>('remote-connect-applied', (event) => {
      const config = event.payload;
      if (config) {
        if (config.protocol) setConnectionType(config.protocol);
        if (config.portName) setSelectedPort(config.portName);
        if (config.baudRate) setBaudRate(config.baudRate);
        if (config.tcpHost) setTcpHost(config.tcpHost);
        if (config.tcpPort) setTcpPort(config.tcpPort);
        if (config.tcpMode) setTcpMode(config.tcpMode);
        if (config.sshHost) setSshHost(config.sshHost);
        if (config.sshPort) setSshPort(config.sshPort);
        if (config.sshUsername) setSshUsername(config.sshUsername);
        setConnected(true);
        setIsConnecting(false);
        setActiveProtocol(config.protocol || "Serial");
        onConnectionStatusChange(tabId, true, config.protocol === "Serial" ? config.portName : config.protocol === "TCP" ? (config.tcpMode === 'server' ? `Listening on ${config.tcpPort}` : config.tcpHost) : config.sshHost);
        setTimeout(() => {
          broadcastHostStateRef.current();
        }, 100);
      }
    });

    const unlistenConnectFailed = safeListen<string>('remote-connect-failed', (event) => {
      alert("Hardware connection failed on Host: " + event.payload);
      setConnected(false);
      setIsConnecting(false);
      setActiveProtocol(null);
      onConnectionStatusChange(tabId, false, "Disconnected");
      setTimeout(() => {
        broadcastHostStateRef.current();
      }, 100);
    });

    const unlistenDisconnectApplied = safeListen<void>('remote-disconnect-applied', () => {
      setConnected(false);
      setIsConnecting(false);
      setActiveProtocol(null);
      onConnectionStatusChange(tabId, false, "Disconnected");
      setTimeout(() => {
        broadcastHostStateRef.current();
      }, 100);
    });

    const unlistenChannelOpen = safeListen<any>('remote-channel-open', () => {
      if (isTauri()) {
        setTimeout(() => {
          broadcastHostStateRef.current();
        }, 200);
      }
    });

    const unlistenParsedProject = safeListen<[string, Project]>('remote-parsed-project', (event) => {
      const [, parsedProject] = event.payload;
      // Auto-fix legacy default names
      if (parsedProject.name === "Untitled Project" || parsedProject.name === "New Project") {
        parsedProject.name = "Plan Terminal";
      }
      setProject(parsedProject);
    });

    const unlistenMediaSignal = safeListen<any>('remote-media-signal', () => {});

    // Listen for remote project sync from Rust (Viewer -> Host)
    const unlistenProjectSync = safeListen<any>('remote-project-sync', (event) => {
      try {
        const payloadStr = new TextDecoder().decode(new Uint8Array(event.payload[2].slice(1)));
        const syncData = JSON.parse(payloadStr);
        if (syncData.type === "PROJECT_SYNC" && syncData.project) {
          isIncomingSyncRef.current = true;
          setProject(syncData.project);
          if (syncData.connectionType) setConnectionType(syncData.connectionType);
          if (typeof syncData.connected === 'boolean') setConnected(syncData.connected);
          addLog("Remote sequence/project update synchronized.");
        }
      } catch (e) {
        console.error("Failed to parse remote project sync:", e);
      }
    });

    return () => {
      unlistenData.then(f => f());
      unlistenTcpDisconnect.then(f => f());
      unlistenTcpClientConnected.then(f => f());
      unlistenSshDisconnect.then(f => f());
      unlistenPlaybackStart.then(f => f());
      unlistenPlaybackEnded.then(f => f());
      unlistenTrigger.then(f => f());
      unlistenSync.then(f => f());
      unlistenStateSync.then(f => f());
      unlistenConnectApplied.then(f => f());
      unlistenConnectFailed.then(f => f());
      unlistenDisconnectApplied.then(f => f());
      unlistenChannelOpen.then(f => f());
      unlistenParsedProject.then(f => f());
      unlistenMediaSignal.then(f => f());
      unlistenProjectSync.then(f => f());
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

    // Listen for remote port requests
    const unlistenPortsReq = safeListen("remote-request-ports", () => {
      refreshPorts();
    });

    return () => {
      window.removeEventListener('trigger-tab-share', handleTrigger);
      unlistenPortsReq.then(f => f());
    };
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
      connected: connected,
      ports: ports,
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
    } else if (isTauri() && activePeers && Object.keys(activePeers).length > 0) {
      // Host broadcasting state to all peers
      Object.keys(activePeers).forEach(pid => {
        safeInvoke('send_remote_data', { peerId: pid, label: 'serial-bridge', data: Array.from(payload) })
          .catch(e => console.error("Sync failed:", e));
      });
    }
  }, [project, connectionType, connected, ports, activePeers]);

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
          .catch(() => { });
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
        const payload = new Uint8Array(2 + bytes.length);
        payload[0] = connectionType === 'SSH' ? 0x03 : 0x01; // Data Type
        payload[1] = 0x01; // Direction: TX (1)
        payload.set(bytes, 2);
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
      } else if (connectionType === 'Terminal') {
        const shellBytes = [...bytes];
        if (shellBytes.length > 0 && shellBytes[shellBytes.length - 1] !== 10 && shellBytes[shellBytes.length - 1] !== 13) {
          shellBytes.push(10); // Append LF (\n)
        }
        await safeInvoke("send_local_shell_data", { tabId, data: shellBytes });
      }
    } catch (e) {
      console.error("[Send] Send failed:", e);
    }
  };

  const handleSendRawKey = async (keyStr: string) => {
    const bytes = Array.from(new TextEncoder().encode(keyStr));
    try {
      if (!isTauri() && remoteChannel) {
        const payload = new Uint8Array(2 + bytes.length);
        payload[0] = connectionType === 'SSH' ? 0x03 : (connectionType === 'Terminal' ? 0x05 : 0x01);
        payload[1] = 0x01; // Direction: TX
        payload.set(bytes, 2);
        if (typeof remoteChannel.send === 'function') {
          remoteChannel.send(payload);
        }
        return;
      }

      if (remoteChannel) {
        const payload = new Uint8Array(2 + bytes.length);
        payload[0] = connectionType === 'SSH' ? 0x03 : (connectionType === 'Terminal' ? 0x05 : 0x01);
        payload[1] = 0x01; // Direction: TX
        payload.set(bytes, 2);
        if (typeof remoteChannel.send === 'function') {
          remoteChannel.send(payload);
        } else {
          await safeInvoke('send_remote_data', { peerId, label: remoteChannel.label, data: Array.from(payload) });
        }
        incomingQueue.current.push({ bytes, ts: Date.now(), dir: "TX" });
      } else if (connectionType === 'Terminal') {
        await safeInvoke("send_local_shell_data", { tabId, data: bytes });
      } else if (connectionType === 'SSH') {
        await safeInvoke("send_ssh_data", { tabId, data: bytes });
      } else if (connectionType === 'Serial') {
        await safeInvoke("send_serial_data", { tabId, data: bytes });
      } else if (connectionType === 'TCP') {
        await safeInvoke("send_tcp_data", { tabId, data: bytes });
      }
    } catch (e) {
      console.error("[RawKey] Send failed:", e);
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
      let portToConnect = selectedPort;
      if (protocol === "Serial" && !portToConnect && ports.length > 0) {
        portToConnect = (ports[0] as any).port_name || (ports[0] as any).name || "";
        setSelectedPort(portToConnect);
      }

      if (!isTauri() && remoteChannel) {
        if (protocol === "Serial" && !portToConnect) {
          alert("Connection Failed: No serial port selected or available on host.");
          setIsConnecting(false);
          return;
        }
        // Send Connect request over WebRTC
        const config = {
          protocol,
          portName: portToConnect,
          baudRate,
          dataBits,
          flowControl,
          parity,
          stopBits,
          tcpHost,
          tcpPort,
          tcpMode,
          sshHost,
          sshPort,
          sshUsername,
          sshAuthMode,
          sshAuthSecret,
          shellCmd,
          vncHost: vncHost || "127.0.0.1",
          vncPort: vncPort || 5900,
          vncPassword
        };
        const configBytes = new TextEncoder().encode(JSON.stringify(config));
        const payload = new Uint8Array(2 + configBytes.length);
        payload[0] = 0x02; // Control
        payload[1] = 0x0B; // Request Connect
        payload.set(configBytes, 2);

        if (typeof remoteChannel.send === 'function') {
          remoteChannel.send(payload);
        }
      } else {
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
          if (tcpMode === 'server') {
            await safeInvoke("listen_tcp", {
              tabId,
              host: tcpHost || "0.0.0.0",
              port: tcpPort
            });
          } else {
            await safeInvoke("connect_tcp", {
              tabId,
              host: tcpHost,
              port: tcpPort
            });
          }
        } else if (protocol === "SSH") {
          await safeInvoke("connect_ssh", {
            tabId,
            host: sshHost,
            port: sshPort,
            user: sshUsername,
            authMode: sshAuthMode,
            authSecret: sshAuthSecret
          });
        } else if (protocol === "Terminal") {
          await safeInvoke("open_local_shell", {
            tabId,
            requestedShell: shellCmd
          });
        } else if (protocol === "VNC") {
          // VncCanvas component manages socket open on mount to prevent handshake drop
        } else if (protocol === "Remote") {
          await safeInvoke("connect_remote", { tabId, deviceId: remoteDeviceId });
        }
      }

      setActiveProtocol(protocol);
      setConnected(true);
      onConnectionStatusChange(tabId, true, protocol === "Serial" ? selectedPort : protocol === "TCP" ? (tcpMode === 'server' ? `Listening on ${tcpPort}` : tcpHost) : protocol === "SSH" ? sshHost : protocol === "Terminal" ? "Local Terminal" : protocol === "VNC" ? `VNC (${vncHost}:${vncPort})` : "Remote");
    } catch (e) {
      console.error(e);
      alert("Connection failed: " + e);
      setConnected(false);
      onConnectionStatusChange(tabId, false, '');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      const protocolToDisconnect = activeProtocol || connectionType || "Serial";

      if (!isTauri() && remoteChannel) {
        // Send Disconnect request over WebRTC
        const payload = new Uint8Array([0x02, 0x0C]); // Control -> Request Disconnect
        if (typeof remoteChannel.send === 'function') {
          remoteChannel.send(payload);
        }
      } else {
        await safeInvoke("stop_all_periodic_sequences", { tabId, connType: protocolToDisconnect });

        if (protocolToDisconnect === "Serial") {
          await safeInvoke("close_serial_port", { tabId });
        } else if (protocolToDisconnect === "TCP") {
          await safeInvoke("disconnect_tcp", { tabId });
        } else if (protocolToDisconnect === "SSH") {
          await safeInvoke("disconnect_ssh", { tabId });
        } else if (protocolToDisconnect === "Terminal") {
          await safeInvoke("disconnect_local_shell", { tabId });
        } else if (protocolToDisconnect === "VNC") {
          await safeInvoke("disconnect_vnc", { tabId });
        } else if (protocolToDisconnect === "Remote") {
          if (remoteChannel && remoteChannel.close) {
            remoteChannel.close();
          }
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

            {/* Remote Tab Indicator */}
            {(!isTauri() || remoteChannel) && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-500/10 border border-blue-500/20 rounded-md shadow-sm">
                <Globe className="w-3.5 h-3.5 text-blue-500 animate-pulse" />
                <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">Remote Session</span>
              </div>
            )}
          </div>
        </div>

        {/* Connection Settings */}
        <div className="flex items-center flex-wrap gap-2 justify-end">
          {/* Connection Type */}
          <div className="flex items-center gap-2 relative">
            {(!isTauri() || remoteChannel) && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded shadow-sm mr-1">
                <Globe className="w-3.5 h-3.5 text-blue-500 animate-pulse" />
                <span className="text-[10px] font-bold text-blue-500 uppercase tracking-wider">Remote</span>
              </div>
            )}
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
                onChange={(e) => {
                  const newType = e.target.value as 'Serial' | 'TCP' | 'SSH';
                  setConnectionType(newType);
                  setProject(prev => ({ ...prev, connection_type: newType }));
                  broadcastHostState({ protocol: newType });
                }}
                disabled={connected}
              >
                <option value="Serial">Serial</option>
                <option value="TCP">TCP</option>
                <option value="SSH">SSH</option>
                <option value="Terminal">Local Shell</option>
                <option value="VNC">VNC (Remote Desktop)</option>
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none opacity-50" style={{ color: 'hsl(var(--foreground))' }} />
            </>
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
                  onChange={e => {
                    setSelectedPort(e.target.value);
                    broadcastHostState({ portName: e.target.value });
                  }}
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
                  onChange={e => {
                    const val = Number(e.target.value);
                    setBaudRate(val);
                    broadcastHostState({ baudRate: val });
                  }}
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
                            value={dataBits}
                            onChange={e => {
                              const val = Number(e.target.value);
                              setDataBits(val);
                              broadcastHostState({ dataBits: val });
                            }}
                            disabled={connected}>
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
                            value={stopBits}
                            onChange={e => {
                              const val = Number(e.target.value);
                              setStopBits(val);
                              broadcastHostState({ stopBits: val });
                            }}
                            disabled={connected}>
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
                            value={parity}
                            onChange={e => {
                              const val = e.target.value;
                              setParity(val);
                              broadcastHostState({ parity: val });
                            }}
                            disabled={connected}>
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
                            value={flowControl}
                            onChange={e => {
                              const val = e.target.value;
                              setFlowControl(val);
                              broadcastHostState({ flowControl: val });
                            }}
                            disabled={connected}>
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
              <select
                className="w-24 rounded px-2 py-1 text-sm outline-none border focus:ring-1 focus:ring-zinc-500 cursor-pointer"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                value={tcpMode}
                onChange={(e) => {
                  const mode = e.target.value as 'client' | 'server';
                  setTcpMode(mode);
                  broadcastHostState({ tcpMode: mode });
                }}
                disabled={connected}
              >
                <option value="client">Client</option>
                <option value="server">Server</option>
              </select>
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
                onChange={(e) => {
                  setTcpHost(e.target.value);
                  broadcastHostState({ tcpHost: e.target.value });
                }}
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
                onChange={(e) => {
                  const port = Number(e.target.value);
                  setTcpPort(port);
                  broadcastHostState({ tcpPort: port });
                }}
                disabled={connected}
              />
            </>
          ) : connectionType === 'Remote' ? (
            <div className="flex-1" /> // Spacer for remote mode
          ) : connectionType === 'SSH' ? (
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
                onChange={(e) => {
                  setSshUsername(e.target.value);
                  broadcastHostState({ sshUsername: e.target.value });
                }}
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
                onChange={(e) => {
                  setSshHost(e.target.value);
                  broadcastHostState({ sshHost: e.target.value });
                }}
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
                onChange={(e) => {
                  const port = Number(e.target.value);
                  setSshPort(port);
                  broadcastHostState({ sshPort: port });
                }}
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
                onChange={(e) => {
                  const mode = e.target.value as 'password' | 'private_key';
                  setSshAuthMode(mode);
                  broadcastHostState({ sshAuthMode: mode });
                }}
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
          ) : connectionType === 'Terminal' ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-400 font-semibold select-none">Shell:</span>
              <select
                className="w-28 rounded px-2 py-1 text-sm outline-none border focus:ring-1 focus:ring-zinc-500 cursor-pointer"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                value={shellCmd}
                onChange={(e) => setShellCmd(e.target.value)}
                disabled={connected}
              >
                <option value="Auto">Auto (Default Shell)</option>
                <option value="/bin/bash">Linux: bash</option>
                <option value="/bin/zsh">macOS / Linux: zsh</option>
                <option value="powershell.exe">Windows: PowerShell</option>
                <option value="cmd.exe">Windows: CMD</option>
              </select>
            </div>
          ) : connectionType === 'VNC' ? (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-zinc-400 font-semibold select-none">Host:</span>
              <input
                type="text"
                className="w-28 rounded px-2 py-1 outline-none border focus:ring-1 focus:ring-zinc-500"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                value={vncHost}
                onChange={(e) => setVncHost(e.target.value)}
                disabled={connected}
                placeholder="127.0.0.1"
              />
              <span className="text-zinc-400 font-semibold select-none">:</span>
              <input
                type="number"
                className="w-16 rounded px-2 py-1 outline-none border focus:ring-1 focus:ring-zinc-500"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                value={vncPort}
                onChange={(e) => setVncPort(Number(e.target.value))}
                disabled={connected}
                placeholder="5900"
              />
              <span className="text-zinc-400 font-semibold select-none">Pass:</span>
              <input
                type="password"
                className="w-24 rounded px-2 py-1 outline-none border focus:ring-1 focus:ring-zinc-500"
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                value={vncPassword}
                onChange={(e) => setVncPassword(e.target.value)}
                disabled={connected}
                placeholder="Optional"
              />
            </div>
          ) : null}

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
                  {isConnecting ? (connectionType === 'TCP' && tcpMode === 'server' ? 'Listening...' : 'Connecting...') : (connectionType === 'TCP' && tcpMode === 'server' ? 'Listen' : 'Connect')}
                </button>
              ) : (
                <button
                  className="bg-red-600 hover:bg-red-700 text-white rounded px-3 py-1 text-xs font-bold shadow-md flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer"
                  onClick={() => handleDisconnect()}
                  title="Disconnect active connection or remote session"
                >
                  <Unplug className="w-3.5 h-3.5" />
                  Disconnect Session
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

      <main className="flex-1 p-2 overflow-hidden relative">
        {/* Web Viewer Connect Overlay */}
        {!isTauri() && !connected && !remoteChannel && tabId.startsWith('remote-') && (
          <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col items-center justify-center p-4">
            <div className="bg-card p-6 rounded-lg border shadow-xl flex flex-col items-center text-center gap-4 max-w-md w-full animate-in zoom-in-95 duration-200">
              <Globe className="w-12 h-12 text-blue-500 animate-pulse" />
              <div>
                <h3 className="text-lg font-bold text-foreground">Remote Connection</h3>
                <p className="text-sm text-zinc-400 mt-1">
                  Ready to connect to Host Device ID: <span className="font-mono text-blue-400 font-bold">{new URLSearchParams(window.location.search).get('id') || 'Unknown'}</span>
                </p>
              </div>

              {/* Security ID Verification Display */}
              <div className="w-full bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 text-left">
                <div className="text-[11px] font-bold text-blue-400 uppercase tracking-wider mb-1">Your Request ID (Security Verification):</div>
                <div className="text-sm font-mono font-bold text-zinc-200 bg-black/50 px-2.5 py-1.5 rounded border border-blue-500/20 text-center select-all">
                  {signaling?.myId || remoteDeviceId || 'Generating ID...'}
                </div>
                <div className="text-[10px] text-zinc-400 mt-1">
                  Tell the host user this Request ID over phone/chat so they can verify and accept your request before connecting.
                </div>
              </div>

              <button
                onClick={() => {
                  if (signaling) {
                    const targetId = new URLSearchParams(window.location.search).get('id');
                    if (targetId) {
                      setIsConnecting(true);
                      console.log("[Workspace] Connecting to targetId:", targetId, "via signaling instance:", signaling);
                      signaling.connectTo(targetId).then(() => {
                        console.log("[Workspace] connectTo returned successfully. Waiting for DataChannel to open.");
                      }).catch(e => {
                        console.error("[Workspace] connectTo error:", e);
                        alert("Connection failed: " + (e.message || e));
                        setIsConnecting(false);
                      });
                    } else {
                      alert("Target ID not found in URL!");
                    }
                  } else {
                    alert("Signaling not ready yet. Please wait a moment.");
                  }
                }}
                disabled={isConnecting}
                className={`w-full font-bold py-2.5 px-4 rounded shadow-md transition-all active:scale-95 cursor-pointer ${isConnecting ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}
              >
                {isConnecting ? 'Requesting Connection...' : 'Connect to Host'}
              </button>
            </div>
          </div>
        )}

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
                  tcp_config: { host: tcpHost, port: tcpPort, mode: tcpMode },
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
                onEditSequence={(seq) => {
                  setEditingSeq(seq);
                  broadcastHostState({ editingSeqId: seq ? seq.id : null });
                }}
                onEditReaction={(r) => {
                  setEditingReaction(r);
                  broadcastHostState({ editingReactionId: r ? r.id : null });
                }}
                connected={connected}
                activePeriodicIds={activePeriodicIds}
                onStartPeriodic={startPeriodic}
                onStopPeriodic={stopPeriodic}
                onRemoteParseRequest={(ext, content) => {
                  if (remoteChannel && typeof remoteChannel.send === 'function') {
                    const reqBytes = new TextEncoder().encode(JSON.stringify({ ext, content }));
                    const payload = new Uint8Array(2 + reqBytes.length);
                    payload[0] = 0x02; // Control
                    payload[1] = 0x0F; // Parse Project Request
                    payload.set(reqBytes, 2);
                    remoteChannel.send(payload);
                  }
                }}
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
            {/* Screen Share Video Overlay */}
            {isSharingScreen && (
              <div className="absolute top-10 right-4 z-40 bg-black/90 rounded-lg overflow-hidden border border-zinc-700 shadow-2xl group flex flex-col" style={{ width: '450px', maxWidth: '90%' }}>
                <div className="bg-zinc-800/90 backdrop-blur px-3 py-1.5 text-xs text-zinc-200 font-bold flex justify-between items-center border-b border-zinc-700">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    <span>{isTauri() ? "Screen Share Preview" : "Live Host Screen Share"}</span>
                  </div>
                  <button
                    onClick={() => setIsSharingScreen(false)}
                    className="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-[10px] font-bold uppercase tracking-wider transition-colors flex items-center gap-1 cursor-pointer shadow-sm"
                    title="Disconnect Screen Sharing"
                  >
                    <VideoOff className="w-3.5 h-3.5" />
                    Disconnect Screen
                  </button>
                </div>
                <video
                  ref={(el) => {
                    if (isTauri()) {
                      (localVideoRef as any).current = el;
                    } else {
                      (remoteVideoRef as any).current = el;
                    }
                    if (el && mediaStreamRef.current) {
                      el.srcObject = mediaStreamRef.current;
                      el.play().catch(() => {});
                    }
                  }}
                  autoPlay
                  playsInline
                  muted={isTauri()}
                  className="w-full h-auto object-contain bg-black"
                />
              </div>
            )}

            {connectionType === 'VNC' ? (
              <VncCanvas
                tabId={tabId}
                host={vncHost}
                port={vncPort}
                password={vncPassword}
                isActive={isActive}
                connected={connected}
                remoteChannel={remoteChannel}
                peerId={peerId}
                onDisconnect={handleDisconnect}
              />
            ) : (
              <Terminal
                logs={logs}
                onClear={() => setLogs([])}
                onSendRawKey={handleSendRawKey}
                isActive={isActive}
                autoScroll={autoScroll}
                setAutoScroll={setAutoScroll}
                onSendCommand={async (cmd: string) => {
                  try {
                    if (!isTauri() && remoteChannel) {
                      const isSsh = connectionType === 'SSH';
                      const isTcp = connectionType === 'TCP';
                      const suffix = isSsh ? '\n' : '\r\n';
                      const bytes = new TextEncoder().encode(cmd + suffix);

                      let typeByte = 0x01; // Serial
                      if (isSsh) typeByte = 0x03;
                      if (isTcp) typeByte = 0x04;

                      const packet = new Uint8Array([typeByte, 1, ...bytes]); // 1 = TX direction
                      remoteChannel.send(packet);
                      addLog(`Sent remote command: ${cmd.trim()}`);
                    } else if (connectionType === 'SSH') {
                      const bytes = Array.from(new TextEncoder().encode(cmd + '\n'));
                      await safeInvoke("send_ssh_data", { tabId, data: bytes });
                    } else if (connectionType === 'TCP') {
                      const bytes = Array.from(new TextEncoder().encode(cmd + '\r\n'));
                      await safeInvoke("send_tcp_data", { tabId, data: bytes });
                    } else if (connectionType === 'Terminal') {
                      const bytes = Array.from(new TextEncoder().encode(cmd.endsWith('\n') ? cmd : cmd + '\n'));
                      await safeInvoke("send_local_shell_data", { tabId, data: bytes });
                    } else if (connectionType === 'Serial') {
                      const bytes = Array.from(new TextEncoder().encode(cmd + '\r\n'));
                      await safeInvoke("send_serial_data", { tabId, data: bytes });
                    }
                  } catch (e) {
                    console.error(`Failed to send ${connectionType} command:`, e);
                    addLog(`Error sending command: ${e}`);
                  }
                }}
              />
            )}
          </div>
        </div>
      </main>

      {/* Modals */}
      {editingSeq && (
        <SequenceEditor
          sequence={editingSeq}
          isOpen={true}
          onClose={() => {
            setEditingSeq(null);
            broadcastHostState({ editingSeqId: null });
          }}
          onSave={(updatedSeq) => {
            updateSequence(updatedSeq);
            setEditingSeq(null);
            broadcastHostState({ editingSeqId: null });
          }}
          onDelete={(seq: Sequence) => {
            const newSeqs = project.send_sequences.filter((s: Sequence) => s.id !== seq.id);
            setProject({ ...project, send_sequences: newSeqs });
            setEditingSeq(null);
            broadcastHostState({ editingSeqId: null });
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
          onClose={() => {
            setEditingReaction(null);
            broadcastHostState({ editingReactionId: null });
          }}
          onSave={(updated: Reaction) => {
            const newReactions = project.reactions.map((r: Reaction) => r.id === updated.id ? updated : r);
            setProject({ ...project, reactions: newReactions });
            onProjectNameChange(tabId, project.name);
            setEditingReaction(null);
            broadcastHostState({ editingReactionId: null });
          }}
          onDelete={(r: Reaction) => {
            const newReactions = project.reactions.filter((reaction: Reaction) => reaction.id !== r.id);
            setProject({ ...project, reactions: newReactions });
            onProjectNameChange(tabId, project.name);
            setEditingReaction(null);
            broadcastHostState({ editingReactionId: null });
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
            <span className="text-zinc-300 font-bold">{txBytes > 1024 ? `${(txBytes / 1024).toFixed(2)} KB` : `${txBytes} B`}</span>
            <span className="text-zinc-600 font-sans">({txPackets})</span>
          </div>
          <span className="text-zinc-700">|</span>
          <div className="flex items-center gap-1">
            <span className="text-zinc-500 font-sans">RX:</span>
            <span className="text-zinc-300 font-bold">{rxBytes > 1024 ? `${(rxBytes / 1024).toFixed(2)} KB` : `${rxBytes} B`}</span>
            <span className="text-zinc-600 font-sans">({rxPackets})</span>
          </div>
        </div>
      </div>
    </div>
  );
});

// Wrap App with LicenseProvider

