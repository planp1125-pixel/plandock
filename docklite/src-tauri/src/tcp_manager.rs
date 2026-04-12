use crate::ActiveReaction;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::net::TcpStream;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub struct TabState {
    pub stream: Arc<Mutex<Option<Arc<TcpStream>>>>,
    pub is_reading: Arc<Mutex<bool>>,
    pub log_file: Arc<Mutex<Option<BufWriter<File>>>>,
    pub reactions: Arc<Mutex<Vec<ActiveReaction>>>,
    pub log_format: Arc<Mutex<crate::log_utils::LogFormat>>,
    pub periodic_senders: Arc<Mutex<HashMap<String, mpsc::SyncSender<()>>>>,
    pub rolling_buffer: Arc<Mutex<Vec<u8>>>,
}

impl TabState {
    fn new() -> Self {
        Self {
            stream: Arc::new(Mutex::new(None)),
            is_reading: Arc::new(Mutex::new(false)),
            log_file: Arc::new(Mutex::new(None)),
            reactions: Arc::new(Mutex::new(Vec::new())),
            log_format: Arc::new(Mutex::new(crate::log_utils::LogFormat::Jsonl)),
            periodic_senders: Arc::new(Mutex::new(HashMap::new())),
            rolling_buffer: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

pub struct TcpManager {
    tabs: Arc<Mutex<HashMap<String, Arc<TabState>>>>,
}

impl TcpManager {
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
    ) -> Result<(), String> {
        self.disconnect(tab_id);
        std::thread::sleep(Duration::from_millis(100));

        let addr = format!("{}:{}", host, port);
        eprintln!("[TCP] [{}] Connecting to {}", tab_id, addr);

        let stream = TcpStream::connect_timeout(
            &addr
                .parse()
                .map_err(|e| format!("Invalid address: {}", e))?,
            Duration::from_secs(5),
        )
        .map_err(|e| format!("Connection failed: {}", e))?;

        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;

        let shared_stream = Arc::new(stream);
        let tab = self.get_or_create_tab(tab_id);

        {
            let mut s = tab.stream.lock().unwrap();
            *s = Some(shared_stream.clone());
        }

        self.start_reader(app, tab_id.to_string(), tab, shared_stream);

        eprintln!("[TCP] [{}] Connected", tab_id);
        Ok(())
    }

    pub fn set_reactions(&self, tab_id: &str, new_reactions: Vec<ActiveReaction>) {
        let tab = self.get_or_create_tab(tab_id);
        let mut r_lock = tab.reactions.lock().unwrap();
        *r_lock = new_reactions;
        // Clear buffer on reaction update
        let mut b_lock = tab.rolling_buffer.lock().unwrap();
        b_lock.clear();
    }

    pub fn disconnect(&self, tab_id: &str) {
        let mut tabs = self.tabs.lock().unwrap();
        if let Some(tab) = tabs.remove(tab_id) {
            {
                let mut r = tab.is_reading.lock().unwrap();
                *r = false;
            }
            thread::sleep(Duration::from_millis(50));
            {
                let mut s = tab.stream.lock().unwrap();
                if let Some(stream_arc) = s.as_ref() {
                    let _ = stream_arc.shutdown(std::net::Shutdown::Both);
                }
                *s = None;
            }
            eprintln!("[TCP] [{}] Disconnected", tab_id);
        }
    }

    pub fn is_connected(&self, tab_id: &str) -> bool {
        let tabs = self.tabs.lock().unwrap();
        if let Some(tab) = tabs.get(tab_id) {
            tab.stream.lock().unwrap().is_some()
        } else {
            false
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

        // Stop any existing thread for this seq first
        tab.periodic_senders.lock().unwrap().remove(&seq_id);

        let (tx, rx) = mpsc::sync_channel::<()>(0);
        tab.periodic_senders
            .lock()
            .unwrap()
            .insert(seq_id.clone(), tx);

        let stream_clone = tab.stream.clone();
        let log_file = tab.log_file.clone();
        let log_format = tab.log_format.clone();
        let tab_id_str = tab_id.to_string();

        thread::spawn(move || loop {
            match rx.recv_timeout(Duration::from_millis(interval_ms)) {
                Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let ts = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_millis();

                    let s = stream_clone.lock().unwrap();
                    if let Some(stream_arc) = s.as_ref() {
                        let mut s_ref = &**stream_arc;
                        let _ = s_ref.write_all(&data);
                        let _ = s_ref.flush();
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

    pub fn write_data(&self, tab_id: &str, data: Vec<u8>) -> Result<(), String> {
        let tab = self.get_or_create_tab(tab_id);
        let s = tab.stream.lock().unwrap();
        if let Some(stream_arc) = s.as_ref() {
            let mut s_ref = &**stream_arc;
            match s_ref.write_all(&data) {
                Ok(_) => {
                    let _ = s_ref.flush();
                    crate::log_utils::write_log_entry(&tab.log_file, &tab.log_format, &data, "TX");
                    Ok(())
                }
                Err(e) => Err(format!("TCP write failed: {}", e)),
            }
        } else {
            Err("Not connected".to_string())
        }
    }

    fn start_reader(
        &self,
        app: AppHandle,
        tab_id: String,
        tab: Arc<TabState>,
        read_stream: Arc<TcpStream>,
    ) {
        let is_reading = tab.is_reading.clone();
        let reactions = tab.reactions.clone();
        let stream_clone = tab.stream.clone();
        let log_file = tab.log_file.clone();
        let log_format = tab.log_format.clone();
        let rolling_buffer = tab.rolling_buffer.clone();

        {
            let mut r = is_reading.lock().unwrap();
            if *r {
                return;
            }
            *r = true;
        }

        thread::spawn(move || {
            let mut buf = vec![0u8; 4096];

            loop {
                if !*is_reading.lock().unwrap() {
                    break;
                }

                let mut rs_ref = read_stream.as_ref();
                match rs_ref.read(&mut buf) {
                    Ok(0) => {
                        let _ = app.emit("tcp-disconnected", tab_id.clone());
                        break;
                    }
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_millis();

                        let _ = app.emit("serial-data", (tab_id.clone(), data.clone(), ts, "RX"));
                        crate::log_utils::write_log_entry(&log_file, &log_format, &data, "RX");

                        let mut rb_lock = rolling_buffer.lock().unwrap();
                        rb_lock.extend_from_slice(&data);
                        if rb_lock.len() > 8192 {
                            let len = rb_lock.len();
                            rb_lock.drain(0..len - 8192);
                        }

                        loop {
                            let mut matched = false;
                            {
                                let rxns = reactions.lock().unwrap();
                                for r in rxns.iter() {
                                    if !r.trigger_data.is_empty() {
                                        if let Some(pos) = rb_lock
                                            .windows(r.trigger_data.len())
                                            .position(|w| w == r.trigger_data)
                                        {
                                            let start_ts = SystemTime::now()
                                                .duration_since(UNIX_EPOCH)
                                                .unwrap()
                                                .as_millis();
                                            let _ = app.emit(
                                                "serial-data",
                                                (
                                                    tab_id.clone(),
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

                                            if let Some(w_stream_arc) =
                                                stream_clone.lock().unwrap().as_ref()
                                            {
                                                let mut w_stream = &**w_stream_arc;
                                                let _ = w_stream.write_all(&r.response_data);
                                                let _ = w_stream.flush();
                                            }

                                            let match_end = pos + r.trigger_data.len();
                                            rb_lock.drain(0..match_end);
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
                    Err(_) => {
                        let _ = app.emit("tcp-disconnected", tab_id.clone());
                        break;
                    }
                }
            }

            let mut r = is_reading.lock().unwrap();
            *r = false;
        });
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
