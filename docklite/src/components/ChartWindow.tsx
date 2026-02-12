import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { X, Plus, Trash2, Settings, Minimize2, Maximize2 } from 'lucide-react';
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

    // New config state
    const [newLabel, setNewLabel] = useState("");
    const [newBefore, setNewBefore] = useState("");
    const [newColor, setNewColor] = useState("#3b82f6");

    if (!isOpen) return null;

    const handleAddConfig = () => {
        if (!newLabel || !newBefore) return;
        const newConfig: ChartConfig = {
            id: crypto.randomUUID(),
            name: newLabel,
            textBefore: newBefore,
            dataType: "Number",
            color: newColor,
            enabled: true
        };
        onConfigChange([...configs, newConfig]);
        setNewLabel("");
        setNewBefore("");
    };

    const handleRemoveConfig = (id: string) => {
        onConfigChange(configs.filter(c => c.id !== id));
    };

    const toggleConfig = () => setShowConfig(!showConfig);
    const toggleMaximize = () => setIsMaximized(!isMaximized);

    // Dynamic lines
    const lines = configs.map(cfg => (
        <Line
            key={cfg.id}
            type="monotone"
            dataKey={cfg.name}
            stroke={cfg.color}
            dot={false}
            strokeWidth={2}
            isAnimationActive={false} // Performance optimization
        />
    ));

    return (
        <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 ${isMaximized ? 'p-0' : ''}`}>
            <div className={`bg-slate-900 border border-slate-700 rounded-lg shadow-2xl flex flex-col overflow-hidden transition-all duration-300 ${isMaximized ? 'w-full h-full rounded-none' : 'w-[90vw] h-[80vh]'}`}>

                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 bg-slate-800 border-b border-slate-700">
                    <div className="flex items-center gap-2">
                        <span className="text-blue-400 font-bold text-lg">📈 Real-Time Plotter</span>
                        <span className="text-slate-500 text-sm">({data.length} points)</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={onClearData} className="px-3 py-1 text-xs bg-red-900/30 text-red-400 rounded hover:bg-red-900/50">Clear Data</button>
                        <button onClick={toggleConfig} className={`p-2 rounded hover:bg-slate-700 ${showConfig ? 'text-blue-400' : 'text-slate-400'}`} title="Toggle Config">
                            <Settings size={18} />
                        </button>
                        <button onClick={toggleMaximize} className="p-2 rounded hover:bg-slate-700 text-slate-400" title={isMaximized ? "Minimize" : "Maximize"}>
                            {isMaximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                        </button>
                        <button onClick={onClose} className="p-2 rounded hover:bg-red-900/50 text-slate-400 hover:text-red-400">
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 flex overflow-hidden">

                    {/* Simplified Chart Area */}
                    <div className="flex-1 p-4 bg-slate-950/50 relative">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={data}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.5} />
                                <XAxis
                                    dataKey="timestamp"
                                    type="number"
                                    domain={['auto', 'auto']}
                                    tickFormatter={(ts) => new Date(ts).toLocaleTimeString()}
                                    stroke="#94a3b8"
                                    fontSize={12}
                                />
                                <YAxis stroke="#94a3b8" fontSize={12} />
                                <Tooltip
                                    labelFormatter={(ts) => new Date(ts).toLocaleString()}
                                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#475569', color: '#e2e8f0' }}
                                />
                                <Legend />
                                {lines}
                            </LineChart>
                        </ResponsiveContainer>
                    </div>

                    {/* Config Sidebar */}
                    {showConfig && (
                        <div className="w-80 bg-slate-800/50 border-l border-slate-700 p-4 overflow-y-auto flex flex-col gap-4">
                            <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Signals</h3>

                            {/* Input Form */}
                            <div className="bg-slate-900/50 p-3 rounded-md border border-slate-700 space-y-3">
                                <div>
                                    <label className="text-xs text-slate-400 block mb-1">Variable Name (Label)</label>
                                    <input
                                        value={newLabel}
                                        onChange={e => setNewLabel(e.target.value)}
                                        placeholder="e.g. Temperature"
                                        className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-white focus:border-blue-500 outline-none"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-slate-400 block mb-1">Text Before Value (Trigger)</label>
                                    <div className="flex gap-2">
                                        <input
                                            value={newBefore}
                                            onChange={e => setNewBefore(e.target.value)}
                                            placeholder="e.g. Temp:"
                                            className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-white focus:border-blue-500 outline-none font-mono"
                                        />
                                    </div>
                                    <p className="text-[10px] text-slate-500 mt-1">Extracts number immediately following this text.</p>
                                </div>
                                <div>
                                    <label className="text-xs text-slate-400 block mb-1">Line Color</label>
                                    <input
                                        type="color"
                                        value={newColor}
                                        onChange={e => setNewColor(e.target.value)}
                                        className="w-full h-8 bg-slate-800 border border-slate-600 rounded cursor-pointer"
                                    />
                                </div>
                                <button
                                    onClick={handleAddConfig}
                                    disabled={!newLabel || !newBefore}
                                    className="w-full py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Plus size={16} /> Add Signal
                                </button>
                            </div>

                            {/* List */}
                            <div className="space-y-2">
                                {configs.map(cfg => (
                                    <div key={cfg.id} className="flex items-center justify-between p-2 bg-slate-800 border border-slate-700 rounded hover:border-slate-600 group">
                                        <div className="flex items-center gap-2 overflow-hidden">
                                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: cfg.color }}></div>
                                            <div className="grid">
                                                <span className="text-sm font-medium text-slate-200 truncate">{cfg.name}</span>
                                                <span className="text-xs text-slate-500 font-mono truncate">Trigger: "{cfg.textBefore}"</span>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleRemoveConfig(cfg.id)}
                                            className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                ))}
                                {configs.length === 0 && (
                                    <div className="text-center py-8 text-slate-600 text-sm">
                                        No signals configured.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
