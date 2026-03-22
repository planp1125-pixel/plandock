mod license;
mod project_manager;
mod tcp_manager;
mod serial_manager;
mod ssh_manager; // Added ssh_manager module
use license::{LicenseManager, LicenseStatus};
use project_manager::{load_project, save_project, import_ptp_file, Project, Reaction};
use serial_manager::{PortInfo, SerialConfig, SerialManager};
use tcp_manager::TcpManager;
use ssh_manager::SshManager;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Manager, State, AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ActiveReaction {
    pub trigger_data: Vec<u8>,
    pub response_data: Vec<u8>,
}

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
    tab_id: String,
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
    state.open_port(app, &tab_id, config)
}

#[tauri::command]
fn close_serial_port(state: State<'_, Arc<SerialManager>>, tab_id: String) {
    state.close_port(&tab_id);
}

#[tauri::command]
async fn send_serial_data(state: State<'_, Arc<SerialManager>>, tab_id: String, data: Vec<u8>) -> Result<(), String> {
    let manager = state.inner().clone();
    std::thread::spawn(move || {
        let _ = manager.write_data(&tab_id, data);
    });
    Ok(()) 
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
    tab_id: String,
    new_reactions: Vec<ActiveReaction>,
) {
    serial_state.set_reactions(&tab_id, new_reactions.clone());
    tcp_state.set_reactions(&tab_id, new_reactions.clone());
    ssh_state.set_reactions(&tab_id, new_reactions);
}

