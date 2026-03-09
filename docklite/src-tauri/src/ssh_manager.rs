use crate::project_manager::{parse_hex_string, Reaction};
use ssh2::Session;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub struct SshManager {
    tcp: Arc<Mutex<Option<TcpStream>>>,
    tx: Arc<Mutex<Option<std::sync::mpsc::Sender<Vec<u8>>>>>,
    reactions: Arc<Mutex<Vec<Reaction>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            tcp: Arc::new(Mutex::new(None)),
            tx: Arc::new(Mutex::new(None)),
            reactions: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn connect(
        &self,
        app: AppHandle,
        host: &str,
        port: u16,
        user: &str,
        pass: &str,
    ) -> Result<(), String> {
        self.disconnect(); // Ensure clean slate

        let addr = format!("{}:{}", host, port);
        eprintln!("[SSH] Connecting to {}", addr);

        let tcp = TcpStream::connect_timeout(
            &addr
                .parse()
                .map_err(|e| format!("Invalid address: {}", e))?,
            Duration::from_secs(5),
        )
        .map_err(|e| format!("TCP Connection failed: {}", e))?;

        let tcp_clone = tcp.try_clone().map_err(|e| e.to_string())?;
        {
            let mut t = self.tcp.lock().unwrap();
            *t = Some(tcp_clone);
        }

        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();

        {
            let mut self_tx = self.tx.lock().unwrap();
            *self_tx = Some(tx.clone());
        }

        let user = user.to_string();
        let pass = pass.to_string();
        let app_clone = app.clone();
        let reactions_clone = self.reactions.clone();
        let tx_clone = tx.clone(); // so we can send auto-replies back through our own tx loop

        thread::spawn(move || {
            let mut sess = match Session::new() {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[SSH] Session init failed: {}", e);
                    let _ = app_clone.emit("ssh-disconnected", ());
                    return;
                }
            };

            sess.set_tcp_stream(tcp);

            if let Err(e) = sess.handshake() {
                eprintln!("[SSH] Handshake failed: {}", e);
                let _ = app_clone.emit("ssh-disconnected", ());
                return;
            }

            if let Err(e) = sess.userauth_password(&user, &pass) {
                eprintln!("[SSH] Auth failed: {}", e);
                let _ = app_clone.emit("ssh-disconnected", ());
                return;
            }

            if !sess.authenticated() {
                eprintln!("[SSH] Auth failed: Not authenticated");
                let _ = app_clone.emit("ssh-disconnected", ());
                return;
            }

            let mut channel = match sess.channel_session() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[SSH] Channel failed: {}", e);
                    let _ = app_clone.emit("ssh-disconnected", ());
                    return;
                }
            };

            // Request a PTY exactly like a terminal
            let _ = channel.request_pty("xterm", None, Some((120, 40, 0, 0)));
            let _ = channel.exec("bash");

            // Make non-blocking to interleave read and write polling
            sess.set_blocking(false);

            let mut buf = vec![0u8; 4096];
            let mut rolling_buffer: Vec<u8> = Vec::new();
            let mut active = true;

            eprintln!("[SSH] Background thread active and connected");
            let _ = app_clone.emit("ssh-connected", ());

            while active {
                // 1. Read from SSH Channel
                match channel.read(&mut buf) {
                    Ok(0) => {
                        // EOF
                        active = false;
                    }
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_millis();
                        // Emit to frontend
                        let _ = app_clone.emit("serial-data", (data.clone(), ts, "RX"));

                        // Manage rolling buffer for reactions
                        rolling_buffer.extend_from_slice(&data);
                        if rolling_buffer.len() > 8192 {
                            let len = rolling_buffer.len();
                            rolling_buffer.drain(0..len - 8192);
                        }

                        // Process Auto-Reactions (if any match the trigger)
                        let reactions = reactions_clone.lock().unwrap();
                        for r in reactions.iter() {
                            if !r.enabled {
                                continue;
                            }

                            // Parse trigger
                            let trigger_bytes = if r.view_mode == "Hex" {
                                parse_hex_string(&r.trigger_data).unwrap_or_default()
                            } else {
                                r.trigger_data.as_bytes().to_vec()
                            };

                            if !trigger_bytes.is_empty() && rolling_buffer.ends_with(&trigger_bytes)
                            {
                                let start_ts = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap()
                                    .as_millis();

                                // Parse response
                                let response_bytes = if r.view_mode == "Hex" {
                                    parse_hex_string(&r.response_sequence_id).unwrap_or_default()
                                } else {
                                    r.response_sequence_id.as_bytes().to_vec()
                                };

                                // Emit to UI as TX_AUTO
                                let _ = app_clone.emit(
                                    "serial-data",
                                    (response_bytes.clone(), start_ts, "TX_AUTO"),
                                );

                                // Send the auto-reply back into the SSH write queue
                                let _ = tx_clone.send(response_bytes);

                                // Truncate to prevent immediate re-trigger
                                let t_len = trigger_bytes.len();
                                let b_len = rolling_buffer.len();
                                if b_len >= t_len {
                                    rolling_buffer.truncate(b_len - t_len);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        // WouldBlock is expected in non-blocking mode
                        if e.kind() != std::io::ErrorKind::WouldBlock {
                            eprintln!("[SSH] Read error: {}", e);
                            active = false;
                        }
                    }
                }

                // 2. Write to SSH Channel from mpsc queue (sent by UI)
                while let Ok(write_data) = rx.try_recv() {
                    let mut bytes_written = 0;
                    while bytes_written < write_data.len() && active {
                        match channel.write(&write_data[bytes_written..]) {
                            Ok(n) => {
                                bytes_written += n;
                            }
                            Err(e) => {
                                if e.kind() != std::io::ErrorKind::WouldBlock {
                                    eprintln!("[SSH] Write error: {}", e);
                                    active = false;
                                    break;
                                }
                                thread::sleep(Duration::from_millis(5)); // Give it a moment to unblock
                            }
                        }
                    }
                    let _ = channel.flush();
                }

                // Keep CPU usage low
                thread::sleep(Duration::from_millis(10));
            }

            // Cleanup when loop ends
            let _ = channel.close();
            let _ = channel.wait_close();
            let _ = sess.disconnect(None, "User disconnected", None);
            eprintln!("[SSH] Background thread closed");
            let _ = app_clone.emit("ssh-disconnected", ());
        });

        Ok(())
    }

    pub fn write_data(&self, data: Vec<u8>) -> Result<(), String> {
        let tx_lock = self.tx.lock().unwrap();
        if let Some(sender) = tx_lock.as_ref() {
            sender
                .send(data)
                .map_err(|e| format!("Failed to send data to SSH thread: {}", e))?;
            Ok(())
        } else {
            Err("SSH connection not active or sender not initialized".to_string())
        }
    }

    pub fn set_reactions(&self, new_reactions: Vec<Reaction>) {
        let mut r_lock = self.reactions.lock().unwrap();
        *r_lock = new_reactions;
    }

    pub fn disconnect(&self) {
        // Drop the sender to signal the background thread to shut down
        {
            let mut tx_lock = self.tx.lock().unwrap();
            *tx_lock = None;
        }
        // Shut down the TCP stream directly to force close the connection
        {
            let mut t = self.tcp.lock().unwrap();
            if let Some(stream) = t.take() {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        }
        eprintln!("[SSH] Disconnected");
    }

    pub fn is_connected(&self) -> bool {
        self.tcp.lock().unwrap().is_some()
    }
}
