import { useRef, useEffect, useState, useCallback, useLayoutEffect, memo } from 'react';
import { Trash2, Search, X } from 'lucide-react';
import { clsx } from 'clsx';

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
    processedData?: number[]; // Pre-filtered ANSI bytes
}

interface Props {
    logs: LogEntry[];
    onClear: () => void;
    onSendCommand?: (cmd: string) => void;
    isActive?: boolean;
    autoScroll: boolean;
    setAutoScroll: (val: boolean) => void;
}

type TimestampMode = "none" | "each" | "line";

export const Terminal = memo(({ logs, onClear, onSendCommand, isActive, autoScroll, setAutoScroll }: Props) => {
    const bottomRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const cmdInputRef = useRef<HTMLInputElement>(null);
    const [cmdText, setCmdText] = useState("");
    const [viewMode, setViewMode] = useState<"Ascii" | "Hex" | "Binary" | "Decimal">("Ascii");
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    // SCROLL REFS
    const lastScrollHeight = useRef(0);
    const lastScrollTop = useRef(0);
    const wasAtBottom = useRef(true);
    const anchorLogId = useRef<string | null>(null);
    const anchorOffset = useRef(0);

    const [timestampMode, setTimestampMode] = useState<TimestampMode>("each");
    const [stripAnsi, setStripAnsi] = useState(true); // Default to clean text

    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [filterMode, setFilterMode] = useState(false); // true = show only matching lines

    const [timestampGap, setTimestampGap] = useState<number>(() => {
        return Number(localStorage.getItem('terminal-ts-gap') || '100');
    });

    // Force scroll to bottom when autoscroll is toggled ON
    useEffect(() => {
        if (autoScroll && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
            wasAtBottom.current = true;
        }
    }, [autoScroll]);

    // Save TS Gap to localStorage
    useEffect(() => {
        localStorage.setItem('terminal-ts-gap', timestampGap.toString());
    }, [timestampGap]);

    // Keyboard Shortcuts
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (!isActive) return;

        if (((e.ctrlKey || e.metaKey) && e.key === 'f') || (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'f')) {
            e.preventDefault();
            const nextOpen = !searchOpen;
            setSearchOpen(nextOpen);
            if (nextOpen) {
                setTimeout(() => searchInputRef.current?.focus(), 50);
            }
        }
        if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            onClear();
        }
        if (e.key === 'Escape' && searchOpen) {
            setSearchOpen(false);
            setSearchQuery("");
        }
    }, [searchOpen, onClear, isActive]);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    // UNIFIED SCROLL MANAGEMENT
    // We use useLayoutEffect because it runs synchronously after DOM mutations but BEFORE the browser paints.
    // This allows us to adjust the scroll position without any visible 'jitter' or 'recession'.
    useLayoutEffect(() => {
        if (!scrollContainerRef.current) return;
        const el = scrollContainerRef.current;

        // 1. Determine state BEFORE this update actually painted
        const distFromBottom = lastScrollHeight.current - lastScrollTop.current - el.clientHeight;
        const wasActuallyAtBottom = distFromBottom < 100;

        // 2. Core Logic Branching
        if (isActive && autoScroll && wasActuallyAtBottom) {
            // CASE A: Autoscroll is active and we were at the bottom.
            // Force scroll to the new bottom immediately.
            el.scrollTop = el.scrollHeight;
            wasAtBottom.current = true;
        } else if (isActive && (!autoScroll || !wasActuallyAtBottom)) {
            // CASE B: Manual Pause or Autoscroll OFF.
            // Use Anchor logic to keep the SAME content at the top of the screen.
            if (anchorLogId.current) {
                const anchoredElement = el.querySelector(`[data-log-id="${anchorLogId.current}"]`) as HTMLElement;
                if (anchoredElement) {
                    const containerRect = el.getBoundingClientRect();
                    const newRect = anchoredElement.getBoundingClientRect();
                    const currentOffset = newRect.top - containerRect.top;
                    const diff = currentOffset - anchorOffset.current;
                    el.scrollTop += diff;
                }
            }
            // If they are manually scrolled up, we track that for next render
            wasAtBottom.current = false;
        }

        // 3. Tab Catch-up: If just activated, and we should be at bottom
        if (isActive && autoScroll && wasActuallyAtBottom) {
            el.scrollTop = el.scrollHeight;
        }

        // 4. Update 'Last' refs for the NEXT render cycle
        lastScrollHeight.current = el.scrollHeight;
        lastScrollTop.current = el.scrollTop;

        // 5. Capture NEW anchor for the next log arrival
        if (isActive && !autoScroll) {
            const children = el.querySelectorAll('[data-log-id]');
            let bestId = null;
            let bestOffset = 0;
            const containerRect = el.getBoundingClientRect();
            for (let i = 0; i < children.length; i++) {
                const child = children[i] as HTMLElement;
                const rect = child.getBoundingClientRect();
                if (rect.top >= containerRect.top) {
                    bestId = child.getAttribute('data-log-id');
                    bestOffset = rect.top - containerRect.top;
                    break;
                }
            }
            anchorLogId.current = bestId;
            anchorOffset.current = bestOffset;
        }
    }, [logs, autoScroll, isActive]);

    const onScroll = () => {
        if (scrollContainerRef.current && isActive) {
            const el = scrollContainerRef.current;
            const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            // Capture bottom-lock state for manual scrolling
            wasAtBottom.current = distFromBottom < 100;

            // Sync current scroll position to refs so next layout effect has accurate data
            lastScrollHeight.current = el.scrollHeight;
            lastScrollTop.current = el.scrollTop;
        }
    };

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
        } else if (viewMode === 'Decimal') {
            const decStr = bytes.map(b => b.toString(10)).join(' ');
            return highlight ? highlightMatches(decStr, highlight, 'dec') : decStr;
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

                    if (formatMode === 'Formatted') {
                        if (b === 13) {
                            if (i + 1 < bytes.length && bytes[i + 1] === 10) {
                                i++;
                                elements.push(
                                    <span key={`c-${i}`}>
                                        <span className="font-bold text-[10px] px-0.5 bg-zinc-800 rounded mx-0.5 text-blue-500">
                                            &lt;LF&gt;
                                        </span>
                                    </span>
                                );
                                elements.push(<br key={`br-${i}`} />);
                            } else {
                                elements.push(<br key={`br-${i}`} />);
                            }
                        } else if (b === 10) {
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

    const getSearchableText = (bytes: number[]): string => {
        if (viewMode === 'Hex') return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        if (viewMode === 'Binary') return bytes.map(b => b.toString(2).padStart(8, '0')).join(' ');
        if (viewMode === 'Decimal') return bytes.map(b => b.toString(10)).join(' ');
        return bytes.map(b => {
            if (b < 32 || b === 127) return `<${CONTROL_CHAR_NAMES[b] || "??"}>`;
            return String.fromCharCode(b);
        }).join('');
    };

    return (
        <div className="flex flex-col h-full bg-black text-green-500 font-mono text-sm rounded-lg overflow-hidden border border-border">
            {/* Toolbar */}
            <div className="flex justify-between items-center p-2 bg-zinc-900 border-b border-zinc-800 flex-wrap gap-2">
                <div className="flex gap-2">
                    <div className="flex bg-zinc-800 rounded p-0.5 text-xs">
                        <button className={clsx("px-2 py-0.5 rounded text-gray-300", viewMode === 'Ascii' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')} onClick={() => setViewMode('Ascii')}>ASCII</button>
                        <button className={clsx("px-2 py-0.5 rounded text-gray-300", viewMode === 'Hex' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')} onClick={() => setViewMode('Hex')}>HEX</button>
                        <button className={clsx("px-2 py-0.5 rounded text-gray-300", viewMode === 'Decimal' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')} onClick={() => setViewMode('Decimal')}>DEC</button>
                        <button className={clsx("px-2 py-0.5 rounded text-gray-300", viewMode === 'Binary' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')} onClick={() => setViewMode('Binary')}>BIN</button>
                    </div>

                    <div className="flex bg-zinc-800 rounded p-0.5 text-xs">
                        <button className={clsx("px-2 py-0.5 rounded text-gray-300", formatMode === 'Stream' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')} onClick={() => setFormatMode('Stream')}>Stream</button>
                        <button className={clsx("px-2 py-0.5 rounded text-gray-300", formatMode === 'Formatted' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')} onClick={() => setFormatMode('Formatted')}>Formatted</button>
                    </div>

                    <div className="flex items-center gap-1 text-xs">
                        <span className="text-zinc-400 ml-1">Gap:</span>
                        <input type="number" className="w-10 bg-zinc-800 text-white rounded px-1 py-0.5 text-center no-spinner" value={timestampGap} onChange={(e) => setTimestampGap(Math.max(0, parseInt(e.target.value) || 0))} />
                        <span className="text-zinc-500">ms</span>
                    </div>

                    <div className="flex bg-zinc-800 rounded p-0.5 text-xs">
                        <button className={clsx("px-2 py-0.5 rounded text-gray-300", timestampMode === 'none' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')} onClick={() => setTimestampMode('none')}>No Time</button>
                        <button className={clsx("px-2 py-0.5 rounded text-gray-300", timestampMode === 'each' ? 'bg-zinc-600 text-white' : 'hover:bg-zinc-700')} onClick={() => setTimestampMode('each')}>Time</button>
                    </div>
                </div>
                <div className="flex gap-2 items-center">
                    <label className="flex items-center gap-1 text-xs text-zinc-400 cursor-pointer select-none">
                        <input type="checkbox" checked={stripAnsi} onChange={e => setStripAnsi(e.target.checked)} />
                        Clean
                    </label>
                    <label className="flex items-center gap-1 text-xs text-zinc-400 cursor-pointer select-none">
                        <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
                        Auto-scroll
                    </label>
                    <button
                        onClick={() => { setSearchOpen(!searchOpen); if (!searchOpen) setTimeout(() => searchInputRef.current?.focus(), 50); }}
                        className={clsx("flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-gray-300 hover:bg-zinc-800 hover:text-white transition-colors", searchOpen && "text-yellow-400 bg-zinc-800")}
                    >
                        <Search className="w-3.5 h-3.5" />
                        <span>Find</span>
                    </button>
                    <button
                        onClick={onClear}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-gray-300 hover:bg-zinc-800 hover:text-red-400 transition-colors"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Clear</span>
                    </button>
                </div>
            </div>

            {/* Search Bar */}
            {searchOpen && (
                <div className="flex items-center gap-2 px-4 py-2 bg-zinc-800 border-b border-zinc-700">
                    <Search className="w-4 h-4 text-zinc-500" />
                    <input ref={searchInputRef} type="text" placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="flex-1 bg-zinc-900 text-white rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-yellow-500" />
                    <label className="flex items-center gap-1 text-xs text-zinc-400 cursor-pointer select-none">
                        <input type="checkbox" checked={filterMode} onChange={e => setFilterMode(e.target.checked)} /> Filter
                    </label>
                    {searchQuery && (
                        <span className="text-xs text-zinc-500">
                            {logs.filter(log => getSearchableText(log.processedData || log.data).toLowerCase().includes(searchQuery.toLowerCase())).length} matches
                        </span>
                    )}
                    <button onClick={() => { setSearchOpen(false); setSearchQuery(""); }} className="p-1 hover:text-red-400"><X className="w-4 h-4" /></button>
                </div>
            )}

            {/* Log Area */}
            <div
                ref={scrollContainerRef}
                className="flex-1 overflow-y-auto p-4 space-y-1"
                style={{ overflowAnchor: 'none' }}
                onScroll={onScroll}
            >
                {logs.slice(-400).map(log => {
                    const processedData = log.processedData || log.data;
                    if (searchQuery && filterMode && !getSearchableText(processedData).toLowerCase().includes(searchQuery.toLowerCase())) return null;
                    return (
                        <div key={log.id} data-log-id={log.id} className="flex gap-2 hover:bg-zinc-900/50">
                            {timestampMode !== 'none' && <span className="text-zinc-500 select-none">[{formatTimestamp(log.timestamp)}]</span>}
                            <span className={log.direction === 'TX' ? "text-blue-400 font-bold" : "text-orange-400 font-bold"}>{log.direction}</span>
                            <span className={clsx("break-all whitespace-pre-wrap", log.direction === 'TX' ? "text-cyan-400" : "text-yellow-400")}>
                                {renderData(processedData, searchQuery || undefined)}
                            </span>
                        </div>
                    );
                })}
                <div ref={bottomRef} />
            </div>

            {onSendCommand && (
                <div className="flex bg-zinc-900 border-t border-zinc-700/50 p-2 gap-2 shadow-inner">
                    <span className="text-green-500 font-mono self-center text-sm ml-2">$&gt;</span>
                    <input
                        ref={cmdInputRef}
                        type="text"
                        className="flex-1 bg-transparent border-none outline-none text-cyan-400 font-mono text-sm placeholder:text-zinc-600 focus:ring-0"
                        placeholder="Type SSH command here and press Enter (e.g., ls -la)"
                        value={cmdText}
                        onChange={e => setCmdText(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') {
                                if (cmdText.trim()) {
                                    onSendCommand(cmdText + '\n');
                                    setCmdText("");
                                }
                            }
                        }}
                    />
                    <button
                        className="bg-zinc-700 hover:bg-zinc-600 text-xs px-3 py-1 rounded text-white"
                        onClick={() => {
                            if (cmdText.trim()) {
                                onSendCommand(cmdText + '\n');
                                setCmdText("");
                            }
                        }}
                    >
                        Send
                    </button>
                </div>
            )}
        </div>
    );
});
