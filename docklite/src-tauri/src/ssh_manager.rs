use crate::ActiveReaction;
use ssh2::Session;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub struct TabState {
    pub tcp: Arc<Mutex<Option<TcpStream>>>,
    pub tx: Arc<Mutex<Option<std::sync::mpsc::Sender<Vec<u8>>>>>,
    pub reactions: Arc<Mutex<Vec<ActiveReaction>>>,
    pub log_file: Arc<Mutex<Option<std::io::BufWriter<std::fs::File>>>>,
    pub log_format: Arc<Mutex<crate::log_utils::LogFormat>>,
    pub periodic_senders: Arc<Mutex<HashMap<String, mpsc::SyncSender<()>>>>,
}

impl TabState {
    fn new() -> Self {
        Self {
            tcp: Arc::new(Mutex::new(None)),
            tx: Arc::new(Mutex::new(None)),
            reactions: Arc::new(Mutex::new(Vec::new())),
            log_file: Arc::new(Mutex::new(None)),
            log_format: Arc::new(Mutex::new(crate::log_utils::LogFormat::Jsonl)),
            periodic_senders: Arc::new(Mutex::new(HashMap::new())),
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
        let log_file = tab.log_file.clone();
        let log_format = tab.log_format.clone();
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

                        crate::log_utils::write_log_entry(&log_file, &log_format, &data, "RX");

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
                                            crate::log_utils::write_log_entry(
                                                &log_file,
                                                &log_format,
                                                &r.response_data,
                                                "TX_AUTO",
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
            sender.send(data.clone()).map_err(|e| e.to_string())?;
            crate::log_utils::write_log_entry(&tab.log_file, &tab.log_format, &data, "TX");
            Ok(())
        } else {
            Err("SSH connection not active".to_string())
        }
    }

    pub fn start_periodic(
        &self,
        tab_id: &str,
        seq_id: String,
        data: Vec<u8>,
        interval_ms: u64,
        app: AppHandle,
    ) {
        let tab = self.get_or_create_tab(tab_id);

        tab.periodic_senders.lock().unwrap().remove(&seq_id);

        let (tx, rx) = mpsc::sync_channel::<()>(0);
        tab.periodic_senders
            .lock()
            .unwrap()
            .insert(seq_id.clone(), tx);

        let ssh_tx = tab.tx.clone();
        let log_file = tab.log_file.clone();
        let log_format = tab.log_format.clone();
        let tab_id_str = tab_id.to_string();

        thread::spawn(move || {
            loop {
                match rx.recv_timeout(Duration::from_millis(interval_ms)) {
                    Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_millis();

                        let lock = ssh_tx.lock().unwrap();
                        if let Some(sender) = lock.as_ref() {
                            if sender.send(data.clone()).is_err() {
                                break; // channel closed — SSH disconnected
                            }
                            let _ = app.emit(
                                "serial-data",
                                (tab_id_str.clone(), data.clone(), ts, "TX_PERIODIC"),
                            );
                            crate::log_utils::write_log_entry(
                                &log_file,
                                &log_format,
                                &data,
                                "TX_PERIODIC",
                            );
                        } else {
                            break;
                        }
                    }
                }
            }
        });
    }

    pub fn stop_periodic(&self, tab_id: &str, seq_id: &str) {
        let tab = self.get_or_create_tab(tab_id);
        tab.periodic_senders.lock().unwrap().remove(seq_id);
    }

    pub fn stop_all_periodic(&self, tab_id: &str) {
        let tab = self.get_or_create_tab(tab_id);
        tab.periodic_senders.lock().unwrap().clear();
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

    pub fn start_logging(
        &self,
        tab_id: &str,
        path: String,
        format: crate::log_utils::LogFormat,
    ) -> Result<(), String> {
        let tab = self.get_or_create_tab(tab_id);
        let file = std::fs::File::create(&path)
            .map_err(|e| format!("Failed to create log file: {}", e))?;
        let mut lfile = tab.log_file.lock().unwrap();
        *lfile = Some(std::io::BufWriter::new(file));

        let mut f_lock = tab.log_format.lock().unwrap();
        *f_lock = format;

        Ok(())
    }

    pub fn stop_logging(&self, tab_id: &str) {
        let tab = self.get_or_create_tab(tab_id);
        let mut lfile = tab.log_file.lock().unwrap();
        *lfile = None;
    }

    pub fn is_logging(&self, tab_id: &str) -> bool {
        let tab = self.get_or_create_tab(tab_id);
        let logging = tab.log_file.lock().unwrap().is_some();
        logging
    }
}