#[tauri::command]
fn set_packet_timeout(state: State<'_, Arc<SerialManager>>, tab_id: String, timeout: u64) {
    state.set_packet_timeout(&tab_id, timeout);
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

#[tauri::command]
fn start_logging(
    serial_manager: State<'_, Arc<SerialManager>>, 
    tcp_manager: State<'_, Arc<TcpManager>>, 
    ssh_manager: State<'_, Arc<SshManager>>, 
    tab_id: String, 
    path: String,
    conn_type: String
) -> Result<(), String> {
    match conn_type.as_str() {
        "Serial" | "serial" => serial_manager.start_logging(&tab_id, path),
        "TCP" | "tcp" => tcp_manager.start_logging(&tab_id, path),
        "SSH" | "ssh" => ssh_manager.start_logging(&tab_id, path),
        _ => Err("Unknown connection type for logging".to_string())
    }
}

#[tauri::command]
fn stop_logging(
    serial_manager: State<'_, Arc<SerialManager>>, 
    tcp_manager: State<'_, Arc<TcpManager>>, 
    ssh_manager: State<'_, Arc<SshManager>>, 
    tab_id: String,
    conn_type: String
) {
    match conn_type.as_str() {
        "Serial" | "serial" => serial_manager.stop_logging(&tab_id),
        "TCP" | "tcp" => tcp_manager.stop_logging(&tab_id),
        "SSH" | "ssh" => ssh_manager.stop_logging(&tab_id),
        _ => {}
    }
}

#[tauri::command]
fn is_logging(
    serial_manager: State<'_, Arc<SerialManager>>, 
    tcp_manager: State<'_, Arc<TcpManager>>, 
    ssh_manager: State<'_, Arc<SshManager>>, 
    tab_id: String,
    conn_type: String
) -> bool {
    match conn_type.as_str() {
        "Serial" | "serial" => serial_manager.is_logging(&tab_id),
        "TCP" | "tcp" => tcp_manager.is_logging(&tab_id),
        "SSH" | "ssh" => ssh_manager.is_logging(&tab_id),
        _ => false
    }
}

#[tauri::command]
fn write_file_direct(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

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
    tab_id: String,
    host: String,
    port: u16,
) -> Result<(), String> {
    let host = host.clone();
    let manager = tcp_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.connect(app, &tab_id, &host, port)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn disconnect_tcp(tcp_manager: State<'_, Arc<TcpManager>>, tab_id: String) {
    tcp_manager.disconnect(&tab_id);
}

#[tauri::command]
fn send_tcp_data(tcp_manager: State<'_, Arc<TcpManager>>, tab_id: String, data: Vec<u8>) -> Result<(), String> {
    tcp_manager.write_data(&tab_id, data)
}

#[tauri::command]
fn is_tcp_connected(tcp_manager: State<'_, Arc<TcpManager>>, tab_id: String) -> bool {
    tcp_manager.is_connected(&tab_id)
}

#[tauri::command]
async fn connect_ssh(
    ssh_manager: State<'_, Arc<SshManager>>,
    app: AppHandle,
    tab_id: String,
    host: String,
    port: u16,
    user: String,
    auth_mode: String,
    auth_secret: String,
) -> Result<(), String> {
    let host = host.clone();
    let user = user.clone();
    let auth_mode = auth_mode.clone();
    let auth_secret = auth_secret.clone();
    let manager = ssh_manager.inner().clone();
    
    tauri::async_runtime::spawn_blocking(move || {
        manager.connect(app, &tab_id, &host, port, &user, &auth_mode, &auth_secret)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn disconnect_ssh(ssh_manager: State<'_, Arc<SshManager>>, tab_id: String) {
    ssh_manager.disconnect(&tab_id);
}

#[tauri::command]
fn send_ssh_data(
    ssh_manager: State<'_, Arc<SshManager>>,
    tab_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    ssh_manager.write_data(&tab_id, data)
}

#[tauri::command]
fn is_ssh_connected(ssh_manager: State<'_, Arc<SshManager>>, tab_id: String) -> bool {
    ssh_manager.is_connected(&tab_id)
}

#[tauri::command]
fn play_recording(app: AppHandle, tab_id: String, path: String, speed_multiplier: f64) -> Result<(), String> {
    std::thread::spawn(move || {
        let file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("Failed to open recording: {}", e);
                return;
            }
        };
        let reader = std::io::BufReader::new(file);
        
        let _ = app.emit("playback-started", tab_id.clone());
        
        use std::io::BufRead;
        let mut last_ts = 0;
        
        for line in reader.lines() {
            if let Ok(l) = line {
                let v: serde_json::Value = match serde_json::from_str(&l) {
                    Ok(val) => val,
                    Err(_) => continue,
                };
                
                let ts = v["ts"].as_u64().unwrap_or(0);
                let dir = v["dir"].as_str().unwrap_or("RX");
                
                let data_array = match v["data"].as_array() {
                    Some(arr) => arr,
                    None => continue,
                };
                
                let mut bytes = Vec::new();
                for b in data_array {
                    if let Some(num) = b.as_u64() {
                        bytes.push(num as u8);
                    }
                }
                
                if last_ts > 0 && ts > last_ts && speed_multiplier > 0.0 {
                    let diff = ts - last_ts;
                    let sleep_ms = (diff as f64 / speed_multiplier) as u64;
                    if sleep_ms > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
                    }
                }
                last_ts = ts;
                
                let _ = app.emit("serial-data", (tab_id.clone(), bytes, ts as u128, dir));
            }
        }
        
        let _ = app.emit("playback-ended", tab_id.clone());
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            let license_manager = LicenseManager::new(app_data_dir);
            app.manage(license_manager);
            Ok(())
        })
        .manage(Arc::new(SerialManager::new()))
        .manage(Arc::new(TcpManager::new()))
        .manage(Arc::new(SshManager::new()))
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
            start_logging,
            stop_logging,
            is_logging,
            get_license_status,
            activate_license,
            deactivate_license,
            import_docklight_file,
            write_file_direct,
            append_to_file,
            connect_tcp,
            disconnect_tcp,
            send_tcp_data,
            is_tcp_connected,
            connect_ssh,
            disconnect_ssh,
            send_ssh_data,
            is_ssh_connected,
            play_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
