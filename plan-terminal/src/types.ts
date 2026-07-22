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
    group?: string; // Identifier for template groups
}

export interface ReactionAction {
    sequence_id: string;
    delay_ms: number;
}

export interface Reaction {
    id: string; // Added ID
    name: string;
    trigger_data: string;
    response_sequence_id?: string; // Kept for backward compatibility
    actions?: ReactionAction[];
    enabled: boolean;
    view_mode: "Hex" | "Ascii" | "Decimal" | "Binary";
}

export interface TcpConfig {
    host: string;
    port: number;
    mode?: 'client' | 'server';
}

export interface SshConfig {
    host: string;
    port: number;
    username: string; // Password excluded intentionally from raw UI unless private key path
    auth_mode?: string; // "password" | "private_key"
    auth_secret?: string; // e.g. path to private key
}

export interface RemoteConfig {
    deviceId: string;
}

export interface Project {
    name: string;
    send_sequences: Sequence[];
    reactions: Reaction[];
    file_path?: string;
    connection_type?: 'Serial' | 'TCP' | 'SSH' | 'Remote';
    serial_config?: SerialConfig;
    tcp_config?: TcpConfig;
    ssh_config?: SshConfig;
    remote_config?: RemoteConfig;
    chart_configs?: any[];
}
