import { Project, Sequence, Reaction } from "../types";
import { Plus, Save, Play, Upload, Edit, FastForward, Square } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from '@tauri-apps/plugin-dialog';

interface Props {
    project: Project;
    onUpdate: (p: Project) => void;
    onSend: (seq: Sequence) => void;
    onEditSequence: (seq: Sequence) => void;
    onEditReaction: (r: Reaction) => void;
    connected: boolean;
    activePeriodicIds: Set<string>;
    onStartPeriodic: (seqId: string) => void;
    onStopPeriodic: (seqId: string) => void;
}

export function ProjectSidebar({ project, onUpdate, onSend, onEditSequence, onEditReaction, connected, activePeriodicIds, onStartPeriodic, onStopPeriodic }: Props) {

    const handleSave = async () => {
        try {
            const path = await save({
                filters: [{ name: 'Plan Terminal Project', extensions: ['plant', 'json'] }]
            });
            if (!path) return;

            let finalPath = path;
            if (!finalPath.endsWith('.plant') && !finalPath.endsWith('.json')) {
                finalPath += '.plant';
            }

            await invoke("save_project_file", { path: finalPath, project });
            alert("Project saved successfully to " + finalPath);
        } catch (e) {
            console.error(e);
            alert("Error saving: " + e);
        }
    };

    const handleLoad = async () => {
        try {
            const path = await open({
                filters: [{ name: 'Plan Terminal Project', extensions: ['plant', 'json'] }]
            });
            if (!path) return;

            const loaded = await invoke<Project>("load_project_file", { path });
            // Auto-fix legacy default names
            if (loaded.name === "Untitled Project" || loaded.name === "New Project") {
                loaded.name = "Plan Terminal";
            }
            onUpdate(loaded);
        } catch (e) {
            console.error(e);
            alert("Error loading: " + e);
        }
    };

    return (
        <div className="h-full flex flex-col gap-4">
            {/* Sequences List */}
            <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="font-semibold">Send Sequences</h3>
                    <button
                        className="p-1 hover:bg-accent rounded"
                        onClick={() => {
                            const newSeq: Sequence = {
                                id: crypto.randomUUID(),
                                name: "New Sequence",
                                data: "",
                                view_mode: "Ascii"
                            };
                            onUpdate({ ...project, send_sequences: [...project.send_sequences, newSeq] });
                        }}
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-1">
                    {project.send_sequences.map(seq => {
                        const isActivelySending = activePeriodicIds.has(seq.id) && connected;
                        return (
                            <div key={seq.id} className={`flex items-center gap-2 p-2 border rounded hover:bg-accent group ${isActivelySending ? 'bg-green-500/20 border-green-500' : ''}`}>
                                {/* Click to SEND data */}
                                <div
                                    className="flex-1 cursor-pointer truncate"
                                    onClick={() => onSend(seq)}
                                    title="Click to send"
                                >
                                    <div className="font-medium text-sm flex items-center gap-1">
                                        {isActivelySending ? (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onStopPeriodic(seq.id);
                                                }}
                                                className="p-0.5 bg-red-500 rounded hover:bg-red-600"
                                                title="Stop periodic send"
                                            >
                                                <Square className="w-3 h-3 fill-current text-white" />
                                            </button>
                                        ) : seq.periodic_enabled ? (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (connected) {
                                                        onStartPeriodic(seq.id);
                                                    } else {
                                                        alert("Connect to port first!");
                                                    }
                                                }}
                                                className="p-0.5 hover:bg-blue-600 rounded"
                                                title="Start periodic send"
                                            >
                                                <FastForward className="w-3 h-3 fill-current text-blue-500" />
                                            </button>
                                        ) : (
                                            <Play className="w-3 h-3 fill-current text-green-500" />
                                        )}
                                        {seq.name}
                                        {seq.periodic_enabled && (
                                            <span className="text-xs text-blue-500 ml-1">({seq.periodic_interval}ms)</span>
                                        )}
                                    </div>
                                    <div className="text-xs text-muted-foreground truncate">{seq.data || "<empty>"}</div>
                                </div>
                                {/* Edit button */}
                                <button
                                    className="p-1.5 hover:bg-secondary rounded opacity-50 group-hover:opacity-100 transition-opacity"
                                    onClick={() => onEditSequence(seq)}
                                    title="Edit sequence"
                                >
                                    <Edit className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Reaction Rules */}
            <div className="flex-1 flex flex-col overflow-hidden min-h-[150px]">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="font-semibold">Reaction Rules</h3>
                    <button
                        className="p-1 hover:bg-accent rounded"
                        onClick={() => {
                            const newReaction: Reaction = {
                                id: crypto.randomUUID(),
                                name: "New Rule",
                                trigger_data: "",
                                response_sequence_id: "",
                                enabled: false,
                                view_mode: "Ascii"
                            };
                            onUpdate({ ...project, reactions: [...project.reactions, newReaction] });
                        }}
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-1">
                    {project.reactions.map(r => (
                        <div key={r.id} className="flex items-center gap-2 p-2 border rounded hover:bg-accent">
                            {/* Checkbox for enable/disable */}
                            <input
                                type="checkbox"
                                checked={r.enabled}
                                onChange={(e) => {
                                    e.stopPropagation();
                                    const updated = project.reactions.map(reaction =>
                                        reaction.id === r.id ? { ...reaction, enabled: e.target.checked } : reaction
                                    );
                                    onUpdate({ ...project, reactions: updated });
                                }}
                                className="w-4 h-4 accent-green-500 cursor-pointer"
                                title={r.enabled ? "Click to disable" : "Click to enable"}
                            />
                            <div className="flex-1 truncate cursor-pointer" onClick={() => onEditReaction(r)}>
                                <div className="font-medium text-sm">{r.name}</div>
                                <div className="text-xs text-muted-foreground truncate">{r.trigger_data || "<empty>"}</div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div className="flex gap-2">
                <button
                    className="flex-1 flex items-center justify-center gap-2 py-2 bg-secondary hover:bg-secondary/80 rounded font-medium text-sm"
                    onClick={handleLoad}
                    title="Load Project"
                >
                    <Upload className="w-4 h-4" /> Load
                </button>
                <button
                    className="flex-1 flex items-center justify-center gap-2 py-2 bg-secondary hover:bg-secondary/80 rounded font-medium text-sm"
                    onClick={handleSave}
                    title="Save Project"
                >
                    <Save className="w-4 h-4" /> Save
                </button>
            </div>
        </div>
    );
}
