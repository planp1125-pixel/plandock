mod license;
mod project_manager;
mod tcp_manager;
mod serial_manager;
mod ssh_manager; // Added ssh_manager module
use license::{LicenseManager, LicenseStatus};
use project_manager::{load_project, save_project, import_ptp_file, Project, Reaction};
use serial_manager::{PortInfo, SerialConfig, SerialManager};
use tcp_manager::TcpManager;
use ssh_manager::SshManager; // Added SshManager import
use std::sync::Arc;
use tauri::{Manager, State, AppHandle};

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
fn import_docklight_file(path: String) -> Result<Project, String> {
    import_ptp_file(&path)
}

#[tauri::command]
fn set_reactions(
    serial_state: State<'_, Arc<SerialManager>>,
    tcp_state: State<'_, Arc<TcpManager>>,
    ssh_state: State<'_, Arc<SshManager>>,
    new_reactions: Vec<Reaction>,
) {
    serial_state.set_reactions(new_reactions.clone());
    tcp_state.set_reactions(new_reactions.clone());
    ssh_state.set_reactions(new_reactions);
}

#[tauri::command]
fn set_packet_timeout(state: State<'_, Arc<SerialManager>>, timeout: u64) {
    state.set_packet_timeout(timeout);
}

// License commands
#[tauri::command]
fn get_license_status(state: State<'_, LicenseManager>) -> LicenseStatus {
    state.get_status()
}

#[tauri::command]
fn activate_license(state: State<'_, LicenseManager>, key: String) -> Result<bool, String> {
    state.activate(&key)
}

#[tauri::command]
fn deactivate_license(state: State<'_, LicenseManager>) -> Result<(), String> {
    state.deactivate()
}

// Logging commands
#[tauri::command]
fn start_logging(state: State<'_, Arc<SerialManager>>, path: String, format: String) -> Result<(), String> {
    state.start_logging(&path, &format)
}

#[tauri::command]
fn stop_logging(state: State<'_, Arc<SerialManager>>) {
    state.stop_logging();
}

#[tauri::command]
fn is_logging(state: State<'_, Arc<SerialManager>>) -> bool {
    state.is_logging()
}

/// Write text to a file directly (bypasses Tauri FS plugin scope for multi-file export)
#[tauri::command]
fn write_file_direct(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

/// Append text to a file (for real-time logging)
#[tauri::command]
fn append_to_file(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open {}: {}", path, e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to append to {}: {}", path, e))
}

#[tauri::command]
async fn connect_tcp(
    tcp_manager: State<'_, Arc<TcpManager>>,
    app: AppHandle,
    host: String,
    port: u16,
) -> Result<(), String> {
    // Execute synchronous connect inside a spawn_blocking to fully decouple from main thread, 
    // though `async fn` in Tauri usually offloads, spawn_blocking guarantees it avoids freezing.
    let host = host.clone();
    let manager = tcp_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.connect(app, &host, port)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn disconnect_tcp(tcp_manager: State<'_, Arc<TcpManager>>) {
    tcp_manager.disconnect();
}

#[tauri::command]
fn send_tcp_data(tcp_manager: State<'_, Arc<TcpManager>>, data: Vec<u8>) -> Result<(), String> {
    tcp_manager.write_data(data)
}

#[tauri::command]
fn is_tcp_connected(tcp_manager: State<'_, Arc<TcpManager>>) -> bool {
    tcp_manager.is_connected()
}

// ==========================================
// SSH Commands
// ==========================================

#[tauri::command]
async fn connect_ssh(
    ssh_manager: State<'_, Arc<SshManager>>,
    app: AppHandle,
    host: String,
    port: u16,
    user: String,
    pass: String,
) -> Result<(), String> {
    let host = host.clone();
    let user = user.clone();
    let pass = pass.clone();
    let manager = ssh_manager.inner().clone();
    
    tauri::async_runtime::spawn_blocking(move || {
        manager.connect(app, &host, port, &user, &pass)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn disconnect_ssh(ssh_manager: State<'_, Arc<SshManager>>) {
    ssh_manager.disconnect();
}

#[tauri::command]
fn send_ssh_data(
    ssh_manager: State<'_, Arc<SshManager>>,
    data: Vec<u8>,
) -> Result<(), String> {
    ssh_manager.write_data(data)
}

#[tauri::command]
fn is_ssh_connected(ssh_manager: State<'_, Arc<SshManager>>) -> bool {
    ssh_manager.is_connected()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Initialize LicenseManager with app data directory
            let app_data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            let license_manager = LicenseManager::new(app_data_dir);
            app.manage(license_manager);
            Ok(())
        })
        .manage(Arc::new(SerialManager::new()))
        .manage(Arc::new(TcpManager::new()))
        .manage(Arc::new(SshManager::new())) // Added SshManager instantiation
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
            get_license_status,
            activate_license,
            deactivate_license,
            import_docklight_file,
            start_logging,
            stop_logging,
            is_logging,
            write_file_direct,
            append_to_file,
            connect_tcp,
            disconnect_tcp,
            send_tcp_data,
            is_tcp_connected,
            connect_ssh, // Added SSH command
            disconnect_ssh, // Added SSH command
            send_ssh_data, // Added SSH command
            is_ssh_connected, // Added SSH command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
