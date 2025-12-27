import { useRef, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Download, Trash2 } from 'lucide-react';
import { save, message } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

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
    const [viewMode, setViewMode] = useState<"Ascii" | "Hex">("Ascii");
    const [autoScroll, setAutoScroll] = useState(true);
    const [timestampMode, setTimestampMode] = useState<TimestampMode>("each");

    const [timestampGap, setTimestampGap] = useState<number>(() => {
        return Number(localStorage.getItem('terminal-ts-gap') || '100');
    });

    // Save TS Gap to localStorage for use in App.log handling
    useEffect(() => {
        localStorage.setItem('terminal-ts-gap', timestampGap.toString());
    }, [timestampGap]);

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

    const renderData = (bytes: number[]) => {
        if (viewMode === 'Hex') {
            return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        } else {
            const elements: any[] = [];
            let currentString = "";

            for (let i = 0; i < bytes.length; i++) {
                const b = bytes[i];
                if (b < 32 || b === 127) {
                    // Flush accumulated string
                    if (currentString) {
                        elements.push(<span key={`s-${i}`}>{currentString}</span>);
                        currentString = "";
                    }

                    const name = CONTROL_CHAR_NAMES[b] || "??";
                    const color = b === 13 ? "text-orange-500" :
                        b === 10 ? "text-blue-500" :
                            b === 27 ? "text-purple-500" :
                                b === 29 ? "text-teal-500" : "text-zinc-500";

                    elements.push(
                        <span key={`c-${i}`}>
                            <span className={clsx("font-bold text-[10px] px-0.5 bg-zinc-800 rounded mx-0.5", color)}>
                                {name}
                            </span>
                            {b === 10 && formatMode === 'Formatted' ? <br /> : null}
                        </span>
                    );
                } else {
                    currentString += String.fromCharCode(b);
                }
            }

            if (currentString) {
                elements.push(<span key="final-s">{currentString}</span>);
            }

            return elements;
        }
    };

    const handleExport = async () => {
        try {
            const text = logs.map(l => {
                // Use the same format for export
                const tsString = formatTimestamp(l.timestamp);
                const hex = l.data.map(b => b.toString(16).padStart(2, '0')).join(' ');
                const ascii = l.data.map(b => {
                    if (b < 32 || b === 127) {
                        return `<${CONTROL_CHAR_NAMES[b] || "??"}>`;
                    }
                    return String.fromCharCode(b);
                }).join('');

                const prefix = timestampMode !== 'none' ? `[${tsString}] ` : '';
                return `${prefix}[${l.direction}] HEX: ${hex} | ASCII: ${ascii}`;
            }).join('\n');

            const path = await save({
                filters: [{
                    name: 'Text Files',
                    extensions: ['txt']
                }],
                defaultPath: `plan_terminal_log_${Date.now()}.txt`
            });

            if (path) {
                await writeTextFile(path, text);
                await message('Log saved successfully', { title: 'Success', kind: 'info' });
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
                <div className="flex gap-2">
                    <label className="flex items-center gap-1 text-xs text-zinc-400 cursor-pointer select-none">
                        <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
                        Auto-scroll
                    </label>
                    <button onClick={handleExport} className="p-1 hover:text-white" title="Export">
                        <Download className="w-4 h-4" />
                    </button>
                    <button onClick={onClear} className="p-1 hover:text-red-400" title="Clear">
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Log Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-1">
                {/* Windowed rendering: only show last 500 logs in DOM, but keeps 10k in memory */}
                {logs.slice(-500).map(log => (
                    <div key={log.id} className="flex gap-2 hover:bg-zinc-900/50">
                        {timestampMode !== 'none' && (
                            <span className="text-zinc-500 select-none">[{formatTimestamp(log.timestamp)}]</span>
                        )}
                        <span className={log.direction === 'TX' ? "text-blue-400 font-bold" : "text-orange-400 font-bold"}>
                            {log.direction}
                        </span>
                        <span className="break-all whitespace-pre-wrap">{renderData(log.data)}</span>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>
        </div>
    );
}
