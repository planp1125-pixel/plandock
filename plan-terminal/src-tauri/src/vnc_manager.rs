use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub struct VncTabState {
    pub stream: Arc<Mutex<Option<Arc<TcpStream>>>>,
    pub is_reading: Arc<Mutex<bool>>,
    pub log_file: Arc<Mutex<Option<BufWriter<File>>>>,
    pub log_format: Arc<Mutex<crate::log_utils::LogFormat>>,
}

impl VncTabState {
    fn new() -> Self {
        Self {
            stream: Arc::new(Mutex::new(None)),
            is_reading: Arc::new(Mutex::new(false)),
            log_file: Arc::new(Mutex::new(None)),
            log_format: Arc::new(Mutex::new(crate::log_utils::LogFormat::Jsonl)),
        }
    }
}

#[derive(Clone)]
pub struct VncManager {
    tabs: Arc<Mutex<HashMap<String, Arc<VncTabState>>>>,
}

impl VncManager {
    pub fn new() -> Self {
        Self {
            tabs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn get_or_create_tab(&self, tab_id: &str) -> Arc<VncTabState> {
        let mut tabs = self.tabs.lock().unwrap();
        if !tabs.contains_key(tab_id) {
            tabs.insert(tab_id.to_string(), Arc::new(VncTabState::new()));
        }
        tabs.get(tab_id).unwrap().clone()
    }

    pub fn connect(
        &self,
        app: AppHandle,
        tab_id: &str,
        host: &str,
        port: u16,
    ) -> Result<(), String> {
        self.disconnect(tab_id);
        thread::sleep(Duration::from_millis(100));

        let addr_str = format!("{}:{}", host, port);
        eprintln!("[VNC] [{}] Connecting to VNC server at {}", tab_id, addr_str);

        let stream = match addr_str.parse() {
            Ok(addr) => TcpStream::connect_timeout(&addr, Duration::from_secs(5))
                .map_err(|e| format!("VNC Connection failed to {}: {}", addr_str, e))?,
            Err(_) => {
                // Fallback for hostnames like localhost or domain names
                use std::net::ToSocketAddrs;
                let mut addrs = addr_str
                    .to_socket_addrs()
                    .map_err(|e| format!("Failed to resolve address {}: {}", addr_str, e))?;
                if let Some(target) = addrs.next() {
                    TcpStream::connect_timeout(&target, Duration::from_secs(5))
                        .map_err(|e| format!("VNC Connection failed to {}: {}", addr_str, e))?
                } else {
                    return Err(format!("Could not resolve VNC address: {}", addr_str));
                }
            }
        };

        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;

        let arc_stream = Arc::new(stream);
        let tab = self.get_or_create_tab(tab_id);
        *tab.stream.lock().unwrap() = Some(arc_stream.clone());
        *tab.is_reading.lock().unwrap() = true;

        let is_reading = tab.is_reading.clone();
        let tab_id_str = tab_id.to_string();
        let app_clone = app.clone();
        let stream_reader = arc_stream.clone();

        thread::spawn(move || {
            let mut buf = vec![0u8; 16384]; // 16KB frame buffer chunk
            let mut reader = &*stream_reader;
            eprintln!("[VNC] [{}] Reader thread started", tab_id_str);

            while *is_reading.lock().unwrap() {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        eprintln!("[VNC] [{}] Remote VNC closed connection (EOF)", tab_id_str);
                        break;
                    }
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis();

                        eprintln!("[VNC] [{}] RX {} bytes from VNC socket", tab_id_str, data.len());

                        let _ = app_clone.emit(
                            "vnc-data",
                            (tab_id_str.clone(), data.clone(), ts as u64, "RX".to_string()),
                        );
                        let _ = app_clone.emit(
                            "serial-data",
                            (tab_id_str.clone(), data.clone(), ts as u64, "RX".to_string()),
                        );

                        // Broadcast to WebRTC data channel subscribers (packet type 0x06)
                        let label = if tab_id_str == "main" {
                            "serial-bridge".to_string()
                        } else {
                            format!("serial-{}", tab_id_str)
                        };
                        let data_to_broadcast = data.clone();
                        tauri::async_runtime::block_on(async move {
                            crate::share_manager::broadcast_remote_data(label, data_to_broadcast, 0x06).await;
                        });
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => {
                        eprintln!("[VNC] [{}] Read error: {}", tab_id_str, e);
                        break;
                    }
                }
            }

            *is_reading.lock().unwrap() = false;
            let _ = app_clone.emit("vnc-disconnected", tab_id_str);
        });

        let _ = app.emit("vnc-connected", tab_id.to_string());
        Ok(())
    }

    pub fn write_data(&self, _app: &AppHandle, tab_id: &str, data: Vec<u8>) -> Result<(), String> {
        let tab = self.get_or_create_tab(tab_id);
        let stream_opt = tab.stream.lock().unwrap().clone();
        if let Some(arc_stream) = stream_opt {
            let mut stream = &*arc_stream;
            eprintln!("[VNC] [{}] TX {} bytes to VNC socket", tab_id, data.len());
            stream.write_all(&data).map_err(|e| format!("VNC Write error: {}", e))?;
            stream.flush().map_err(|e| format!("VNC Flush error: {}", e))?;

            // Broadcast to WebRTC subscribers if sent locally
            let label = if tab_id == "main" {
                "serial-bridge".to_string()
            } else {
                format!("serial-{}", tab_id)
            };
            let data_to_broadcast = data.clone();
            tauri::async_runtime::block_on(async move {
                crate::share_manager::broadcast_remote_data(label, data_to_broadcast, 0x06).await;
            });

            Ok(())
        } else {
            eprintln!("[VNC] [{}] Cannot write data: stream_opt is None!", tab_id);
            Err("VNC connection not active".to_string())
        }
    }

    pub fn disconnect(&self, tab_id: &str) {
        let tab = self.get_or_create_tab(tab_id);
        *tab.is_reading.lock().unwrap() = false;

        let mut stream_lock = tab.stream.lock().unwrap();
        if let Some(stream) = stream_lock.take() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }

    pub fn is_connected(&self, tab_id: &str) -> bool {
        let tab = self.get_or_create_tab(tab_id);
        *tab.is_reading.lock().unwrap() && tab.stream.lock().unwrap().is_some()
    }
}
