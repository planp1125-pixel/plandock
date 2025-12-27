mod project_manager;
mod serial_manager;
use project_manager::{load_project, save_project, Project};
use serial_manager::{PortInfo, Reaction, SerialConfig, SerialManager};
use std::sync::Arc;
use tauri::State;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn list_serial_ports() -> Vec<PortInfo> {
    SerialManager::list_ports()
}

#[tauri::command]
fn open_serial_port(
    app: tauri::AppHandle,
    state: State<'_, Arc<SerialManager>>,
    port_name: String,
    baud_rate: u32,
    data_bits: u8,
    flow_control: String,
    parity: String,
    stop_bits: u8,
) -> Result<(), String> {
    let config = SerialConfig {
        port_name,
        baud_rate,
        data_bits,
        flow_control,
        parity,
        stop_bits,
    };
    state.open_port(app, config)
}

#[tauri::command]
fn close_serial_port(state: State<'_, Arc<SerialManager>>) {
    state.close_port();
}

#[tauri::command]
async fn send_serial_data(state: State<'_, Arc<SerialManager>>, data: Vec<u8>) -> Result<(), String> {
    let manager = state.inner().clone();
    // Fire and forget - spawn the blocking task but don't wait for it
    std::thread::spawn(move || {
        let _ = manager.write_data(data);
    });
    Ok(()) // Return immediately to UI
}

#[tauri::command]
fn save_project_file(path: String, project: Project) -> Result<(), String> {
    save_project(&path, &project)
}

#[tauri::command]
fn load_project_file(path: String) -> Result<Project, String> {
    load_project(&path)
}

#[tauri::command]
fn set_reactions(state: State<'_, Arc<SerialManager>>, new_reactions: Vec<Reaction>) {
    state.set_reactions(new_reactions);
}

#[tauri::command]
fn set_packet_timeout(state: State<'_, Arc<SerialManager>>, timeout: u64) {
    state.set_packet_timeout(timeout);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(SerialManager::new()))
        .invoke_handler(tauri::generate_handler![
            greet,
            list_serial_ports,
            open_serial_port,
            close_serial_port,
            send_serial_data,
            save_project_file,
            load_project_file,
            set_reactions,
            set_packet_timeout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
