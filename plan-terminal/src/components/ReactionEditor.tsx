import { useState, useEffect, useRef } from "react";
import { Reaction, Sequence, ReactionAction } from "../types";
import { X, Save, ChevronDown, Trash2 } from "lucide-react";
import { parseData, bytesToHex, bytesToBin } from "../utils";


interface Props {
    reaction: Reaction;
    sequences: Sequence[];
    isOpen: boolean;
    onClose: () => void;
    onSave: (r: Reaction) => void;
    onDelete?: (r: Reaction) => void;
}

export function ReactionEditor({ reaction, sequences, isOpen, onClose, onSave, onDelete }: Props) {
    const [name, setName] = useState(reaction.name);
    const [triggerData, setTriggerData] = useState(reaction.trigger_data);
    const [actions, setActions] = useState<ReactionAction[]>(() => {
        if (reaction.actions && reaction.actions.length > 0) return [...reaction.actions];
        if (reaction.response_sequence_id) return [{ sequence_id: reaction.response_sequence_id, delay_ms: 0 }];
        return [];
    });
    const [enabled, setEnabled] = useState(reaction.enabled);
    const [viewMode, setViewMode] = useState<"Ascii" | "Hex" | "Decimal" | "Binary">("Ascii");
    const [previewMode, setPreviewMode] = useState<'Hex' | 'Decimal'>('Hex');
    const [selectionRange, setSelectionRange] = useState<{ start: number, end: number } | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const insertAtCursor = (textToInsert: string) => {
        const textarea = textareaRef.current;
        if (!textarea) {
            setTriggerData((d: string) => d + textToInsert);
            return;
        }
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newData = triggerData.substring(0, start) + textToInsert + triggerData.substring(end);
        setTriggerData(newData);
        setTimeout(() => {
            textarea.selectionStart = textarea.selectionEnd = start + textToInsert.length;
            textarea.focus();
        }, 0);
    };

    useEffect(() => {
        setName(reaction.name);
        if (reaction.actions && reaction.actions.length > 0) {
            setActions([...reaction.actions]);
        } else if (reaction.response_sequence_id) {
            setActions([{ sequence_id: reaction.response_sequence_id, delay_ms: 0 }]);
        } else {
            setActions([]);
        }
        setEnabled(reaction.enabled);

        // Handle Data Conversion on Load
        let initialData = reaction.trigger_data;
        const initialViewMode = reaction.view_mode || "Ascii";

        if (initialViewMode === 'Ascii') {
            const isHexString = /^([0-9A-Fa-f]{2}\s*)+$/.test(reaction.trigger_data.trim());
            if (isHexString) {
                try {
                    const bytes = parseData(reaction.trigger_data, 'Hex');
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
                    console.warn("Failed to auto-convert hex to ascii on reaction load", e);
                }
            }
        }

        setTriggerData(initialData);
        setViewMode(initialViewMode);
    }, [reaction]);

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
    const bytes = parseData(triggerData, viewMode);

    // Calculate which bytes are selected based on character selection
    const getSelectedByteIndices = (): Set<number> => {
        if (!selectionRange || viewMode !== 'Ascii') return new Set();

        const selectedIndices = new Set<number>();
        const tagPattern = /<(CR|LF|CRLF|ESC|NUL|\d+)>/gi;
        let lastIndex = 0;
        let match;

        interface Segment { start: number; end: number; bytes: number; }
        const segments: Segment[] = [];

        while ((match = tagPattern.exec(triggerData)) !== null) {
            if (match.index > lastIndex) {
                segments.push({ start: lastIndex, end: match.index, bytes: match.index - lastIndex });
            }
            const tag = match[1].toUpperCase();
            let tagBytes = 1;
            if (tag === 'CRLF') tagBytes = 2;
            segments.push({ start: match.index, end: match.index + match[0].length, bytes: tagBytes });
            lastIndex = match.index + match[0].length;
        }
        if (lastIndex < triggerData.length) {
            segments.push({ start: lastIndex, end: triggerData.length, bytes: triggerData.length - lastIndex });
        }

        let currentByteIndex = 0;
        for (const seg of segments) {
            const segBytes = seg.bytes;
            if (selectionRange.end > seg.start && selectionRange.start < seg.end) {
                for (let i = 0; i < segBytes; i++) {
                    selectedIndices.add(currentByteIndex + i);
                }
            }
            currentByteIndex += segBytes;
        }

        return selectedIndices;
    };

    const selectedByteIndices = getSelectedByteIndices();

    // Convert data when switching modes
    const convertToAscii = () => {
        if (viewMode !== 'Ascii') {
            const bytes = parseData(triggerData, viewMode);
            let ascii = '';
            for (const byte of bytes) {
                if (byte === 13) ascii += '<CR>';
                else if (byte === 10) ascii += '<LF>';
                else if (byte === 27) ascii += '<ESC>';
                else if (byte === 0) ascii += '<NUL>';
                else if (byte < 32 || byte > 126) ascii += `<${byte}>`;
                else ascii += String.fromCharCode(byte);
            }
            setTriggerData(ascii);
        }
        setViewMode('Ascii');
    };

    const convertToHex = () => {
        const hex = bytesToHex(parseData(triggerData, viewMode));
        setTriggerData(hex);
        setViewMode('Hex');
    };

    const convertToDecimal = () => {
        const bytes = parseData(triggerData, viewMode);
        setTriggerData(bytes.join(' '));
        setViewMode('Decimal');
    };

    const convertToBinary = () => {
        const bin = bytesToBin(parseData(triggerData, viewMode));
        setTriggerData(bin);
        setViewMode('Binary');
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-card border w-full max-w-4xl h-[85vh] overflow-y-auto p-4 rounded-lg shadow-lg flex flex-col gap-4">
                <div className="flex justify-between items-center header">
                    <h3 className="font-semibold text-lg">Edit Reaction Rule</h3>
                    <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="w-4 h-4" /></button>
                </div>

                <div className="space-y-4 flex-1">
                    <div className="flex gap-4">
                        <div className="flex-1">
                            <label className="text-sm font-medium">Rule Name</label>
                            <input
                                className="w-full bg-background border rounded px-3 py-2 mt-1"
                                value={name}
                                onChange={e => setName(e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="text-sm font-medium">Status</label>
                            <label className="flex items-center gap-2 text-sm cursor-pointer border rounded px-3 py-2 mt-1 hover:bg-accent select-none">
                                <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
                                {enabled ? "Active" : "Disabled"}
                            </label>
                        </div>
                    </div>

                    {/* Side-by-side container */}
                    <div className="flex gap-4">
                        {/* Left: Trigger Editor */}
                        <div className="flex-1">
                            <div className="flex justify-between items-center mb-1">
                                <label className="text-sm font-medium">Trigger Sequence</label>
                                <div className="text-xs flex bg-muted rounded p-0.5">
                                    <button
                                        className={`px-2 py-0.5 rounded ${viewMode === 'Ascii' ? 'bg-background shadow' : ''}`}
                                        onClick={convertToAscii}
                                    >ASCII</button>
                                    <button
                                        className={`px-2 py-0.5 rounded ${viewMode === 'Hex' ? 'bg-background shadow' : ''}`}
                                        onClick={convertToHex}
                                    >HEX</button>
                                    <button
                                        className={`px-2 py-0.5 rounded ${viewMode === 'Decimal' ? 'bg-background shadow' : ''}`}
                                        onClick={convertToDecimal}
                                    >DEC</button>
                                    <button
                                        className={`px-2 py-0.5 rounded ${viewMode === 'Binary' ? 'bg-background shadow' : ''}`}
                                        onClick={convertToBinary}
                                    >BIN</button>
                                </div>
                            </div>

                            {/* Toolbar Buttons */}
                            <div className="flex gap-1 flex-wrap mb-2">
                                <button
                                    onClick={() => viewMode === 'Ascii' ? insertAtCursor("<CR>") : insertAtCursor(viewMode === 'Hex' ? " 0D" : viewMode === 'Binary' ? " 00001101" : " 13")}
                                    className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs font-mono"
                                    title="Insert Carriage Return"
                                >+CR</button>
                                <button
                                    onClick={() => viewMode === 'Ascii' ? insertAtCursor("<LF>") : insertAtCursor(viewMode === 'Hex' ? " 0A" : viewMode === 'Binary' ? " 00001010" : " 10")}
                                    className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs font-mono"
                                    title="Insert Line Feed"
                                >+LF</button>
                                <button
                                    onClick={() => viewMode === 'Ascii' ? insertAtCursor("<NUL>") : insertAtCursor(viewMode === 'Hex' ? " 00" : viewMode === 'Binary' ? " 00000000" : " 0")}
                                    className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs font-mono"
                                    title="Insert Null"
                                >+NULL</button>
                                <button
                                    onClick={() => viewMode === 'Ascii' ? insertAtCursor("<CR><LF>") : insertAtCursor(viewMode === 'Hex' ? " 0D 0A" : viewMode === 'Binary' ? " 00001101 00001010" : " 13 10")}
                                    className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs font-mono"
                                    title="Insert CR+LF"
                                >+CRLF</button>
                                <button
                                    onClick={() => viewMode === 'Ascii' ? insertAtCursor("<ESC>") : insertAtCursor(viewMode === 'Hex' ? " 1B" : viewMode === 'Binary' ? " 00011011" : " 27")}
                                    className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded text-xs font-mono"
                                    title="Insert Escape"
                                >+ESC</button>
                            </div>

                            <textarea
                                ref={textareaRef}
                                className="w-full h-48 bg-background border rounded px-3 py-2 font-mono text-sm focus:ring-1 focus:ring-primary outline-none resize-none"
                                value={triggerData}
                                onChange={e => setTriggerData(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onSelect={handleSelect}
                                onMouseUp={handleSelect}
                                onKeyUp={handleSelect}
                                placeholder={viewMode === 'Hex' ? "00 AA BB" : viewMode === 'Decimal' ? "13 10 27" : viewMode === 'Binary' ? "01001000 01100101" : "Trigger sequence... e.g. OK<CR><LF>"}
                            />
                            <p className="text-xs text-muted-foreground mt-1">
                                {viewMode === 'Hex' ? "Space-separated hex bytes" : viewMode === 'Decimal' ? "Space-separated decimal values" : viewMode === 'Binary' ? "Space-separated 8-bit binary values" : "Select text to highlight bytes →"}
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

                            {/* Spacer for toolbar alignment */}
                            <div className="flex gap-1 flex-wrap mb-2 invisible pointer-events-none" aria-hidden="true">
                                <button className="px-2 py-1 bg-secondary rounded text-xs font-mono">+CR</button>
                                <button className="px-2 py-1 bg-secondary rounded text-xs font-mono">+LF</button>
                                <button className="px-2 py-1 bg-secondary rounded text-xs font-mono">+NULL</button>
                                <button className="px-2 py-1 bg-secondary rounded text-xs font-mono">+CRLF</button>
                                <button className="px-2 py-1 bg-secondary rounded text-xs font-mono">+ESC</button>
                            </div>

                            <div className="h-48 bg-background border rounded p-3 overflow-y-auto">
                                <div className="flex flex-wrap gap-1.5 font-mono text-sm">
                                    {bytes.length === 0 ? (
                                        <span className="text-muted-foreground/50">Waiting for input...</span>
                                    ) : (
                                        bytes.map((byte, idx) => {
                                            const isSelected = selectedByteIndices.has(idx);
                                            const display = previewMode === 'Hex'
                                                ? byte.toString(16).padStart(2, '0').toUpperCase()
                                                : byte.toString();
                                            const isControl = byte < 32 || byte > 126;

                                            // Solid colors for clarity
                                            let boxStyle = '';
                                            if (isSelected) {
                                                boxStyle = 'bg-amber-200 border-amber-500 text-amber-900';
                                            } else if (isControl) {
                                                boxStyle = 'bg-purple-200 border-purple-500 text-purple-900';
                                            } else {
                                                boxStyle = 'bg-gray-200 border-gray-400 text-gray-900';
                                            }

                                            return (
                                                <span
                                                    key={idx}
                                                    className={`px-2 py-1 rounded border-2 font-bold ${boxStyle}`}
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

                    <div>
                        <div className="flex justify-between items-center mb-2">
                            <label className="text-sm font-medium">Auto-Response Actions</label>
                            <button 
                                onClick={() => setActions([...actions, { sequence_id: sequences[0]?.id || '', delay_ms: 0 }])}
                                className="px-2 py-1 text-xs bg-secondary text-secondary-foreground rounded hover:bg-secondary/80"
                            >+ Add Response</button>
                        </div>
                        
                        <div className="space-y-2 max-h-[25vh] overflow-y-auto pr-2">
                            {actions.length === 0 && <div className="text-sm text-muted-foreground p-3 border border-dashed rounded text-center">No auto-responses. Add one to send replies when triggered.</div>}
                            {actions.map((action, idx) => (
                                <div key={idx} className="flex gap-2 items-center bg-muted/30 p-2 rounded border">
                                    <div className="text-xs font-mono w-6 text-center text-muted-foreground">{idx + 1}</div>
                                    <div className="flex-1 relative">
                                        <select
                                            className="w-full rounded px-2 py-1 text-sm border bg-background appearance-none pr-6"
                                            value={action.sequence_id}
                                            onChange={e => {
                                                const newActions = [...actions];
                                                newActions[idx].sequence_id = e.target.value;
                                                setActions(newActions);
                                            }}
                                        >
                                            <option value="">(Select Sequence)</option>
                                            {sequences.map(s => (
                                                <option key={s.id} value={s.id}>{s.name} ({s.data ? s.data.substring(0, 10) + '...' : 'empty'})</option>
                                            ))}
                                        </select>
                                        <ChevronDown className="absolute right-2 top-[50%] -translate-y-1/2 w-4 h-4 pointer-events-none opacity-50" />
                                    </div>
                                    <div className="w-24">
                                        <div className="relative">
                                            <input
                                                type="number"
                                                className="w-full rounded px-2 py-1 text-sm border bg-background pr-6"
                                                value={action.delay_ms}
                                                onChange={e => {
                                                    const newActions = [...actions];
                                                    newActions[idx].delay_ms = parseInt(e.target.value) || 0;
                                                    setActions(newActions);
                                                }}
                                                min="0"
                                                title="Delay before sending this response (milliseconds)"
                                            />
                                            <span className="absolute right-2 top-[50%] -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">ms</span>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => {
                                            const newActions = [...actions];
                                            newActions.splice(idx, 1);
                                            setActions(newActions);
                                        }}
                                        className="p-1 hover:bg-red-500/20 text-red-500 rounded transition-colors"
                                        title="Remove response"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="flex justify-between gap-2 pt-2 border-t">
                    <div>
                        {onDelete && (
                            <button
                                onClick={() => { onDelete(reaction); onClose(); }}
                                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm flex items-center gap-2"
                                title="Delete this rule"
                            >
                                <Trash2 className="w-4 h-4" /> Delete
                            </button>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <button onClick={onClose} className="px-4 py-2 border rounded hover:bg-accent text-sm">Cancel</button>
                    <button
                        onClick={() => onSave({ ...reaction, name, trigger_data: triggerData, actions, enabled, view_mode: viewMode })}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 text-sm flex items-center gap-2"
                    >
                        <Save className="w-4 h-4" /> Save Rule
                    </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
