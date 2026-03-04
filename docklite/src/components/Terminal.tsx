import { useRef, useEffect, useState, useCallback } from 'react';
import { clsx } from 'clsx';
import { Download, Trash2, Search, X, FileText, Lock } from 'lucide-react';
import { save, message } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { useLicense, FREE_LIMITS } from '../contexts/LicenseContext';

const CONTROL_CHAR_NAMES: Record<number, string> = {
    0: "NUL", 1: "SOH", 2: "STX", 3: "ETX", 4: "EOT", 5: "ENQ", 6: "ACK", 7: "BEL",
    8: "BS", 9: "HT", 10: "LF", 11: "VT", 12: "FF", 13: "CR", 14: "SO", 15: "SI",
    16: "DLE", 17: "DC1", 18: "DC2", 19: "DC3", 20: "DC4", 21: "NAK", 22: "SYN", 23: "ETB",
    24: "CAN", 25: "EM", 26: "SUB", 27: "ESC", 28: "FS", 29: "GS", 30: "RS", 31: "US",
    127: "DEL"
};

export interface LogEntry {
    id: string;
    timestamp: number;
    direction: "RX" | "TX";
    data: number[]; // Bytes
}

interface Props {
    logs: LogEntry[];
    onClear: () => void;
}

type TimestampMode = "none" | "each" | "line";

