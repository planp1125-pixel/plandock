use crate::ActiveReaction;
use ssh2::Session;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub struct TabState {
    pub tcp: Arc<Mutex<Option<TcpStream>>>,
    pub tx: Arc<Mutex<Option<std::sync::mpsc::Sender<Vec<u8>>>>>,
    pub reactions: Arc<Mutex<Vec<ActiveReaction>>>,
}

impl TabState {
    fn new() -> Self {
        Self {
            tcp: Arc::new(Mutex::new(None)),
            tx: Arc::new(Mutex::new(None)),
            reactions: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

pub struct SshManager {
    tabs: Arc<Mutex<HashMap<String, Arc<TabState>>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            tabs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn get_or_create_tab(&self, tab_id: &str) -> Arc<TabState> {
        let mut tabs = self.tabs.lock().unwrap();
        if !tabs.contains_key(tab_id) {
            tabs.insert(tab_id.to_string(), Arc::new(TabState::new()));
        }
        tabs.get(tab_id).unwrap().clone()
    }

    pub fn connect(
        &self,
        app: AppHandle,
        tab_id: &str,
        host: &str,
        port: u16,
        user: &str,
        auth_mode: &str,
        auth_secret: &str,
    ) -> Result<(), String> {
        self.disconnect(tab_id);
        std::thread::sleep(Duration::from_millis(100));

        let tab = self.get_or_create_tab(tab_id);
        let addr = format!("{}:{}", host, port);
        eprintln!("[SSH] [{}] Connecting to {}", tab_id, addr);

        let tcp = TcpStream::connect_timeout(
            &addr
                .parse()
                .map_err(|e| format!("Invalid address: {}", e))?,
            Duration::from_secs(5),
        )
        .map_err(|e| format!("SSH Connection failed: {}", e))?;

        let tcp_clone = tcp.try_clone().map_err(|e| e.to_string())?;
        {
            let mut t = tab.tcp.lock().unwrap();
            *t = Some(tcp_clone);
        }

        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();

        {
            let mut self_tx = tab.tx.lock().unwrap();
            *self_tx = Some(tx.clone());
        }

        let user = user.to_string();
        let auth_mode = auth_mode.to_string();
        let auth_secret = auth_secret.to_string();
        let app_clone = app.clone();
        let reactions_clone = tab.reactions.clone();
        let tx_clone = tx.clone();
        let tab_id_str = tab_id.to_string();

        thread::spawn(move || {
            let mut sess = match Session::new() {
                Ok(s) => s,
                Err(_) => {
                    let _ = app_clone.emit("ssh-disconnected", tab_id_str.clone());
                    return;
                }
            };
            sess.set_tcp_stream(tcp);
            if sess.handshake().is_err() {
                let _ = app_clone.emit("ssh-disconnected", tab_id_str.clone());
                return;
            }

            let auth_result = if auth_mode == "private_key" {
                sess.userauth_pubkey_file(&user, None, std::path::Path::new(&auth_secret), None)
            } else {
                sess.userauth_password(&user, &auth_secret)
            };

            if auth_result.is_err() || !sess.authenticated() {
                let _ = app_clone.emit("ssh-disconnected", tab_id_str.clone());
                return;
            }

            let mut channel = match sess.channel_session() {
                Ok(c) => c,
                Err(_) => {
                    let _ = app_clone.emit("ssh-disconnected", tab_id_str.clone());
                    return;
                }
            };

            let _ = channel.request_pty("xterm", None, Some((120, 40, 0, 0)));
            let _ = channel.exec("bash");
            sess.set_blocking(false);

            let mut buf = vec![0u8; 4096];
            let mut rolling_buffer: Vec<u8> = Vec::new();
            let mut active = true;

            let _ = app_clone.emit("ssh-connected", tab_id_str.clone());

            while active {
                match channel.read(&mut buf) {
                    Ok(0) => active = false,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_millis();
                        let _ = app_clone
                            .emit("serial-data", (tab_id_str.clone(), data.clone(), ts, "RX"));

                        rolling_buffer.extend_from_slice(&data);
                        if rolling_buffer.len() > 8192 {
                            let len = rolling_buffer.len();
                            rolling_buffer.drain(0..len - 8192);
                        }

                        loop {
                            let mut matched = false;
                            {
                                let rxns = reactions_clone.lock().unwrap();
                                for r in rxns.iter() {
                                    if !r.trigger_data.is_empty() {
                                        if let Some(pos) = rolling_buffer
                                            .windows(r.trigger_data.len())
                                            .position(|w| w == r.trigger_data)
                                        {
                                            let start_ts = SystemTime::now()
                                                .duration_since(UNIX_EPOCH)
                                                .unwrap()
                                                .as_millis();
                                            let _ = app_clone.emit(
                                                "serial-data",
                                                (
                                                    tab_id_str.clone(),
                                                    r.response_data.clone(),
                                                    start_ts,
                                                    "TX_AUTO",
                                                ),
                                            );
                                            let _ = tx_clone.send(r.response_data.clone());

                                            let match_end = pos + r.trigger_data.len();
                                            rolling_buffer.drain(0..match_end);
                                            matched = true;
                                            break;
                                        }
                                    }
                                }
                            }
                            if !matched {
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        if e.kind() != std::io::ErrorKind::WouldBlock {
                            active = false;
                        }
                    }
                }

                while let Ok(write_data) = rx.try_recv() {
                    let mut bytes_written = 0;
                    while bytes_written < write_data.len() && active {
                        match channel.write(&write_data[bytes_written..]) {
                            Ok(n) => bytes_written += n,
                            Err(e) => {
                                if e.kind() != std::io::ErrorKind::WouldBlock {
                                    active = false;
                                    break;
                                }
                                thread::sleep(Duration::from_millis(5));
                            }
                        }
                    }
                    let _ = channel.flush();
                }
                thread::sleep(Duration::from_millis(10));
            }

            let _ = channel.close();
            let _ = channel.wait_close();
            let _ = sess.disconnect(None, "User disconnected", None);
            let _ = app_clone.emit("ssh-disconnected", tab_id_str.clone());
        });

        Ok(())
    }

    pub fn write_data(&self, tab_id: &str, data: Vec<u8>) -> Result<(), String> {
        let tab = self.get_or_create_tab(tab_id);
        let tx_lock = tab.tx.lock().unwrap();
        if let Some(sender) = tx_lock.as_ref() {
            sender.send(data).map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("SSH connection not active".to_string())
        }
    }

    pub fn set_reactions(&self, tab_id: &str, new_reactions: Vec<ActiveReaction>) {
        let tab = self.get_or_create_tab(tab_id);
        let mut r_lock = tab.reactions.lock().unwrap();
        *r_lock = new_reactions;
    }

    pub fn disconnect(&self, tab_id: &str) {
        let mut tabs = self.tabs.lock().unwrap();
        if let Some(tab) = tabs.remove(tab_id) {
            {
                let mut tx_lock = tab.tx.lock().unwrap();
                *tx_lock = None;
            }
            {
                let mut t = tab.tcp.lock().unwrap();
                if let Some(stream) = t.take() {
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                }
            }
            eprintln!("[SSH] [{}] Disconnected", tab_id);
        }
    }

    pub fn is_connected(&self, tab_id: &str) -> bool {
        let tabs = self.tabs.lock().unwrap();
        if let Some(tab) = tabs.get(tab_id) {
            tab.tcp.lock().unwrap().is_some()
        } else {
            false
        }
    }
}
