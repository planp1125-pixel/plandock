use crate::ActiveReaction;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::process::{Command, Child, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub struct ShellTabState {
    pub child: Arc<Mutex<Option<Child>>>,
    pub stdin_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<Vec<u8>>>>>,
    pub log_file: Arc<Mutex<Option<BufWriter<File>>>>,
    pub reactions: Arc<Mutex<Vec<ActiveReaction>>>,
    pub log_format: Arc<Mutex<crate::log_utils::LogFormat>>,
    pub periodic_senders: Arc<Mutex<HashMap<String, mpsc::SyncSender<()>>>>,
    pub rolling_buffer: Arc<Mutex<Vec<u8>>>,
}

impl ShellTabState {
    fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            stdin_tx: Arc::new(Mutex::new(None)),
            log_file: Arc::new(Mutex::new(None)),
            reactions: Arc::new(Mutex::new(Vec::new())),
            log_format: Arc::new(Mutex::new(crate::log_utils::LogFormat::Jsonl)),
            periodic_senders: Arc::new(Mutex::new(HashMap::new())),
            rolling_buffer: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

pub struct ShellManager {
    tabs: Arc<Mutex<HashMap<String, Arc<ShellTabState>>>>,
}

impl ShellManager {
    pub fn new() -> Self {
        Self {
            tabs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn get_or_create_tab(&self, tab_id: &str) -> Arc<ShellTabState> {
        let mut tabs = self.tabs.lock().unwrap();
        if !tabs.contains_key(tab_id) {
            tabs.insert(tab_id.to_string(), Arc::new(ShellTabState::new()));
        }
        tabs.get(tab_id).unwrap().clone()
    }

    pub fn connect(
        &self,
        app: AppHandle,
        tab_id: &str,
        requested_shell: &str,
    ) -> Result<(), String> {
        self.disconnect(tab_id);
        thread::sleep(Duration::from_millis(100));

        let tab = self.get_or_create_tab(tab_id);

        let shell_cmd = if !requested_shell.is_empty() && requested_shell != "Auto" {
            requested_shell.to_string()
        } else if cfg!(target_os = "windows") {
            "powershell.exe".to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
        };

        eprintln!("[SHELL] [{}] Spawning shell: {}", tab_id, shell_cmd);

        let mut cmd = Command::new(&shell_cmd);
        if shell_cmd.contains("bash") || shell_cmd.contains("zsh") || shell_cmd.contains("sh") {
            cmd.arg("-i");
        }
        cmd.stdin(Stdio::piped())
           .stdout(Stdio::piped())
           .stderr(Stdio::piped());

        let mut spawn_res = cmd.spawn();

        if spawn_res.is_err() {
            let fallback_cmd = if cfg!(target_os = "windows") {
                "powershell.exe".to_string()
            } else {
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
            };
            eprintln!("[SHELL] [{}] Failed to spawn '{}', falling back to: {}", tab_id, shell_cmd, fallback_cmd);
            let mut fb_cmd = Command::new(&fallback_cmd);
            if fallback_cmd.contains("bash") || fallback_cmd.contains("zsh") || fallback_cmd.contains("sh") {
                fb_cmd.arg("-i");
            }
            fb_cmd.stdin(Stdio::piped())
                  .stdout(Stdio::piped())
                  .stderr(Stdio::piped());
            spawn_res = fb_cmd.spawn();
        }

        let mut child = spawn_res.map_err(|e| format!("Failed to spawn shell: {}", e))?;

        let mut stdin = child.stdin.take().ok_or("Failed to open shell stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to open shell stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to open shell stderr")?;

        {
            let mut c = tab.child.lock().unwrap();
            *c = Some(child);
        }

        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        {
            let mut self_tx = tab.stdin_tx.lock().unwrap();
            *self_tx = Some(tx.clone());
        }

        let app_clone = app.clone();
        let app_clone_err = app.clone();
        let log_file = tab.log_file.clone();
        let log_format = tab.log_format.clone();
        let tab_id_str = tab_id.to_string();
        let tab_id_str_err = tab_id.to_string();

        // Stdin Writer Thread
        thread::spawn(move || {
            while let Ok(data) = rx.recv() {
                if stdin.write_all(&data).is_err() || stdin.flush().is_err() {
                    break;
                }
            }
        });

        // Stdout Reader Thread
        thread::spawn(move || {
            let mut reader = stdout;
            let mut buf = vec![0u8; 4096];
            tab.rolling_buffer.lock().unwrap().clear();
            let _ = app_clone.emit("serial-connected", tab_id_str.clone());

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // process exited
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_millis();

                        let _ = app_clone.emit(
                            "serial-data",
                            (tab_id_str.clone(), data.clone(), ts as u64, "RX".to_string()),
                        );

                        let label = if tab_id_str == "main" {
                            "serial-bridge".to_string()
                        } else {
                            format!("serial-{}", tab_id_str)
                        };
                        let data_to_broadcast = data.clone();
                        tauri::async_runtime::block_on(async move {
                            crate::share_manager::broadcast_remote_data(label, data_to_broadcast, 0).await;
                        });

                        crate::log_utils::write_log_entry(&log_file, &log_format, &data, "RX");

                        let mut rb_lock = tab.rolling_buffer.lock().unwrap();
                        rb_lock.extend_from_slice(&data);
                        if rb_lock.len() > 8192 {
                            let len = rb_lock.len();
                            rb_lock.drain(0..len - 8192);
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = app_clone.emit("serial-disconnected", tab_id_str.clone());
        });

        // Stderr Reader Thread
        thread::spawn(move || {
            let mut reader = stderr;
            let mut buf = vec![0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_millis();

                        let _ = app_clone_err.emit(
                            "serial-data",
                            (tab_id_str_err.clone(), data.clone(), ts as u64, "RX".to_string()),
                        );

                        let label = if tab_id_str_err == "main" {
                            "serial-bridge".to_string()
                        } else {
                            format!("serial-{}", tab_id_str_err)
                        };
                        let data_to_broadcast = data.clone();
                        tauri::async_runtime::block_on(async move {
                            crate::share_manager::broadcast_remote_data(label, data_to_broadcast, 0).await;
                        });
                    }
                    Err(_) => break,
                }
            }
        });

        let welcome_banner = format!("--- Local Terminal Session Started ({}) ---\r\n", shell_cmd);
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let _ = app.emit("serial-data", (tab_id.to_string(), welcome_banner.as_bytes().to_vec(), ts as u64, "RX".to_string()));

        Ok(())
    }

    pub fn write_data(&self, app: &AppHandle, tab_id: &str, data: Vec<u8>) -> Result<(), String> {
        let tab = self.get_or_create_tab(tab_id);
        let tx_lock = tab.stdin_tx.lock().unwrap();
        if let Some(sender) = tx_lock.as_ref() {
            sender.send(data.clone()).map_err(|e| e.to_string())?;
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis();
            // Don't emit TX serial-data for interactive shells — the shell echoes
            // input back as RX, so displaying TX would cause doubled lines.
            // We still log to file and broadcast to remote peers below.

            let label = if tab_id == "main" {
                "serial-bridge".to_string()
            } else {
                format!("serial-{}", tab_id)
            };
            let data_to_broadcast = data.clone();
            tauri::async_runtime::block_on(async move {
                crate::share_manager::broadcast_remote_data(label, data_to_broadcast, 1).await;
            });

            crate::log_utils::write_log_entry(&tab.log_file, &tab.log_format, &data, "TX");
            Ok(())
        } else {
            Err("Shell connection not active".to_string())
        }
    }

    pub fn disconnect(&self, tab_id: &str) {
        let tab = self.get_or_create_tab(tab_id);
        {
            let mut tx = tab.stdin_tx.lock().unwrap();
            *tx = None;
        }
        {
            let mut c = tab.child.lock().unwrap();
            if let Some(mut child) = c.take() {
                let _ = child.kill();
            }
        }
    }
}
