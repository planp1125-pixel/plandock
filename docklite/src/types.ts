export interface PortInfo {
    port_name: string;
    info: string;
}

export interface SerialConfig {
    port_name: string;
    baud_rate: number;
    data_bits: number;
    flow_control: string;
    parity: string;
    stop_bits: number;
}

export interface Sequence {
    id: string;
    name: string;
    data: string; // Hex string for easy editing
    view_mode: "Hex" | "Ascii" | "Decimal" | "Binary";
    hotkey?: string;
    periodic_interval?: number; // Interval in ms for periodic sending
    periodic_enabled?: boolean; // Whether periodic sending is active
}

export interface Reaction {
    id: string; // Added ID
    name: string;
    trigger_data: string;
    response_sequence_id: string;
    enabled: boolean;
    view_mode: "Hex" | "Ascii" | "Decimal" | "Binary";
}

export interface Project {
    name: string;
    send_sequences: Sequence[];
    reactions: Reaction[];
    serial_config?: SerialConfig;
}
