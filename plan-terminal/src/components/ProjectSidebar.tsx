import { Project, Sequence, Reaction } from "../types";
import { Plus, Save, Play, Upload, Edit, FastForward, Square, GripVertical, BookOpen, CheckSquare, Trash2, Search, FileDown, FileUp } from "lucide-react";
import { safeInvoke, safeOpen, safeSave, safeConfirm, safeReadTextFile, safeWriteTextFile } from '../utils/tauri';
import { useState, useRef, useEffect } from "react";
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

// Import Templates directly
import modbusRtu from "../templates/modbus_rtu.json";
import atCommands from "../templates/at_commands.json";

const AVAILABLE_TEMPLATES = [modbusRtu, atCommands];

// Sortable Sequence Item Component
function SortableSeqItem({ seq, isActivelySending, onSend, onEdit, onStartPeriodic, onStopPeriodic, connected, isSelectionMode, isSelected, onToggleSelect }: {
    seq: Sequence;
    isActivelySending: boolean;
    onSend: (seq: Sequence) => void;
    onEdit: (seq: Sequence) => void;
    onStartPeriodic: (seq: Sequence) => void;
    onStopPeriodic: (id: string) => void;
    connected: boolean;
    isSelectionMode?: boolean;
    isSelected?: boolean;
    onToggleSelect?: (seq: Sequence) => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: seq.id });
    const style = { transform: CSS.Transform.toString(transform), transition: isSelectionMode ? undefined : transition, opacity: isDragging ? 0.5 : 1 };

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`flex items-center gap-1 p-2 border rounded hover:bg-accent group ${isSelected ? 'bg-primary/10 border-primary' : isActivelySending ? 'bg-green-500/20 border-green-500' : ''}`}
        >
            {isSelectionMode ? (
                <div className="p-1 cursor-pointer flex items-center justify-center w-6" onClick={() => onToggleSelect?.(seq)}>
                    <input type="checkbox" checked={isSelected} readOnly className="w-3.5 h-3.5 accent-primary pointer-events-none" />
                </div>
            ) : (
                <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing p-1 hover:bg-secondary rounded">
                    <GripVertical className="w-4 h-4 text-muted-foreground" />
                </div>
            )}
            
            <div className="flex-1 cursor-pointer truncate" onClick={() => isSelectionMode ? onToggleSelect?.(seq) : onSend(seq)} title={isSelectionMode ? "Select sequence" : "Click to send"}>
                <div className="font-medium text-sm flex items-center gap-1">
                    {isActivelySending ? (
                        <button onClick={(e) => { e.stopPropagation(); onStopPeriodic(seq.id); }} className="p-0.5 bg-red-500 rounded hover:bg-red-600" title="Stop">
                            <Square className="w-3 h-3 fill-current text-white" />
                        </button>
                    ) : seq.periodic_enabled ? (
                        <button onClick={(e) => { e.stopPropagation(); connected ? onStartPeriodic(seq) : alert("Connect first!"); }} className="p-0.5 hover:bg-blue-600 rounded" title="Start">
                            <FastForward className="w-3 h-3 fill-current text-blue-500" />
                        </button>
                    ) : (
                        <Play className={`w-3 h-3 fill-current ${isSelectionMode ? 'text-muted-foreground/50' : 'text-green-500'}`} />
                    )}
                    {seq.name}
                    {seq.group && <span className="ml-1.5 px-1.5 py-[1px] rounded bg-blue-500/10 text-blue-500 border border-blue-500/20 text-[9px] uppercase font-bold tracking-wider shrink-0" title={`Group: ${seq.group}`}>{seq.group}</span>}
                    {seq.periodic_enabled && <span className="text-xs text-blue-500 ml-1">({seq.periodic_interval}ms)</span>}
                </div>
                <div className="text-xs text-muted-foreground truncate">{seq.data || "<empty>"}</div>
            </div>
            
            {!isSelectionMode && (
                <button className="p-1.5 hover:bg-secondary rounded opacity-50 group-hover:opacity-100 transition-opacity" onClick={() => onEdit(seq)} title="Edit">
                    <Edit className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    );
}

