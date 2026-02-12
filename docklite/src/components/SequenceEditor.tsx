import { useState, useEffect, useRef } from "react";
import { Sequence } from "../types";
import { X, Save, Trash2, Play, Pause, Plus } from "lucide-react";
import { parseData, bytesToHex } from "../utils";
import { CrcType, calculateCrc } from "../crc";

interface Props {
    sequence: Sequence;
    isOpen: boolean;
    onClose: () => void;
    onSave: (seq: Sequence) => void;
    onDelete?: (seq: Sequence) => void;
    onSend?: (seq: Sequence) => void;
}

export function SequenceEditor({ sequence, isOpen, onClose, onSave, onDelete, onSend }: Props) {
    const [data, setData] = useState(sequence.data);
    const [name, setName] = useState(sequence.name);
    const [viewMode, setViewMode] = useState(sequence.view_mode);
    const [previewMode, setPreviewMode] = useState<'Hex' | 'Decimal'>('Hex');
    const [selectionRange, setSelectionRange] = useState<{ start: number, end: number } | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // Periodic send
    const [periodicEnabled, setPeriodicEnabled] = useState(sequence.periodic_enabled || false);
    const [periodicInterval, setPeriodicInterval] = useState(sequence.periodic_interval || 1000);
    const periodicRef = useRef<number | null>(null);
    // CRC
    const [crcType, setCrcType] = useState<CrcType>('none');


    // Handle periodic sending
    useEffect(() => {
        if (periodicEnabled && onSend) {
            periodicRef.current = window.setInterval(() => {
                onSend({ ...sequence, name, data, view_mode: viewMode });
            }, periodicInterval);
        } else if (periodicRef.current) {
            clearInterval(periodicRef.current);
            periodicRef.current = null;
        }
        return () => {
            if (periodicRef.current) {
                clearInterval(periodicRef.current);
            }
        };
    }, [periodicEnabled, periodicInterval, name, data, viewMode, sequence, onSend]);


    // Helper to insert text at cursor position
    const insertAtCursor = (textToInsert: string) => {
        const textarea = textareaRef.current;
        if (!textarea) {
            setData((d: string) => d + textToInsert);
            return;
        }
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newData = data.substring(0, start) + textToInsert + data.substring(end);
        setData(newData);
        setTimeout(() => {
            textarea.selectionStart = textarea.selectionEnd = start + textToInsert.length;
            textarea.focus();
        }, 0);
    };

    useEffect(() => {
        setName(sequence.name);
        setPeriodicInterval(sequence.periodic_interval || 1000);
        setPeriodicEnabled(sequence.periodic_enabled || false);

        // Handle Data Conversion on Load
        let initialData = sequence.data;
        // If coming from import (Hex string) but view mode is Ascii, convert it
        if (sequence.view_mode === 'Ascii') {
            // Check if it looks like a hex string (space separated pairs)
            const isHexString = /^([0-9A-Fa-f]{2}\s*)+$/.test(sequence.data.trim());
            if (isHexString) {
                try {
                    const bytes = parseData(sequence.data, 'Hex');
                    let ascii = '';
                    for (const byte of bytes) {
                        if (byte === 13) ascii += '<CR>';
                        else if (byte === 10) ascii += '<LF>';
                        else if (byte === 27) ascii += '<ESC>';
                        else if (byte === 0) ascii += '<NUL>';
                        else if (byte < 32 || byte > 126) ascii += `<${byte}>`;
                        else ascii += String.fromCharCode(byte);
                    }
                    initialData = ascii;
                } catch (e) {
                    // Keep as is if parse fails
                    console.warn("Failed to auto-convert hex to ascii on load", e);
                }
            }
        }

        setData(initialData);
        setViewMode(sequence.view_mode);
    }, [sequence]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
        }
    };

    // Track selection in textarea
    const handleSelect = () => {
        const textarea = textareaRef.current;
        if (textarea && textarea.selectionStart !== textarea.selectionEnd) {
            setSelectionRange({ start: textarea.selectionStart, end: textarea.selectionEnd });
        } else {
            setSelectionRange(null);
        }
    };

    // Convert data to bytes for preview
    const bytes = parseData(data, viewMode);

    // Calculate which bytes are selected based on character selection
    const getSelectedByteIndices = (): Set<number> => {
        if (!selectionRange || viewMode !== 'Ascii') return new Set();

        // Parse data to map character positions to byte indices
        const selectedIndices = new Set<number>();

        // Parse like parseData does for ASCII - handle special tags
        const tagPattern = /<(CR|LF|CRLF|ESC|NUL|\d+)>/gi;
        let lastIndex = 0;
        let match;

        const segments: { start: number, end: number, bytes: number }[] = [];

        while ((match = tagPattern.exec(data)) !== null) {
            // Characters before the tag
            const beforeTag = data.substring(lastIndex, match.index);
            segments.push({ start: lastIndex, end: match.index, bytes: beforeTag.length });

            // The tag itself
            const tag = match[1].toUpperCase();
            let tagBytes = 1;
            if (tag === 'CRLF') tagBytes = 2;
            segments.push({ start: match.index, end: match.index + match[0].length, bytes: tagBytes });

            lastIndex = match.index + match[0].length;
        }
        // Remaining characters after last tag
        if (lastIndex < data.length) {
            segments.push({ start: lastIndex, end: data.length, bytes: data.length - lastIndex });
        }

        // Map selection to bytes
        let currentByteIndex = 0;
        for (const seg of segments) {
            const segStart = seg.start;
            const segEnd = seg.end;
            const segBytes = seg.bytes;

            // Check overlap with selection
            const overlapStart = Math.max(segStart, selectionRange.start);
            const overlapEnd = Math.min(segEnd, selectionRange.end);

            if (overlapStart < overlapEnd) {
                // There's overlap, add all bytes in this segment
                for (let i = 0; i < segBytes; i++) {
                    selectedIndices.add(currentByteIndex + i);
                }
            }
            currentByteIndex += segBytes;
        }

        return selectedIndices;
    };

    const selectedByteIndices = getSelectedByteIndices();

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-card border w-full max-w-4xl h-[85vh] overflow-y-auto p-4 rounded-lg shadow-lg flex flex-col gap-4">
                <div className="flex justify-between items-center header">
                    <h3 className="font-semibold text-lg">Edit Sequence</h3>
                    <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="w-4 h-4" /></button>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="text-sm font-medium">Name</label>
                        <input
                            className="w-full bg-background border rounded px-3 py-2 mt-1"
                            value={name}
                            onChange={e => setName(e.target.value)}
                        />
                    </div>

                    {/* Side-by-side container */}
                    <div className="flex gap-4">
                        {/* Left: Editor */}
                        <div className="flex-1">
                            <div className="flex justify-between items-center mb-1">
                                <label className="text-sm font-medium">Data</label>
                                <div className="text-xs flex bg-muted rounded p-0.5">
                                    <button
                                        className={`px-2 py-0.5 rounded ${viewMode === 'Ascii' ? 'bg-background shadow' : ''}`}
                                        onClick={() => {
                                            if (viewMode === 'Hex') {
                                                const bytes = parseData(data, 'Hex');
                                                let ascii = '';
                                                for (const byte of bytes) {
                                                    if (byte === 13) ascii += '<CR>';
                                                    else if (byte === 10) ascii += '<LF>';
                                                    else if (byte === 27) ascii += '<ESC>';
                                                    else if (byte === 0) ascii += '<NUL>';
                                                    else if (byte < 32 || byte > 126) ascii += `<${byte}>`;
                                                    else ascii += String.fromCharCode(byte);
                                                }
                                                setData(ascii);
                                            } else if (viewMode === 'Decimal') {
                                                const bytes = parseData(data, 'Decimal');
                                                let ascii = '';
                                                for (const byte of bytes) {
                                                    if (byte === 13) ascii += '<CR>';
                                                    else if (byte === 10) ascii += '<LF>';
                                                    else if (byte === 27) ascii += '<ESC>';
                                                    else if (byte === 0) ascii += '<NUL>';
                                                    else if (byte < 32 || byte > 126) ascii += `<${byte}>`;
                                                    else ascii += String.fromCharCode(byte);
                                                }
                                                setData(ascii);
                                            }
                                            setViewMode('Ascii');
                                        }}
                                    >ASCII</button>
                                    <button
                                        className={`px-2 py-0.5 rounded ${viewMode === 'Hex' ? 'bg-background shadow' : ''}`}
                                        onClick={() => {
                                            const hex = bytesToHex(parseData(data, viewMode));
                                            setData(hex);
                                            setViewMode('Hex');
                                        }}
                                    >HEX</button>
                                    <button
                                        className={`px-2 py-0.5 rounded ${viewMode === 'Decimal' ? 'bg-background shadow' : ''}`}
                                        onClick={() => {
                                            const bytes = parseData(data, viewMode);
                                            setData(bytes.join(' '));
                                            setViewMode('Decimal');
                                        }}
                                    >DEC</button>
                                </div>
                            </div>

                            {/* Toolbar Buttons */}
                            <div className="flex gap-1 flex-wrap mb-2">
                                <button
                                    onClick={() => viewMode === 'Ascii' ? insertAtCursor("<CR>") : insertAtCursor(viewMode === 'Hex' ? " 0D" : " 13")}
                                    className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs font-mono"
                                    title="Insert Carriage Return"
                                >+CR</button>
                                <button
                                    onClick={() => viewMode === 'Ascii' ? insertAtCursor("<LF>") : insertAtCursor(viewMode === 'Hex' ? " 0A" : " 10")}
                                    className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs font-mono"
                                    title="Insert Line Feed"
                                >+LF</button>
                                <button
                                    onClick={() => viewMode === 'Ascii' ? insertAtCursor("<NUL>") : insertAtCursor(viewMode === 'Hex' ? " 00" : " 0")}
                                    className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs font-mono"
                                    title="Insert Null"
                                >+NULL</button>
                                <button
                                    onClick={() => viewMode === 'Ascii' ? insertAtCursor("<CR><LF>") : insertAtCursor(viewMode === 'Hex' ? " 0D 0A" : " 13 10")}
                                    className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs font-mono"
                                    title="Insert CR+LF"
                                >+CRLF</button>
                                <button
                                    onClick={() => viewMode === 'Ascii' ? insertAtCursor("<ESC>") : insertAtCursor(viewMode === 'Hex' ? " 1B" : " 27")}
                                    className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs font-mono"
                                    title="Insert Escape"
                                >+ESC</button>
                                <button
                                    onClick={() => {
                                        if (viewMode === 'Ascii') {
                                            const lines = data.split('\n');
                                            const newData = lines.map((line: string) => line.trimEnd()).join('<CR><LF>') + '<CR><LF>';
                                            setData(newData);
                                        }
                                    }}
                                    className="px-2 py-1 bg-blue-600 text-white hover:bg-blue-700 rounded text-xs font-sans"
                                    title="Convert newlines to <CR><LF> tags"
                                >Format EOL</button>
                            </div>

                            <textarea
                                ref={textareaRef}
                                className="w-full h-64 bg-background border rounded px-3 py-2 font-mono text-sm focus:ring-1 focus:ring-primary outline-none resize-none"
                                value={data}
                                onChange={e => setData(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onSelect={handleSelect}
                                onMouseUp={handleSelect}
                                onKeyUp={handleSelect}
                                placeholder={viewMode === 'Hex' ? "00 AA BB" : viewMode === 'Decimal' ? "13 10 27" : "Sequence data... e.g. Hello<CR><LF>"}
                            />
                            <p className="text-xs text-muted-foreground mt-1">
                                {viewMode === 'Hex' ? "Space-separated hex bytes" : viewMode === 'Decimal' ? "Space-separated decimal values" : "Select text to highlight bytes →"}
                            </p>
                        </div>

                        {/* Right: Live Preview */}
                        <div className="flex-1">
                            <div className="flex justify-between items-center mb-1">
                                <label className="text-sm font-medium">Live Preview</label>
                                <div className="text-xs flex bg-muted rounded p-0.5">
                                    <button
                                        className={`px-2 py-0.5 rounded ${previewMode === 'Hex' ? 'bg-background shadow' : ''}`}
                                        onClick={() => setPreviewMode('Hex')}
                                    >HEX</button>
                                    <button
                                        className={`px-2 py-0.5 rounded ${previewMode === 'Decimal' ? 'bg-background shadow' : ''}`}
                                        onClick={() => setPreviewMode('Decimal')}
                                    >DEC</button>
                                </div>
                            </div>

                            {/* Spacer to align with Left Side Toolbar */}
                            <div className="flex gap-1 flex-wrap mb-2 invisible pointer-events-none" aria-hidden="true">
                                <button className="px-2 py-1 bg-secondary rounded text-xs font-mono">+CR</button>
                                <button className="px-2 py-1 bg-secondary rounded text-xs font-mono">+LF</button>
                                <button className="px-2 py-1 bg-secondary rounded text-xs font-mono">+NULL</button>
                                <button className="px-2 py-1 bg-secondary rounded text-xs font-mono">+CRLF</button>
                                <button className="px-2 py-1 bg-secondary rounded text-xs font-mono">+ESC</button>
                                <button className="px-2 py-1 bg-blue-600 rounded text-xs font-sans">Format EOL</button>
                            </div>

                            <div className="h-64 bg-background border rounded p-3 overflow-y-auto">
                                <div className="flex flex-wrap gap-1 font-mono text-xs">
                                    {bytes.length === 0 ? (
                                        <span className="text-muted-foreground/50">Waiting for input...</span>
                                    ) : (
                                        bytes.map((byte, idx) => {
                                            const isSelected = selectedByteIndices.has(idx);
                                            const display = previewMode === 'Hex'
                                                ? byte.toString(16).padStart(2, '0').toUpperCase()
                                                : byte.toString();
                                            const isControl = byte < 32 || byte > 126;

                                            // Solid colors for clarity (no transparency = no blur)
                                            let boxStyle = '';
                                            if (isSelected) {
                                                // Selected: solid amber/orange
                                                boxStyle = 'bg-amber-200 border-amber-500 text-amber-900';
                                            } else if (isControl) {
                                                // Control chars: solid purple
                                                boxStyle = 'bg-purple-200 border-purple-500 text-purple-900';
                                            } else {
                                                // Normal bytes: solid gray
                                                boxStyle = 'bg-gray-200 border-gray-400 text-gray-900';
                                            }

                                            return (
                                                <span
                                                    key={idx}
                                                    className={`px-2 py-1 rounded border-2 font-bold text-sm ${boxStyle}`}
                                                    title={`Char: ${byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : (byte === 13 ? 'CR' : byte === 10 ? 'LF' : byte === 27 ? 'ESC' : 'CTRL')}`}
                                                >
                                                    {display}
                                                </span>
                                            );
                                        })
                                    )}
                                </div>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                                {bytes.length} bytes • {selectedByteIndices.size > 0 ? `${selectedByteIndices.size} selected` : 'Select text on left'}
                            </p>
                        </div>
                    </div>
                </div>

                <div className="flex justify-between gap-2 pt-2 border-t">
                    <div className="flex gap-2 items-center">
                        {onDelete && (
                            <button
                                onClick={() => { onDelete(sequence); onClose(); }}
                                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm flex items-center gap-2"
                                title="Delete this sequence"
                            >
                                <Trash2 className="w-4 h-4" /> Delete
                            </button>
                        )}
                        {/* CRC Controls */}
                        <div className="flex items-center gap-1 border rounded px-2 py-1">
                            <span className="text-xs text-muted-foreground">CRC:</span>
                            <select
                                value={crcType}
                                onChange={e => setCrcType(e.target.value as CrcType)}
                                className="bg-background dark:bg-slate-800 border rounded px-2 py-1 text-xs"
                            >
                                <option value="none">None</option>
                                <option value="crc8">CRC-8</option>
                                <option value="crc16-modbus">CRC-16 MODBUS</option>
                                <option value="crc32">CRC-32</option>
                            </select>
                            <button
                                onClick={() => {
                                    if (crcType === 'none') return;
                                    const bytes = parseData(data, viewMode);
                                    const crcBytes = calculateCrc(bytes, crcType);
                                    if (crcBytes.length > 0) {
                                        const crcHex = crcBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
                                        if (viewMode === 'Hex') {
                                            setData(data.trim() + ' ' + crcHex);
                                        } else {
                                            // In ASCII/Decimal mode, append as hex
                                            setData(data + crcBytes.map(b => `<${b}>`).join(''));
                                        }
                                    }
                                }}
                                disabled={crcType === 'none'}
                                className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs flex items-center gap-1 disabled:opacity-50"
                                title="Append CRC bytes to data"
                            >
                                <Plus className="w-3 h-3" /> Append
                            </button>
                        </div>
                    </div>
                    <div className="flex gap-2 items-center">
                        {/* Periodic Send */}
                        {onSend && (
                            <div className="flex items-center gap-2 border rounded px-2 py-1">
                                <span className="text-xs text-muted-foreground">Send Periodically:</span>
                                <button
                                    onClick={() => setPeriodicEnabled(!periodicEnabled)}
                                    className={`p-1.5 rounded ${periodicEnabled ? 'bg-green-500 text-white' : 'bg-secondary hover:bg-secondary/80'}`}
                                    title={periodicEnabled ? "Stop periodic send" : "Start periodic send"}
                                >
                                    {periodicEnabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                                </button>
                                <input
                                    type="number"
                                    className="w-16 bg-background border rounded px-2 py-1 text-sm text-center"
                                    value={periodicInterval}
                                    onChange={e => setPeriodicInterval(Math.max(100, Number(e.target.value)))}
                                    min={100}
                                    title="Interval in ms"
                                />
                                <span className="text-xs text-muted-foreground">ms</span>
                            </div>
                        )}
                        <button onClick={onClose} className="px-4 py-2 border rounded hover:bg-accent text-sm">Cancel</button>
                        <button
                            onClick={() => onSave({ ...sequence, name, data, view_mode: viewMode, periodic_interval: periodicInterval, periodic_enabled: periodicEnabled })}
                            className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 text-sm flex items-center gap-2"
                        >
                            <Save className="w-4 h-4" /> Save
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
