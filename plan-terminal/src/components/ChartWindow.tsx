import { useState, useRef, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { X, Plus, Trash2, Settings, Minimize2, Maximize2, GripHorizontal, ArrowDownRight } from 'lucide-react';
import { ChartConfig } from '../chart_utils';

interface ChartWindowProps {
    isOpen: boolean;
    onClose: () => void;
    data: any[];
    configs: ChartConfig[];
    onConfigChange: (configs: ChartConfig[]) => void;
    onClearData: () => void;
}

export function ChartWindow({ isOpen, onClose, data, configs, onConfigChange, onClearData }: ChartWindowProps) {
    const [isMaximized, setIsMaximized] = useState(false);
    const [showConfig, setShowConfig] = useState(true);

    // Floating Window State
    const [position, setPosition] = useState({ x: 100, y: 100 });
    const [size, setSize] = useState({ width: 800, height: 500 }); // Added Size State
    const [isDragging, setIsDragging] = useState(false);
    const [isResizing, setIsResizing] = useState(false); // Added Resize State
    const dragStartRef = useRef<{ x: number, y: number } | null>(null);
    const resizeStartRef = useRef<{ x: number, y: number, w: number, h: number } | null>(null); // Added Resize Ref

    // New config state
    const [newLabel, setNewLabel] = useState("");
    const [newBefore, setNewBefore] = useState("");
    const [newAfter, setNewAfter] = useState(""); // Add newAfter
    const [newColor, setNewColor] = useState("#3b82f6");
    const [useRegex, setUseRegex] = useState(false); // Add useRegex
    const [dataType, setDataType] = useState<"Number" | "Word">("Number"); // Add dataType

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isDragging && dragStartRef.current) {
                const dx = e.clientX - dragStartRef.current.x;
                const dy = e.clientY - dragStartRef.current.y;
                setPosition(prev => ({ x: prev.x + dx, y: prev.y + dy }));
                dragStartRef.current = { x: e.clientX, y: e.clientY };
            }
            if (isResizing && resizeStartRef.current) {
                const dx = e.clientX - resizeStartRef.current.x;
                const dy = e.clientY - resizeStartRef.current.y;
                // Min size 400x300
                setSize({
                    width: Math.max(400, resizeStartRef.current.w + dx),
                    height: Math.max(300, resizeStartRef.current.h + dy)
                });
            }
        };

        const handleMouseUp = () => {
            setIsDragging(false);
            setIsResizing(false);
            dragStartRef.current = null;
            resizeStartRef.current = null;
        };

        if (isDragging || isResizing) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, isResizing]);

    if (!isOpen) return null;

    const handleMouseDown = (e: React.MouseEvent) => {
        if (isMaximized) return;
        setIsDragging(true);
        dragStartRef.current = { x: e.clientX, y: e.clientY };
    };

    const handleResizeMouseDown = (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        setIsResizing(true);
        // Capture initial size
        resizeStartRef.current = { x: e.clientX, y: e.clientY, w: size.width, h: size.height };
    };

    const handleAddConfig = () => {
        if (!newLabel || !newBefore) return;
        const newConfig: ChartConfig = {
            id: crypto.randomUUID(),
            name: newLabel,
            textBefore: newBefore,
            textAfter: useRegex ? undefined : newAfter, // Only use after if not regex (or let regex handle it)
            useRegex,
            dataType,
            color: newColor,
            enabled: true
        };
        onConfigChange([...configs, newConfig]);
        // Reset form
        setNewLabel("");
        setNewBefore("");
        setNewAfter("");
        // Keep color/type/regex settings as they might be adding similar lines
    };

    const handleRemoveConfig = (id: string) => {
        onConfigChange(configs.filter(c => c.id !== id));
    };

    const toggleConfig = () => setShowConfig(!showConfig);
    const toggleMaximize = () => {
        setIsMaximized(!isMaximized);
        if (isMaximized) {
            // Reset to default/last known size if un-maximizing
            setPosition({ x: 100, y: 100 });
            setSize({ width: 800, height: 500 });
        }
    };

    // Dynamic lines
    const lines = configs.map(cfg => (
        <Line
            key={cfg.id}
            type="monotone"
            dataKey={cfg.name}
            stroke={cfg.color}
            dot={false}
            strokeWidth={2}
            isAnimationActive={false}
        />
    ));

    const windowStyle: React.CSSProperties = isMaximized ? {
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 50
    } : {
        position: 'fixed',
        left: position.x,
        top: position.y,
        width: `${size.width}px`,
        height: `${size.height}px`,
        zIndex: 50,
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
    };

    return (
        <div
            style={windowStyle}
            className="flex flex-col bg-background border border-border rounded-lg overflow-hidden shadow-2xl transition-shadow backdrop-blur-sm relative text-foreground"
        >
            {/* Header - Drag Handle */}
            <div
                className={`flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border select-none ${!isMaximized ? 'cursor-grab active:cursor-grabbing' : ''}`}
                onMouseDown={handleMouseDown}
            >
                <div className="flex items-center gap-2">
                    <GripHorizontal className="text-muted-foreground w-4 h-4" />
                    <span className="text-primary font-bold text-sm">📈 Real-Time Plotter</span>
                    <span className="text-muted-foreground text-xs">({data.length} pts)</span>
                </div>
                <div className="flex items-center gap-1" onMouseDown={e => e.stopPropagation()}>
                    <button onClick={onClearData} className="px-2 py-0.5 text-[10px] bg-red-500/10 text-red-500 hover:bg-red-500/20 rounded mr-2">Clear</button>
                    <button onClick={toggleConfig} className={`p-1.5 rounded hover:bg-accent ${showConfig ? 'text-primary' : 'text-muted-foreground'}`} title="Toggle Config">
                        <Settings size={14} />
                    </button>
                    <button onClick={toggleMaximize} className="p-1.5 rounded hover:bg-accent text-muted-foreground" title={isMaximized ? "Minimize" : "Maximize"}>
                        {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                    <button onClick={onClose} className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-500">
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 flex overflow-hidden">

                {/* Simplified Chart Area */}
                <div className="flex-1 p-2 bg-background/50 relative">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={data}>
                            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                            <XAxis
                                dataKey="timestamp"
                                type="number"
                                domain={['auto', 'auto']}
                                tickFormatter={(ts) => new Date(ts).toLocaleTimeString()}
                                stroke="currentColor"
                                fontSize={10}
                                tick={{ fill: 'currentColor', opacity: 0.5 }}
                            />
                            <YAxis
                                stroke="currentColor"
                                fontSize={10}
                                tick={{ fill: 'currentColor', opacity: 0.5 }}
                            />
                            <Tooltip
                                labelFormatter={(ts) => new Date(ts).toLocaleString()}
                                contentStyle={{
                                    backgroundColor: 'hsl(var(--popover))',
                                    borderColor: 'hsl(var(--border))',
                                    color: 'hsl(var(--popover-foreground))',
                                    fontSize: '12px'
                                }}
                            />
                            <Legend wrapperStyle={{ fontSize: '12px', opacity: 0.7 }} />
                            {lines}
                        </LineChart>
                    </ResponsiveContainer>
                </div>

                {/* Config Sidebar */}
                {showConfig && (
                    <div className="w-64 bg-muted/20 border-l border-border p-3 overflow-y-auto flex flex-col gap-3 text-sm">

                        {/* Input Form */}
                        <div className="bg-card p-2 rounded border border-border space-y-2">
                            <div className="flex gap-2">
                                <input
                                    value={newLabel}
                                    onChange={e => setNewLabel(e.target.value)}
                                    placeholder="Label"
                                    className="flex-1 bg-background dark:bg-slate-800 border border-input rounded px-2 py-1 text-xs text-foreground focus:ring-1 focus:ring-primary outline-none"
                                />
                                <input
                                    type="color"
                                    value={newColor}
                                    onChange={e => setNewColor(e.target.value)}
                                    className="w-6 h-full bg-background dark:bg-slate-800 border border-input rounded cursor-pointer p-0"
                                />
                            </div>

                            <div>
                                <input
                                    value={newBefore}
                                    onChange={e => setNewBefore(e.target.value)}
                                    placeholder={useRegex ? "Regex Pattern (capture group 1)" : "Start Trigger (e.g. T=)"}
                                    className="w-full bg-background dark:bg-slate-800 border border-input rounded px-2 py-1 text-xs text-foreground focus:ring-1 focus:ring-primary outline-none font-mono"
                                />
                            </div>

                            {!useRegex && (
                                <div>
                                    <input
                                        value={newAfter}
                                        onChange={e => setNewAfter(e.target.value)}
                                        placeholder="End Trigger (Optional)"
                                        className="w-full bg-background dark:bg-slate-800 border border-input rounded px-2 py-1 text-xs text-foreground focus:ring-1 focus:ring-primary outline-none font-mono"
                                    />
                                </div>
                            )}

                            <div className="flex items-center justify-between gap-2">
                                <select
                                    value={dataType}
                                    onChange={e => setDataType(e.target.value as any)}
                                    className="bg-background dark:bg-slate-800 border border-input rounded px-2 py-1 text-xs text-foreground focus:ring-1 focus:ring-primary outline-none"
                                >
                                    <option value="Number">Number</option>
                                    <option value="Word">Word</option>
                                </select>
                                <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer select-none">
                                    <input
                                        type="checkbox"
                                        checked={useRegex}
                                        onChange={e => setUseRegex(e.target.checked)}
                                        className="rounded border-input bg-background text-primary focus:ring-primary"
                                    />
                                    Regex
                                </label>
                            </div>

                            <button
                                onClick={handleAddConfig}
                                disabled={!newLabel || !newBefore}
                                className="w-full py-1 bg-primary hover:bg-primary/90 text-primary-foreground rounded text-xs font-medium flex items-center justify-center gap-1 disabled:opacity-50"
                            >
                                <Plus size={12} /> Add Line
                            </button>
                        </div>

                        {/* List */}
                        <div className="space-y-1">
                            {configs.map(cfg => (
                                <div key={cfg.id} className="flex flex-col p-1.5 bg-card border border-border rounded hover:border-accent group">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2 overflow-hidden">
                                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cfg.color }}></div>
                                            <span className="text-xs font-medium text-foreground truncate">{cfg.name}</span>
                                        </div>
                                        <button
                                            onClick={() => handleRemoveConfig(cfg.id)}
                                            className="text-muted-foreground hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground font-mono truncate pl-4">
                                        {cfg.useRegex ? <span className="text-purple-500">Rx: </span> : "Start: "}"{cfg.textBefore}"
                                        {!cfg.useRegex && cfg.textAfter && <span className="ml-1">End: "{cfg.textAfter}"</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Resize Handle */}
            {!isMaximized && (
                <div
                    className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize flex items-end justify-end p-0.5 text-muted-foreground hover:text-foreground"
                    onMouseDown={handleResizeMouseDown}
                >
                    <ArrowDownRight size={14} />
                </div>
            )}
        </div>
    );
}
