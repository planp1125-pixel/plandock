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
pub struct Project {
    pub name: String,
    pub send_sequences: Vec<Sequence>,
    pub reactions: Vec<Reaction>,
    pub serial_config: Option<SerialConfig>,
}

impl Project {
    pub fn new() -> Self {
        Self {
            name: "Plan Terminal".to_string(),
            send_sequences: vec![],
            reactions: vec![],
            serial_config: None,
        }
    }
}

pub fn save_project(path: &str, project: &Project) -> Result<(), String> {
    let json = serde_json::to_string_pretty(project).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn load_project(path: &str) -> Result<Project, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
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
                    data: hex_data,
                    view_mode: "Hex".to_string(),
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
                let trigger_data = lines[i].trim().to_string();
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
                    // Store index as placeholder - will try to resolve later
                    format!("pending-{}", response_index)
                };

                reactions.push(Reaction {
                    id: reaction_id,
                    name: display_name,
                    trigger_data,
                    response_sequence_id: response_seq_id,
                    enabled: true,
                    view_mode: "Hex".to_string(),
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
        serial_config,
    })
}