// Sortable Reaction Item Component
function SortableReactionItem({ reaction, onEdit, onToggle, isSelectionMode, isSelected, onToggleSelect }: {
    reaction: Reaction;
    onEdit: (r: Reaction) => void;
    onToggle: (id: string, enabled: boolean) => void;
    isSelectionMode?: boolean;
    isSelected?: boolean;
    onToggleSelect?: (r: Reaction) => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: reaction.id });
    const style = { transform: CSS.Transform.toString(transform), transition: isSelectionMode ? undefined : transition, opacity: isDragging ? 0.5 : 1 };

    return (
        <div ref={setNodeRef} style={style} className={`flex items-center gap-2 p-2 border rounded hover:bg-accent group ${isSelected ? 'bg-primary/10 border-primary' : ''}`}>
            {isSelectionMode ? (
                <div className="cursor-pointer flex items-center justify-center w-6 shrink-0" onClick={() => onToggleSelect?.(reaction)}>
                    <input type="checkbox" checked={isSelected} readOnly className="w-3.5 h-3.5 accent-primary pointer-events-none" />
                </div>
            ) : (
                <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing hover:bg-secondary rounded shrink-0 p-1">
                    <GripVertical className="w-4 h-4 text-muted-foreground" />
                </div>
            )}
            
            <div className="flex-1 truncate cursor-pointer" onClick={() => isSelectionMode ? onToggleSelect?.(reaction) : onEdit(reaction)}>
                <div className="font-medium text-sm">{reaction.name}</div>
                <div className="text-xs text-muted-foreground truncate">{reaction.trigger_data || "<empty>"}</div>
            </div>
            
            {/* iOS Style Toggle Switch for Enable/Disable */}
            {!isSelectionMode && (
                <button
                    onClick={() => onToggle(reaction.id, !reaction.enabled)}
                    className={`relative inline-flex h-4 w-8 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${reaction.enabled ? 'bg-green-500' : 'bg-zinc-300 dark:bg-zinc-700'}`}
                    role="switch"
                    aria-checked={reaction.enabled}
                    title={reaction.enabled ? "Disable Rule" : "Enable Rule"}
                >
                    <span
                        aria-hidden="true"
                        className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${reaction.enabled ? 'translate-x-4' : 'translate-x-0'}`}
                    />
                </button>
            )}
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
    onStartPeriodic: (seq: Sequence) => void;
    onStopPeriodic: (seqId: string) => void;
}

export function ProjectSidebar({ project, onUpdate, onSend, onEditSequence, onEditReaction, connected, activePeriodicIds, onStartPeriodic, onStopPeriodic }: Props) {
    // Selection state
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const [selectedSeqIds, setSelectedSeqIds] = useState<Set<string>>(new Set());
    const [isReactionSelectionMode, setIsReactionSelectionMode] = useState(false);
    const [selectedReactionIds, setSelectedReactionIds] = useState<Set<string>>(new Set());
    const [searchQuery, setSearchQuery] = useState("");

    // Filter sequences
    const filteredSequences = project.send_sequences.filter(s => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return (s.name.toLowerCase().includes(q) || 
               (s.data && s.data.toLowerCase().includes(q)) || 
               (s.group && s.group.toLowerCase().includes(q)));
    });

    // DnD sensors
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const [showTemplates, setShowTemplates] = useState(false);
    const templateRef = useRef<HTMLDivElement>(null);

    // Close template dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (templateRef.current && !templateRef.current.contains(event.target as Node)) {
                setShowTemplates(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

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

    const [saveToast, setSaveToast] = useState<string | null>(null);

    const handleSave = async () => {
        try {
            if (project.file_path) {
                // If we already have a file path, just save directly without prompting
                await safeInvoke("save_project_file", { path: project.file_path, project });

                // Show a quick, non-intrusive toast notification
                setSaveToast("Saved!");
                setTimeout(() => setSaveToast(null), 2000);
            } else {
                // Otherwise fall back to Save As
                await handleSaveAs();
            }
        } catch (e) {
            console.error(e);
            alert("Error saving: " + e);
        }
    };

    const handleSaveAs = async () => {
        try {
            const path = await safeSave({
                filters: [{ name: 'Plan Terminal Project', extensions: ['plant', 'json'] }]
            });
            if (!path) return;

            let finalPath = path;
            if (!finalPath.endsWith('.plant') && !finalPath.endsWith('.json')) {
                finalPath += '.plant';
            }

            const updatedProject = { ...project, file_path: finalPath };
            await safeInvoke("save_project_file", { path: finalPath, project: updatedProject });
            onUpdate(updatedProject); // Update local state with the new file_path
            alert("Project saved successfully to " + finalPath);
        } catch (e) {
            console.error(e);
            alert("Error saving: " + e);
        }
    };

    const handleLoad = async () => {
        try {
            const pathRes = await safeOpen({
                filters: [
                    { name: 'All Supported Files', extensions: ['plant', 'json', 'ptp'] }
                ]
            });
            if (!pathRes) return;
            const path = Array.isArray(pathRes) ? pathRes[0] : pathRes;

            let loaded: Project;
            if (path.toLowerCase().endsWith('.ptp')) {
                loaded = await safeInvoke<Project>("import_docklight_file", { path });
            } else {
                loaded = await safeInvoke<Project>("load_project_file", { path });
            }

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

    const loadTemplate = (tmpl: any) => {
        // Map template items to Sequence objects
        const newSeqs: Sequence[] = tmpl.sequences.map((s: any) => ({
            id: crypto.randomUUID(),
            name: s.name,
            data: s.data,
            view_mode: s.view_mode ? (s.view_mode.charAt(0).toUpperCase() + s.view_mode.slice(1).toLowerCase()) as "Hex" | "Ascii" | "Decimal" : "Ascii",
            periodic_enabled: false,
            periodic_interval: 1000,
            group: tmpl.name
        }));

        onUpdate({
            ...project,
            send_sequences: [...project.send_sequences, ...newSeqs]
        });

        setShowTemplates(false);
    };

    const importCustomGroup = async () => {
        try {
            const pathRes = await safeOpen({
                filters: [{ name: 'Plan Template', extensions: ['plantpl', 'json'] }]
            });
            if (!pathRes) return;
            const path = Array.isArray(pathRes) ? pathRes[0] : pathRes;
            const content = await safeReadTextFile(path);
            const parsed = JSON.parse(content);
            if (!parsed.sequences || !Array.isArray(parsed.sequences)) {
                alert("Invalid template format.");
                return;
            }
            
            const groupName = parsed.name || path.split(/[/\\]/).pop()?.replace(/\.(plantpl|json)$/, '') || "Custom Group";
            
            const newSeqs: Sequence[] = parsed.sequences.map((s: any) => ({
                id: crypto.randomUUID(),
                name: s.name || "Unnamed",
                data: s.data || "",
                view_mode: s.view_mode ? (s.view_mode.charAt(0).toUpperCase() + s.view_mode.slice(1).toLowerCase()) as "Hex" | "Ascii" | "Decimal" : "Ascii",
                periodic_enabled: false,
                periodic_interval: 1000,
                group: groupName
            }));
            onUpdate({ ...project, send_sequences: [...project.send_sequences, ...newSeqs] });
            setShowTemplates(false);
        } catch (e) {
            console.error(e);
            alert("Error importing custom group: " + e);
        }
    };

    return (
        <div className="h-full flex flex-col gap-4">
            {/* Sequences List */}
            <div className="flex-1 flex flex-col overflow-hidden relative">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="font-semibold">Send Sequences</h3>
                    <div className="flex items-center gap-1">
                        <button
                            className={`p-1 rounded ${isSelectionMode ? 'bg-primary text-primary-foreground' : 'hover:bg-accent text-muted-foreground'}`}
                            onClick={() => {
                                setIsSelectionMode(!isSelectionMode);
                                setSelectedSeqIds(new Set());
                            }}
                            title="Toggle Selection Mode"
                        >
                            <CheckSquare className="w-4 h-4" />
                        </button>
                        {/* Templates Button */}
                        <div className="relative" ref={templateRef}>
                            <button
                                className="p-1 hover:bg-accent rounded text-blue-500"
                                onClick={() => setShowTemplates(!showTemplates)}
                                title="Load Protocol Template"
                            >
                                <BookOpen className="w-4 h-4" />
                            </button>

                            {/* Dropdown */}
                            {showTemplates && (
                                <div className="absolute right-0 top-full mt-1 w-48 bg-popover border border-border rounded shadow-lg z-50 overflow-hidden">
                                    <div className="text-xs font-semibold px-3 py-2 bg-muted text-muted-foreground border-b">
                                        Protocol Templates
                                    </div>
                                    <div className="py-1">
                                        <button
                                            className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-2 text-blue-500 font-medium"
                                            onClick={importCustomGroup}
                                        >
                                            <FileUp className="w-3.5 h-3.5" /> Import Custom Group
                                        </button>
                                        <div className="border-t my-1" />
                                        {AVAILABLE_TEMPLATES.map((t, i) => (
                                            <button
                                                key={i}
                                                className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                                                onClick={() => loadTemplate(t)}
                                            >
                                                {t.name}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

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
                            title="Add New Sequence"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* Search Bar */}
                <div className="mb-2 relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <input
                        type="text"
                        placeholder="Search or filter groups..."
                        className="w-full bg-background border rounded pl-7 pr-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                    />
                </div>

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={isSelectionMode ? undefined : handleSeqDragEnd}>
                    <SortableContext items={filteredSequences.map(s => s.id)} strategy={verticalListSortingStrategy}>
                        <div className="flex-1 overflow-y-auto space-y-1 pb-14">
                            {filteredSequences.map((seq) => {
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
                                        isSelectionMode={isSelectionMode}
                                        isSelected={selectedSeqIds.has(seq.id)}
                                        onToggleSelect={(s) => {
                                            const newSet = new Set(selectedSeqIds);
                                            if (newSet.has(s.id)) newSet.delete(s.id);
                                            else newSet.add(s.id);
                                            setSelectedSeqIds(newSet);
                                        }}
                                    />
                                );
                            })}
                        </div>
                    </SortableContext>
                </DndContext>

                {/* Floating Bulk Action Bar */}
                {isSelectionMode && selectedSeqIds.size > 0 && (
                    <div className="absolute bottom-2 left-2 right-2 bg-card border shadow-lg rounded-md p-2 flex justify-between items-center z-10 animate-in slide-in-from-bottom-2">
                        <span className="text-xs font-semibold px-2">{selectedSeqIds.size} selected</span>
                        <div className="flex gap-2">
                            <button
                                className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-xs flex items-center gap-1.5 font-medium transition-colors"
                                onClick={async () => {
                                    const path = await safeSave({
                                        filters: [{ name: 'Plan Template', extensions: ['plantpl', 'json'] }],
                                        defaultPath: 'custom_group.plantpl'
                                    });
                                    if (!path) return;
                                    const selected = project.send_sequences.filter(s => selectedSeqIds.has(s.id));
                                    const exportData = {
                                        name: path.split(/[/\\]/).pop()?.replace(/\.(plantpl|json)$/, '') || 'Custom Group',
                                        sequences: selected.map(s => ({
                                            name: s.name,
                                            data: s.data,
                                            view_mode: s.view_mode
                                        }))
                                    };
                                    try {
                                        await safeWriteTextFile(path, JSON.stringify(exportData, null, 2));
                                        alert("Group exported successfully!");
                                        setIsSelectionMode(false);
                                        setSelectedSeqIds(new Set());
                                    } catch (e) {
                                        alert("Error exporting: " + e);
                                    }
                                }}
                            >
                                <FileDown className="w-3.5 h-3.5" />
                                Export
                            </button>
                            <button
                                className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-xs flex items-center gap-1.5 font-medium transition-colors"
                                onClick={async () => {
                                const yes = await safeConfirm(`Delete ${selectedSeqIds.size} sequence(s)?`, { title: 'Confirm Deletion', kind: 'warning' });
                                if (yes) {
                                    const filtered = project.send_sequences.filter(s => !selectedSeqIds.has(s.id));
                                    onUpdate({ ...project, send_sequences: filtered });
                                    setIsSelectionMode(false);
                                    setSelectedSeqIds(new Set());
                                }
                            }}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete
                        </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Reaction Rules */}
            <div className="flex-1 flex flex-col overflow-hidden min-h-[150px] relative">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="font-semibold">Reaction Rules</h3>
                    <div className="flex items-center gap-1">
                        <button
                            className={`p-1 rounded ${isReactionSelectionMode ? 'bg-primary text-primary-foreground' : 'hover:bg-accent text-muted-foreground'}`}
                            onClick={() => {
                                setIsReactionSelectionMode(!isReactionSelectionMode);
                                setSelectedReactionIds(new Set());
                            }}
                            title="Toggle Selection Mode"
                        >
                            <CheckSquare className="w-4 h-4" />
                        </button>
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
                </div>

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={isReactionSelectionMode ? undefined : handleReactionDragEnd}>
                    <SortableContext items={project.reactions.map(r => r.id)} strategy={verticalListSortingStrategy}>
                        <div className="flex-1 overflow-y-auto space-y-1 pb-14">
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
                                    isSelectionMode={isReactionSelectionMode}
                                    isSelected={selectedReactionIds.has(r.id)}
                                    onToggleSelect={(r) => {
                                        const newSet = new Set(selectedReactionIds);
                                        if (newSet.has(r.id)) newSet.delete(r.id);
                                        else newSet.add(r.id);
                                        setSelectedReactionIds(newSet);
                                    }}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>

                {/* Floating Bulk Action Bar for Reactions */}
                {isReactionSelectionMode && selectedReactionIds.size > 0 && (
                    <div className="absolute bottom-2 left-2 right-2 bg-card border shadow-lg rounded-md p-2 flex justify-between items-center z-10 animate-in slide-in-from-bottom-2">
                        <span className="text-xs font-semibold px-2">{selectedReactionIds.size} selected</span>
                        <button
                            className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-xs flex items-center gap-1.5 font-medium transition-colors"
                            onClick={async () => {
                                const yes = await safeConfirm(`Delete ${selectedReactionIds.size} rule(s)?`, { title: 'Confirm Deletion', kind: 'warning' });
                                if (yes) {
                                    const filtered = project.reactions.filter(r => !selectedReactionIds.has(r.id));
                                    onUpdate({ ...project, reactions: filtered });
                                    setIsReactionSelectionMode(false);
                                    setSelectedReactionIds(new Set());
                                }
                            }}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete
                        </button>
                    </div>
                )}
            </div>

            <div className="flex gap-2 relative">
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
                    title={project.file_path ? "Quick Save" : "Save Project"}
                >
                    <Save className="w-4 h-4" /> Save
                </button>
                {project.file_path && (
                    <button
                        className="flex-1 flex items-center justify-center gap-2 py-2 bg-secondary hover:bg-secondary/80 rounded font-medium text-sm border border-secondary"
                        onClick={handleSaveAs}
                        title="Save Project As..."
                    >
                        Save As
                    </button>
                )}

                {/* Toast Notification */}
                {saveToast && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1 bg-green-600 text-white text-xs rounded shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200 pointer-events-none whitespace-nowrap z-50">
                        {saveToast}
                    </div>
                )}
            </div>
        </div >
    );
}
