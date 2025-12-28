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
