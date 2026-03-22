use crate::serial_manager::SerialConfig;
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Sequence {
    pub id: String,
    pub name: String,
    pub data: String, // Hex string or just keep vec<u8>? storing as hex string in JSON is easier to read
    pub view_mode: String, // "Hex", "Ascii"
    pub hotkey: Option<String>,
    pub periodic_enabled: Option<bool>,
    pub periodic_interval: Option<u64>,
}

pub fn parse_hex_string(hex_str: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    for part in hex_str.split_whitespace() {
        match u8::from_str_radix(part, 16) {
            Ok(b) => bytes.push(b),
            Err(_) => return Err(format!("Invalid hex byte: {}", part)),
        }
    }
    Ok(bytes)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Reaction {
    pub id: String,
    pub name: String,
    pub trigger_data: String, // Hex string
    pub response_sequence_id: String,
    pub enabled: bool,
    pub view_mode: String, // "Hex" or "Ascii"
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TcpConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_mode: Option<String>,
    pub auth_secret: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Project {
    pub name: String,
    pub send_sequences: Vec<Sequence>,
    pub reactions: Vec<Reaction>,
    pub file_path: Option<String>,
    pub connection_type: Option<String>,
    pub serial_config: Option<SerialConfig>,
    pub tcp_config: Option<TcpConfig>,
    pub ssh_config: Option<SshConfig>,
}

impl Project {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self {
            name: "Plan Terminal".to_string(),
            send_sequences: vec![],
            reactions: vec![],
            file_path: None,
            connection_type: None,
            serial_config: None,
            tcp_config: None,
            ssh_config: None,
        }
    }
}

pub fn save_project(path: &str, project: &Project) -> Result<(), String> {
    let json = serde_json::to_string_pretty(project).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn load_project(path: &str) -> Result<Project, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut project: Project = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Post-process logic: If stored data is Hex but view_mode is Ascii, convert it.
    // This supports the use case where the JSON file acts as a hex library.

    // 1. Process Send Sequences
    for seq in &mut project.send_sequences {
        // Try to detect if data is a hex string (space separated bytes)
        // We do this regardless of the stored view_mode because users might save in Hex
        // but want to load as ASCII if it's their "library" format.

        if seq.data.trim().is_empty() {
            continue;
        }

        let parts: Vec<&str> = seq.data.split_whitespace().collect();
        // Heuristic: It's hex if ALL parts differ empty and can be parsed as u8 from hex.
        // And we have at least one part.
        let is_hex = !parts.is_empty() && parts.iter().all(|s| u8::from_str_radix(s, 16).is_ok());

        if is_hex {
            // Convert to ASCII representation
            let converted = hex_to_ascii_repr(&seq.data);
            if !converted.is_empty() {
                seq.data = converted;
                seq.view_mode = "Ascii".to_string(); // Force view mode to Ascii
            }
        }
    }

    // 2. Process Reactions
    for rxn in &mut project.reactions {
        if rxn.trigger_data.trim().is_empty() {
            continue;
        }

        let parts: Vec<&str> = rxn.trigger_data.split_whitespace().collect();
        let is_hex = !parts.is_empty() && parts.iter().all(|s| u8::from_str_radix(s, 16).is_ok());

        if is_hex {
            let converted = hex_to_ascii_repr(&rxn.trigger_data);
            if !converted.is_empty() {
                rxn.trigger_data = converted;
                rxn.view_mode = "Ascii".to_string(); // Force view mode to Ascii
            }
        }
    }

    project.file_path = Some(path.to_string());
    Ok(project)
}

// ============================================================================
// Docklight .ptp File Importer
// ============================================================================
// Docklight .ptp files are plain ASCII text with the following structure:
//
// VERSION
// 7
//
// COMMSETTINGS
// <mode> <port> <databits_code> <baudrate> <parity_code> <flags> <stopbits_code> <flowcontrol> <unknown>
//
// COMMDISPLAY
// <display_mode>
//
// SEND
// <index>
// <name>                    (can be empty line)
// <hex bytes separated by spaces>
// <periodic_enabled>        (0 or 1)
// <interval>                (seconds, can be decimal like ".4")
//
// RECEIVE
// <index>
// <name>                    (can be empty line)
// <trigger hex bytes>
// <action_id>
// <flag>
// COMMENT
// ...
// ============================================================================

/// Parse Docklight COMMSETTINGS data bits code to actual value
fn parse_docklight_data_bits(code: u32) -> u8 {
    match code {
        0 => 5,
        1 => 6,
        2 => 8, // Most common
        3 => 7,
        _ => 8,
    }
}

/// Parse Docklight COMMSETTINGS parity code
fn parse_docklight_parity(code: u32) -> String {
    match code {
        0 => "Even".to_string(),
        1 => "Odd".to_string(),
        2 => "None".to_string(),
        3 => "Mark".to_string(),
        4 => "Space".to_string(),
        _ => "None".to_string(),
    }
}

/// Parse Docklight COMMSETTINGS stop bits code
fn parse_docklight_stop_bits(code: u32) -> u8 {
    match code {
        0 => 1,
        4 => 1, // Observed in files
        1 => 2,
        _ => 1,
    }
}

/// Parse Docklight COMMSETTINGS flow control code
fn parse_docklight_flow_control(code: u32) -> String {
    match code {
        0 => "None".to_string(),
        1 => "Software".to_string(),
        2 => "Hardware".to_string(),
        _ => "None".to_string(),
    }
}

/// Generate a unique ID for sequences/reactions
fn generate_id(prefix: &str, index: usize) -> String {
    format!(
        "{}-{}-{}",
        prefix,
        index,
        chrono::Utc::now().timestamp_millis()
    )
}

/// Convert space-separated hex string to ASCII representation with tags
fn hex_to_ascii_repr(hex_str: &str) -> String {
    let mut result = String::new();
    let bytes: Vec<u8> = hex_str
        .split_whitespace()
        .filter_map(|s| u8::from_str_radix(s, 16).ok())
        .collect();

    for b in bytes {
        match b {
            13 => result.push_str("<CR>"),
            10 => result.push_str("<LF>"),
            27 => result.push_str("<ESC>"),
            0 => result.push_str("<NUL>"),
            _ => {
                if b < 32 || b > 126 {
                    result.push_str(&format!("<{}>", b));
                } else {
                    result.push(b as char);
                }
            }
        }
    }
    result
}

/// Import a Docklight .ptp file and convert to Plan Terminal Project
pub fn import_ptp_file(path: &str) -> Result<Project, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Normalize line endings (CRLF -> LF)
    let content = content.replace("\r\n", "\n");
    let lines: Vec<&str> = content.lines().collect();

    if lines.is_empty() {
        return Err("Empty file".to_string());
    }

    // Verify it's a Docklight file
    if lines[0].trim() != "VERSION" {
        return Err("Not a valid Docklight .ptp file (missing VERSION header)".to_string());
    }

    // Extract project name from filename
    let project_name = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Project")
        .to_string();

    let mut sequences: Vec<Sequence> = Vec::new();
    let mut reactions: Vec<Reaction> = Vec::new();
    let mut serial_config: Option<SerialConfig> = None;

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();

        match line {
            "COMMSETTINGS" => {
                i += 1; // skip header
                        // Parse the settings (next 8 lines)
                if i + 8 <= lines.len() {
                    let _mode = lines[i].trim().parse::<u32>().unwrap_or(0);
                    i += 1;
                    let port_num = lines[i].trim().parse::<u32>().unwrap_or(1);
                    i += 1;
                    let data_bits_code = lines[i].trim().parse::<u32>().unwrap_or(2);
                    i += 1;
                    let baud_rate = lines[i].trim().parse::<u32>().unwrap_or(9600);
                    i += 1;
                    let parity_code = lines[i].trim().parse::<u32>().unwrap_or(2);
                    i += 1;
                    let _flags = lines[i].trim(); // Skip flags
                    i += 1;
                    let stop_bits_code = lines[i].trim().parse::<u32>().unwrap_or(4);
                    i += 1;
                    let flow_control_code = lines[i].trim().parse::<u32>().unwrap_or(0);
                    i += 1;
                    // Skip remaining unknown field
                    if i < lines.len() {
                        let _unknown = lines[i].trim();
                    }

                    serial_config = Some(SerialConfig {
                        port_name: format!("COM{}", port_num),
                        baud_rate,
                        data_bits: parse_docklight_data_bits(data_bits_code),
                        parity: parse_docklight_parity(parity_code),
                        stop_bits: parse_docklight_stop_bits(stop_bits_code),
                        flow_control: parse_docklight_flow_control(flow_control_code),
                    });
                }
            }

            "SEND" => {
                i += 1; // skip "SEND" header
                if i >= lines.len() {
                    break;
                }

                // Line 1: Index
                let _index = lines[i].trim();
                i += 1;
                if i >= lines.len() {
                    break;
                }

                // Line 2: Name (can be empty)
                let name = lines[i].trim().to_string();
                i += 1;
                if i >= lines.len() {
                    break;
                }

                // Line 3: Hex data (space-separated hex bytes)
                let hex_data = lines[i].trim().to_string();
                // Convert to ASCII representation
                let ascii_data = hex_to_ascii_repr(&hex_data);

                i += 1;
                if i >= lines.len() {
                    break;
                }

                // Line 4: Periodic enabled (0 or 1)
                let periodic_flag = lines[i].trim().parse::<u32>().unwrap_or(0);
                i += 1;
                if i >= lines.len() {
                    break;
                }

                // Line 5: Interval (can be decimal like ".4", "5", "20")
                let interval_str = lines[i].trim();
                let interval: u64 = if interval_str.starts_with('.') {
                    // e.g. ".4" = 400ms -> convert to ms, store as seconds
                    let frac: f64 = interval_str.parse().unwrap_or(1.0);
                    (frac * 1000.0) as u64 // Store as milliseconds
                } else {
                    let secs: f64 = interval_str.parse().unwrap_or(5.0);
                    (secs * 1000.0) as u64 // Convert seconds to milliseconds
                };

                let seq_id = generate_id("ptp", sequences.len());

                // Determine a display name
                let display_name = if name.is_empty() {
                    format!("Sequence {}", sequences.len() + 1)
                } else {
                    name
                };

                sequences.push(Sequence {
                    id: seq_id,
                    name: display_name,
                    data: ascii_data,               // Use converted data
                    view_mode: "Ascii".to_string(), // Default to Ascii
                    hotkey: None,
                    periodic_enabled: Some(periodic_flag == 1),
                    periodic_interval: Some(interval),
                });
            }

            "RECEIVE" => {
                i += 1; // skip "RECEIVE" header
                if i >= lines.len() {
                    break;
                }

                // Line 1: Index
                let _index = lines[i].trim();
                i += 1;
                if i >= lines.len() {
                    break;
                }

                // Line 2: Name (can be empty)
                let name = lines[i].trim().to_string();
                i += 1;
                if i >= lines.len() {
                    break;
                }

                // Line 3: Trigger hex data
                let trigger_hex_data = lines[i].trim().to_string();
                // Convert to ASCII representation
                let trigger_ascii_data = hex_to_ascii_repr(&trigger_hex_data);

                i += 1;
                if i >= lines.len() {
                    break;
                }

                // Line 4: Response action (sequence index to trigger)
                let response_index = lines[i].trim().parse::<usize>().unwrap_or(0);
                i += 1;
                if i >= lines.len() {
                    break;
                }

                // Line 5: Flag
                let _flag = lines[i].trim();
                i += 1;

                // Skip COMMENT block (next few lines until empty line or next section)
                while i < lines.len() {
                    let l = lines[i].trim();
                    if l == "SEND" || l == "RECEIVE" || l.is_empty() {
                        break;
                    }
                    i += 1;
                }

                let reaction_id = generate_id("rxn", reactions.len());

                let display_name = if name.is_empty() {
                    format!("Reaction {}", reactions.len() + 1)
                } else {
                    name
                };

                // Map response index to sequence ID (will be resolved after all sequences are parsed)
                let response_seq_id = if response_index < sequences.len() {
                    sequences[response_index].id.clone()
                } else {
                    // Store index as placeholder - try to resolve later
                    format!("pending-{}", response_index)
                };

                reactions.push(Reaction {
                    id: reaction_id,
                    name: display_name,
                    trigger_data: trigger_ascii_data, // Use converted data
                    response_sequence_id: response_seq_id,
                    enabled: true,
                    view_mode: "Ascii".to_string(), // Default to Ascii
                });
            }

            _ => {
                // Skip other lines (VERSION number, COMMDISPLAY, empty lines, etc.)
            }
        }

        i += 1;
    }

    // Resolve any pending reaction -> sequence mappings
    for reaction in &mut reactions {
        if reaction.response_sequence_id.starts_with("pending-") {
            if let Ok(idx) = reaction.response_sequence_id[8..].parse::<usize>() {
                if idx < sequences.len() {
                    reaction.response_sequence_id = sequences[idx].id.clone();
                } else {
                    // Point to first sequence as fallback, or leave empty
                    reaction.response_sequence_id =
                        sequences.first().map(|s| s.id.clone()).unwrap_or_default();
                }
            }
        }
    }

    Ok(Project {
        name: project_name,
        send_sequences: sequences,
        reactions,
        file_path: None, // Set to None so "Save" will force a "Save As" as a new .plant file
        connection_type: None,
        serial_config,
        tcp_config: None,
        ssh_config: None,
    })
}
