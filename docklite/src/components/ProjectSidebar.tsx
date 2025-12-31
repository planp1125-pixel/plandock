import { Project, Sequence, Reaction } from "../types";
import { Plus, Save, Play, Upload, Edit, FastForward, Square, GripVertical } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from '@tauri-apps/plugin-dialog';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Sortable Sequence Item Component
function SortableSeqItem({ seq, isActivelySending, onSend, onEdit, onStartPeriodic, onStopPeriodic, connected }: {
    seq: Sequence;
    isActivelySending: boolean;
    onSend: (seq: Sequence) => void;
    onEdit: (seq: Sequence) => void;
    onStartPeriodic: (id: string) => void;
    onStopPeriodic: (id: string) => void;
    connected: boolean;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: seq.id });
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`flex items-center gap-1 p-2 border rounded hover:bg-accent group ${isActivelySending ? 'bg-green-500/20 border-green-500' : ''}`}
        >
            {/* Drag Handle */}
            <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing p-1 hover:bg-secondary rounded">
                <GripVertical className="w-4 h-4 text-muted-foreground" />
            </div>
            {/* Click to SEND data */}
            <div className="flex-1 cursor-pointer truncate" onClick={() => onSend(seq)} title="Click to send">
                <div className="font-medium text-sm flex items-center gap-1">
                    {isActivelySending ? (
                        <button onClick={(e) => { e.stopPropagation(); onStopPeriodic(seq.id); }} className="p-0.5 bg-red-500 rounded hover:bg-red-600" title="Stop">
                            <Square className="w-3 h-3 fill-current text-white" />
                        </button>
                    ) : seq.periodic_enabled ? (
                        <button onClick={(e) => { e.stopPropagation(); connected ? onStartPeriodic(seq.id) : alert("Connect first!"); }} className="p-0.5 hover:bg-blue-600 rounded" title="Start">
                            <FastForward className="w-3 h-3 fill-current text-blue-500" />
                        </button>
                    ) : (
                        <Play className="w-3 h-3 fill-current text-green-500" />
                    )}
                    {seq.name}
                    {seq.periodic_enabled && <span className="text-xs text-blue-500 ml-1">({seq.periodic_interval}ms)</span>}
                </div>
                <div className="text-xs text-muted-foreground truncate">{seq.data || "<empty>"}</div>
            </div>
            {/* Edit button */}
            <button className="p-1.5 hover:bg-secondary rounded opacity-50 group-hover:opacity-100" onClick={() => onEdit(seq)} title="Edit">
                <Edit className="w-3.5 h-3.5" />
            </button>
        </div>
    );
}

// Sortable Reaction Item Component
function SortableReactionItem({ reaction, onEdit, onToggle }: {
    reaction: Reaction;
    onEdit: (r: Reaction) => void;
    onToggle: (id: string, enabled: boolean) => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: reaction.id });
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

    return (
        <div ref={setNodeRef} style={style} className="flex items-center gap-1 p-2 border rounded hover:bg-accent">
            {/* Drag Handle */}
            <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing p-1 hover:bg-secondary rounded">
                <GripVertical className="w-4 h-4 text-muted-foreground" />
            </div>
            {/* Checkbox */}
            <input
                type="checkbox"
                checked={reaction.enabled}
                onChange={(e) => onToggle(reaction.id, e.target.checked)}
                className="w-4 h-4 accent-green-500 cursor-pointer"
                title={reaction.enabled ? "Disable" : "Enable"}
            />
            <div className="flex-1 truncate cursor-pointer" onClick={() => onEdit(reaction)}>
                <div className="font-medium text-sm">{reaction.name}</div>
                <div className="text-xs text-muted-foreground truncate">{reaction.trigger_data || "<empty>"}</div>
            </div>
        </div>
    );
}

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
    // DnD sensors
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    // Handle sequence drag end
    const handleSeqDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) {
            const oldIndex = project.send_sequences.findIndex(s => s.id === active.id);
            const newIndex = project.send_sequences.findIndex(s => s.id === over.id);
            onUpdate({ ...project, send_sequences: arrayMove(project.send_sequences, oldIndex, newIndex) });
        }
    };

    // Handle reaction drag end
    const handleReactionDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) {
            const oldIndex = project.reactions.findIndex(r => r.id === active.id);
            const newIndex = project.reactions.findIndex(r => r.id === over.id);
            onUpdate({ ...project, reactions: arrayMove(project.reactions, oldIndex, newIndex) });
        }
    };

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

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleSeqDragEnd}>
                    <SortableContext items={project.send_sequences.map(s => s.id)} strategy={verticalListSortingStrategy}>
                        <div className="flex-1 overflow-y-auto space-y-1">
                            {project.send_sequences.map((seq) => {
                                const isActivelySending = activePeriodicIds.has(seq.id) && connected;
                                return (
                                    <SortableSeqItem
                                        key={seq.id}
                                        seq={seq}
                                        isActivelySending={isActivelySending}
                                        onSend={onSend}
                                        onEdit={onEditSequence}
                                        onStartPeriodic={onStartPeriodic}
                                        onStopPeriodic={onStopPeriodic}
                                        connected={connected}
                                    />
                                );
                            })}
                        </div>
                    </SortableContext>
                </DndContext>
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

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleReactionDragEnd}>
                    <SortableContext items={project.reactions.map(r => r.id)} strategy={verticalListSortingStrategy}>
                        <div className="flex-1 overflow-y-auto space-y-1">
                            {project.reactions.map((r) => (
                                <SortableReactionItem
                                    key={r.id}
                                    reaction={r}
                                    onEdit={onEditReaction}
                                    onToggle={(id, enabled) => {
                                        const updated = project.reactions.map(reaction =>
                                            reaction.id === id ? { ...reaction, enabled } : reaction
                                        );
                                        onUpdate({ ...project, reactions: updated });
                                    }}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
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
        </div >
    );
}