export function Terminal({ logs, onClear }: Props) {
    const bottomRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [viewMode, setViewMode] = useState<"Ascii" | "Hex" | "Binary">("Ascii");
    const [autoScroll, setAutoScroll] = useState(true);
    const [timestampMode, setTimestampMode] = useState<TimestampMode>("each");

    // Pro tier status
    const { isPro } = useLicense();

    // Search state
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [filterMode, setFilterMode] = useState(false); // true = show only matching lines

    // Real-time logging state
    const [isLogging, setIsLogging] = useState(false);
    const [logPath, setLogPath] = useState<string | null>(null);

    // Export / Log format state (shared checkboxes)
    const [exportAscii, setExportAscii] = useState(false);
    const [exportHex, setExportHex] = useState(false);
    const [exportBin, setExportBin] = useState(false);
    const [exportDec, setExportDec] = useState(false);
    const [showExportOptions, setShowExportOptions] = useState(false);
    const [showLogOptions, setShowLogOptions] = useState(false);

    const handleStartLogging = async () => {
        try {
            const path = await save({
                filters: [{
                    name: 'Log Files',
                    extensions: ['log', 'txt']
                }],
                defaultPath: `plan_terminal_${Date.now()}.log`
            });

            if (path) {
                // Determine format from selected checkboxes
                const format = exportAscii ? 'ascii' : exportHex ? 'hex' : 'both';
                await invoke('start_logging', { path, format });
                setIsLogging(true);
                setLogPath(path);
                setShowLogOptions(false);
                await message(`Logging started: ${path}`, { title: 'Logging Active', kind: 'info' });
            }
        } catch (error) {
            console.error('Failed to start logging:', error);
            await message(`Failed to start logging: ${error}`, { title: 'Error', kind: 'error' });
        }
    };

    const handleStopLogging = async () => {
        try {
            await invoke('stop_logging');
            setIsLogging(false);
            await message(`Log saved: ${logPath}`, { title: 'Logging Stopped', kind: 'info' });
            setLogPath(null);
        } catch (error) {
            console.error('Failed to stop logging:', error);
        }
    };

    const [timestampGap, setTimestampGap] = useState<number>(() => {
        return Number(localStorage.getItem('terminal-ts-gap') || '100');
    });

    // Save TS Gap to localStorage for use in App.log handling
    useEffect(() => {
        localStorage.setItem('terminal-ts-gap', timestampGap.toString());
    }, [timestampGap]);

    // Handle Ctrl+F keyboard shortcut
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            setSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 50);
        }
        if (e.key === 'Escape' && searchOpen) {
            setSearchOpen(false);
            setSearchQuery("");
        }
    }, [searchOpen]);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    useEffect(() => {
        if (autoScroll) {
            bottomRef.current?.scrollIntoView({ behavior: 'auto' });
        }
    }, [logs, autoScroll]);

    const [formatMode, setFormatMode] = useState<"Stream" | "Formatted">("Formatted");

    const formatTimestamp = (ts: number) => {
        const d = new Date(ts);
        const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const time = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0') + '.' + d.getMilliseconds().toString().padStart(3, '0');
        return `${date} ${time}`;
    };

    // Helper to highlight text matches
    const highlightMatches = (text: string, query: string, key: string) => {
        if (!query) return text;
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escapedQuery})`, 'gi');
        const parts = text.split(regex);
        return parts.map((part, i) =>
            part.toLowerCase() === query.toLowerCase()
                ? <mark key={`${key}-${i}`} className="bg-yellow-500 text-black px-0.5 rounded">{part}</mark>
                : part
        );
    };

    const renderData = (bytes: number[], highlight?: string) => {
        if (viewMode === 'Hex') {
            const hexStr = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
            return highlight ? highlightMatches(hexStr, highlight, 'hex') : hexStr;
        } else if (viewMode === 'Binary') {
            const binStr = bytes.map(b => b.toString(2).padStart(8, '0')).join(' ');
            return highlight ? highlightMatches(binStr, highlight, 'bin') : binStr;
        } else {
            const elements: any[] = [];
            let currentString = "";

            const flushString = (key: string) => {
                if (currentString) {
                    if (highlight) {
                        elements.push(<span key={key}>{highlightMatches(currentString, highlight, key)}</span>);
                    } else {
                        elements.push(<span key={key}>{currentString}</span>);
                    }
                    currentString = "";
                }
            };

            for (let i = 0; i < bytes.length; i++) {
                const b = bytes[i];
                if (b < 32 || b === 127) {
                    // Flush accumulated string
                    flushString(`s-${i}`);

                    const name = CONTROL_CHAR_NAMES[b] || "??";
                    const color = b === 13 ? "text-orange-500" :
                        b === 10 ? "text-blue-500" :
                            b === 27 ? "text-purple-500" :
                                b === 29 ? "text-teal-500" : "text-zinc-500";

                    elements.push(
                        <span key={`c-${i}`}>
                            <span className={clsx("font-bold text-[10px] px-0.5 bg-zinc-800 rounded mx-0.5", color)}>
                                &lt;{name}&gt;
                            </span>
                        </span>
                    );

                    // Newline Logic
                    if (formatMode === 'Formatted') {
                        if (b === 13) {
                            // If this is CR
                            if (i + 1 < bytes.length && bytes[i + 1] === 10) {
                                // Next is LF, handle it now
                                i++; // Skip next iteration
                                elements.push(
                                    <span key={`c-${i}`}>
                                        <span className="font-bold text-[10px] px-0.5 bg-zinc-800 rounded mx-0.5 text-blue-500">
                                            &lt;LF&gt;
                                        </span>
                                    </span>
                                );
                                // Single break for CR+LF
                                elements.push(<br key={`br-${i}`} />);
                            } else {
                                // Just CR
                                elements.push(<br key={`br-${i}`} />);
                            }
                        } else if (b === 10) {
                            // Just LF (not preceded by CR because we cleared it)
                            elements.push(<br key={`br-${i}`} />);
                        }
                    }
                } else {
                    currentString += String.fromCharCode(b);
                }
            }

            flushString("final-s");

            return elements;
        }
    };

    // Plain text version for searching (works in both modes)
    const getSearchableText = (bytes: number[]): string => {
        return bytes.map(b => {
            if (b < 32 || b === 127) {
                return `<${CONTROL_CHAR_NAMES[b] || "??"}>`;
            }
            return String.fromCharCode(b);
        }).join('');
    };

    // Helper formatters for export
    const formatLogLine = (l: LogEntry, format: 'ascii' | 'hex' | 'bin' | 'dec' | 'combined') => {
        const tsString = formatTimestamp(l.timestamp);
        const prefix = timestampMode !== 'none' ? `[${tsString}] ` : '';

        const hex = l.data.map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = l.data.map(b => {
            if (b < 32 || b === 127) return `<${CONTROL_CHAR_NAMES[b] || "??"}>`;
            return String.fromCharCode(b);
        }).join('');
        const bin = l.data.map(b => b.toString(2).padStart(8, '0')).join(' ');

        switch (format) {
            case 'ascii': return `${prefix}[${l.direction}] ${ascii}`;
            case 'hex': return `${prefix}[${l.direction}] ${hex}`;
            case 'bin': return `${prefix}[${l.direction}] ${bin}`;
            case 'dec': return `${prefix}[${l.direction}] ${l.data.join(' ')}`;
            default: return `${prefix}[${l.direction}] HEX: ${hex} | ASCII: ${ascii}`;
        }
    };

    const handleExport = async () => {
        try {
            const exportLogs = isPro ? logs : logs.slice(-FREE_LIMITS.MAX_EXPORT_LINES);
            const limitNotice = !isPro && logs.length > FREE_LIMITS.MAX_EXPORT_LINES
                ? `\n\n--- FREE VERSION: Only last ${FREE_LIMITS.MAX_EXPORT_LINES} entries exported. Upgrade to Pro for unlimited export. ---\n`
                : '';

            const anyFormatSelected = exportAscii || exportHex || exportBin || exportDec;

            if (anyFormatSelected) {
                // Multi-file export: one file per selected format
                const path = await save({
                    filters: [{ name: 'Log Files', extensions: ['log', 'txt'] }],
                    defaultPath: `plan_terminal_log_${Date.now()}.log`
                });
                if (!path) return;

                const basePath = path.replace(/\.(log|txt)$/, '');
                const ext = path.match(/\.(log|txt)$/)?.[0] || '.log';
                const savedFiles: string[] = [];

                if (exportAscii) {
                    const text = exportLogs.map(l => formatLogLine(l, 'ascii')).join('\n') + limitNotice;
                    const filePath = `${basePath}_ascii${ext}`;
                    await invoke('write_file_direct', { path: filePath, content: text });
                    savedFiles.push('ASCII');
                }
                if (exportHex) {
                    const text = exportLogs.map(l => formatLogLine(l, 'hex')).join('\n') + limitNotice;
                    const filePath = `${basePath}_hex${ext}`;
                    await invoke('write_file_direct', { path: filePath, content: text });
                    savedFiles.push('HEX');
                }
                if (exportBin) {
                    const text = exportLogs.map(l => formatLogLine(l, 'bin')).join('\n') + limitNotice;
                    const filePath = `${basePath}_bin${ext}`;
                    await invoke('write_file_direct', { path: filePath, content: text });
                    savedFiles.push('BIN');
                }
                if (exportDec) {
                    const text = exportLogs.map(l => formatLogLine(l, 'dec')).join('\n') + limitNotice;
                    const filePath = `${basePath}_dec${ext}`;
                    await invoke('write_file_direct', { path: filePath, content: text });
                    savedFiles.push('DEC');
                }

                await message(`Saved ${savedFiles.join(', ')} logs as separate files`, { title: 'Export Complete', kind: 'info' });
            } else {
                // Default combined export
                const text = exportLogs.map(l => formatLogLine(l, 'combined')).join('\n') + limitNotice;
                const path = await save({
                    filters: [{ name: 'Text Files', extensions: ['txt'] }],
                    defaultPath: `plan_terminal_log_${Date.now()}.txt`
                });
                if (path) {
                    await writeTextFile(path, text);
                    await message('Log saved successfully', { title: 'Success', kind: 'info' });
                }
            }
        } catch (error) {
            console.error('Failed to export logs:', error);
            await message(`Failed to save file: ${error}`, { title: 'Error', kind: 'error' });
        }
    };

    return (
        <div className="flex flex-col h-full bg-black text-green-500 font-mono text-sm rounded-lg overflow-hidden border border-border">
            {/* Toolbar */}
            <div className="flex justify-between items-center p-2 bg-zinc-900 border-b border-zinc-800 flex-wrap gap-2">
                <div className="flex gap-2">
                    <div className="flex bg-zinc-800 rounded p-0.5 text-xs">
                        <button
                            className={clsx("px-2 py-0.5 rounded text-gray-300", viewMode === 'Ascii' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')}
                            onClick={() => setViewMode('Ascii')}
                        >ASCII</button>
                        <button
                            className={clsx("px-2 py-0.5 rounded text-gray-300", viewMode === 'Hex' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')}
                            onClick={() => setViewMode('Hex')}
                        >HEX</button>
                        <button
                            className={clsx("px-2 py-0.5 rounded text-gray-300", viewMode === 'Binary' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')}
                            onClick={() => setViewMode('Binary')}
                        >BIN</button>
                    </div>

                    <div className="border-l border-zinc-700 mx-1" />

                    <div className="flex bg-zinc-800 rounded p-0.5 text-xs">
                        <button
                            className={clsx("px-2 py-0.5 rounded text-gray-300", formatMode === 'Stream' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')}
                            onClick={() => setFormatMode('Stream')}
                            title="Show raw stream (no extra line breaks)"
                        >Stream</button>
                        <button
                            className={clsx("px-2 py-0.5 rounded text-gray-300", formatMode === 'Formatted' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')}
                            onClick={() => setFormatMode('Formatted')}
                            title="Wrap lines on LF characters"
                        >Formatted</button>
                    </div>

                    <div className="border-l border-zinc-700 mx-1" />

                    <div className="flex items-center gap-1 text-xs">
                        <span className="text-zinc-400">TS Gap:</span>
                        <input
                            type="number"
                            className="w-12 bg-zinc-800 text-white rounded px-1 py-0.5 text-center no-spinner"
                            value={timestampGap}
                            onChange={(e) => setTimestampGap(Math.max(0, parseInt(e.target.value) || 0))}
                            title="Timestamp Gap (ms). Data arriving within this window shares one timestamp."
                        />
                        <span className="text-zinc-500">ms</span>
                    </div>

                    <div className="border-l border-zinc-700 mx-1" />

                    <div className="flex bg-zinc-800 rounded p-0.5 text-xs">
                        <button
                            className={clsx("px-2 py-0.5 rounded text-gray-300", timestampMode === 'none' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')}
                            onClick={() => setTimestampMode('none')}
                            title="Hide timestamps"
                        >No Time</button>
                        <button
                            className={clsx("px-2 py-0.5 rounded text-gray-300", timestampMode === 'each' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')}
                            onClick={() => setTimestampMode('each')}
                            title="Show timestamp for each entry"
                        >Timestamp</button>
                    </div>
                </div>
                <div className="flex gap-2 items-center">
                    <label className="flex items-center gap-1 text-xs text-zinc-400 cursor-pointer select-none">
                        <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
                        Auto-scroll
                    </label>
                    <button onClick={() => { setSearchOpen(!searchOpen); if (!searchOpen) setTimeout(() => searchInputRef.current?.focus(), 50); }} className={clsx("p-1 hover:text-white", searchOpen && "text-yellow-400")} title="Search (Ctrl+F)">
                        <Search className="w-4 h-4" />
                    </button>
                    {/* Real-time Log Button - Pro Only */}
                    <div className="relative">
                        <button
                            onClick={() => {
                                if (!isPro) return;
                                if (isLogging) {
                                    handleStopLogging();
                                } else {
                                    setShowLogOptions(!showLogOptions);
                                }
                            }}
                            className={clsx(
                                "p-1 flex items-center gap-1 text-xs rounded",
                                !isPro ? "text-zinc-600 cursor-not-allowed" :
                                    isLogging ? "text-red-400 bg-red-900/30 animate-pulse" : "hover:text-white"
                            )}
                            title={!isPro ? "Real-time Logging (Pro Feature)" : isLogging ? "Stop Logging" : "Start Logging to File"}
                        >
                            {!isPro ? <Lock className="w-3 h-3" /> : <FileText className="w-4 h-4" />}
                            {isLogging && <span className="text-[10px]">LOG</span>}
                            {!isPro && <span className="text-[10px]">PRO</span>}
                        </button>
                        {showLogOptions && !isLogging && isPro && (
                            <div className="absolute right-0 top-full mt-1 bg-zinc-800 border border-zinc-700 rounded shadow-lg z-50 p-2 w-48">
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
                                <button
                                    onClick={handleStartLogging}
                                    className="w-full mt-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded text-xs font-medium"
                                >
                                    Start Logging
                                </button>
                            </div>
                        )}
                    </div>
                    {/* Export Options */}
                    <div className="relative">
                        <button
                            onClick={() => setShowExportOptions(!showExportOptions)}
                            className={clsx("p-1 hover:text-white", showExportOptions && "text-green-400")}
                            title="Export Options"
                        >
                            <Download className="w-4 h-4" />
                        </button>
                        {showExportOptions && (
                            <div className="absolute right-0 top-full mt-1 bg-zinc-800 border border-zinc-700 rounded shadow-lg z-50 p-2 w-48">
                                <div className="text-[10px] text-zinc-400 font-semibold mb-1 uppercase">Export Formats</div>
                                <div className="text-[10px] text-zinc-500 mb-2">Select formats for separate files. None = combined default.</div>
                                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer py-0.5 hover:bg-zinc-700 rounded px-1">
                                    <input type="checkbox" checked={exportAscii} onChange={e => setExportAscii(e.target.checked)} />
                                    ASCII
                                </label>
                                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer py-0.5 hover:bg-zinc-700 rounded px-1">
                                    <input type="checkbox" checked={exportHex} onChange={e => setExportHex(e.target.checked)} />
                                    HEX
                                </label>
                                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer py-0.5 hover:bg-zinc-700 rounded px-1">
                                    <input type="checkbox" checked={exportBin} onChange={e => setExportBin(e.target.checked)} />
                                    BIN
                                </label>
                                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer py-0.5 hover:bg-zinc-700 rounded px-1">
                                    <input type="checkbox" checked={exportDec} onChange={e => setExportDec(e.target.checked)} />
                                    DEC
                                </label>
                                <button
                                    onClick={() => { handleExport(); setShowExportOptions(false); }}
                                    className="w-full mt-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded text-xs font-medium"
                                >
                                    Download
                                </button>
                            </div>
                        )}
                    </div>
                    <button onClick={onClear} className="p-1 hover:text-red-400" title="Clear">
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Search Bar */}
            {searchOpen && (
                <div className="flex items-center gap-2 px-4 py-2 bg-zinc-800 border-b border-zinc-700">
                    <Search className="w-4 h-4 text-zinc-500" />
                    <input
                        ref={searchInputRef}
                        type="text"
                        placeholder="Search... (ESC to close)"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="flex-1 bg-zinc-900 text-white rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-yellow-500"
                    />
                    <label className="flex items-center gap-1 text-xs text-zinc-400 cursor-pointer select-none">
                        <input type="checkbox" checked={filterMode} onChange={e => setFilterMode(e.target.checked)} />
                        Filter
                    </label>
                    {searchQuery && (
                        <span className="text-xs text-zinc-500">
                            {logs.filter(log => {
                                const text = getSearchableText(log.data);
                                return text.toLowerCase().includes(searchQuery.toLowerCase());
                            }).length} matches
                        </span>
                    )}
                    <button onClick={() => { setSearchOpen(false); setSearchQuery(""); }} className="p-1 hover:text-red-400" title="Close">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            )}

            {/* Log Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-1">
                {/* Windowed rendering: only show last 500 logs in DOM, but keeps 10k in memory */}
                {logs.slice(-500)
                    .filter(log => {
                        if (!searchQuery || !filterMode) return true;
                        const text = getSearchableText(log.data);
                        return text.toLowerCase().includes(searchQuery.toLowerCase());
                    })
                    .map(log => (
                        <div key={log.id} className="flex gap-2 hover:bg-zinc-900/50">
                            {timestampMode !== 'none' && (
                                <span className="text-zinc-500 select-none">[{formatTimestamp(log.timestamp)}]</span>
                            )}
                            <span className={log.direction === 'TX' ? "text-blue-400 font-bold" : "text-orange-400 font-bold"}>
                                {log.direction}
                            </span>
                            <span className={clsx("break-all whitespace-pre-wrap", log.direction === 'TX' ? "text-cyan-400" : "text-yellow-400")}>
                                {renderData(log.data, searchQuery || undefined)}
                            </span>
                        </div>
                    ))}
                <div ref={bottomRef} />
            </div>
        </div>
    );
}
