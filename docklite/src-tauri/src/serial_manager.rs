use crate::ActiveReaction;
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PortInfo {
    port_name: String,
    info: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SerialConfig {
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub flow_control: String,
    pub parity: String,
    pub stop_bits: u8,
}

pub struct TabState {
    pub read_port: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    pub write_port: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    pub is_reading: Arc<Mutex<bool>>,
    pub reactions: Arc<Mutex<Vec<ActiveReaction>>>,
    pub packet_timeout: Arc<Mutex<u64>>,
    pub log_file: Arc<Mutex<Option<BufWriter<File>>>>,
    pub log_format: Arc<Mutex<crate::log_utils::LogFormat>>,
    /// seq_id -> stop-sender. Dropping the sender signals the thread to exit.
    pub periodic_senders: Arc<Mutex<HashMap<String, mpsc::SyncSender<()>>>>,
    pub rolling_buffer: Arc<Mutex<Vec<u8>>>,
}

impl TabState {
    fn new() -> Self {
        Self {
            read_port: Arc::new(Mutex::new(None)),
            write_port: Arc::new(Mutex::new(None)),
            is_reading: Arc::new(Mutex::new(false)),
            reactions: Arc::new(Mutex::new(Vec::new())),
            packet_timeout: Arc::new(Mutex::new(100)),
            log_file: Arc::new(Mutex::new(None)),
            log_format: Arc::new(Mutex::new(crate::log_utils::LogFormat::Jsonl)),
            periodic_senders: Arc::new(Mutex::new(HashMap::new())),
            rolling_buffer: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

pub struct SerialManager {
    tabs: Arc<Mutex<HashMap<String, Arc<TabState>>>>,
}

impl SerialManager {
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

    pub fn set_packet_timeout(&self, tab_id: &str, timeout: u64) {
        let tab = self.get_or_create_tab(tab_id);
        let mut t_lock = tab.packet_timeout.lock().unwrap();
        *t_lock = timeout;
    }

    pub fn set_reactions(&self, tab_id: &str, new_reactions: Vec<ActiveReaction>) {
        let tab = self.get_or_create_tab(tab_id);
        let mut r_lock = tab.reactions.lock().unwrap();
        *r_lock = new_reactions;

        // Clear buffer when reactions change to avoid re-triggering on old data
        let mut b_lock = tab.rolling_buffer.lock().unwrap();
        b_lock.clear();
    }

    pub fn start_logging(
        &self,
        tab_id: &str,
        path: String,
        format: crate::log_utils::LogFormat,
    ) -> Result<(), String> {
        let tab = self.get_or_create_tab(tab_id);

        eprintln!("[LOG] [{}] Starting Session Recording to: {}", tab_id, path);

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;

        let writer = BufWriter::new(file);

        let mut lfile = tab.log_file.lock().unwrap();
        *lfile = Some(writer);

        let mut f_lock = tab.log_format.lock().unwrap();
        *f_lock = format;

        Ok(())
    }

    pub fn stop_logging(&self, tab_id: &str) {
        let tab = self.get_or_create_tab(tab_id);
        let mut lfile = tab.log_file.lock().unwrap();
        if let Some(ref mut writer) = *lfile {
            let _ = writer.flush();
        }
        *lfile = None;
    }

    pub fn is_logging(&self, tab_id: &str) -> bool {
        let tab = self.get_or_create_tab(tab_id);
        let logging = tab.log_file.lock().unwrap().is_some();
        logging
    }

    /// Starts a native OS thread that fires `data` every `interval_ms` milliseconds.
    /// The thread exits cleanly when the stop channel is dropped (i.e. stop_periodic is called).
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

        let write_port = tab.write_port.clone();
        let log_file = tab.log_file.clone();
        let log_format = tab.log_format.clone();
        let tab_id_str = tab_id.to_string();

        thread::spawn(move || {
            loop {
                // Wait for interval or stop signal
                match rx.recv_timeout(Duration::from_millis(interval_ms)) {
                    Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // Time to fire
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_millis();

                        let mut wp = write_port.lock().unwrap();
                        if let Some(port) = wp.as_mut() {
                            let _ = port.write_all(&data);
                            let _ = port.flush();
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
                            // Port gone — stop thread
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

    pub fn list_ports() -> Vec<PortInfo> {
        let ports = serialport::available_ports().expect("No ports found!");
        ports
            .into_iter()
            .map(|p| {
                let info = match p.port_type {
                    SerialPortType::UsbPort(info) => format!(
                        "USB {:04x}:{:04x} {}",
                        info.vid,
                        info.pid,
                        info.product.unwrap_or_default()
                    ),
                    SerialPortType::PciPort => "PCI".to_string(),
                    SerialPortType::BluetoothPort => "Bluetooth".to_string(),
                    SerialPortType::Unknown => "Unknown".to_string(),
                };
                PortInfo {
                    port_name: p.port_name,
                    info,
                }
            })
            .collect()
    }

    pub fn open_port(
        &self,
        app: AppHandle,
        tab_id: &str,
        config: SerialConfig,
    ) -> Result<(), String> {
        let tab = self.get_or_create_tab(tab_id);

        let data_bits = match config.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        };
        let flow_control = match config.flow_control.as_str() {
            "Software" => FlowControl::Software,
            "Hardware" => FlowControl::Hardware,
            _ => FlowControl::None,
        };
        let parity = match config.parity.as_str() {
            "Odd" => Parity::Odd,
            "Even" => Parity::Even,
            _ => Parity::None,
        };
        let stop_bits = match config.stop_bits {
            2 => StopBits::Two,
            _ => StopBits::One,
        };

        let builder = serialport::new(&config.port_name, config.baud_rate)
            .data_bits(data_bits)
            .flow_control(flow_control)
            .parity(parity)
            .stop_bits(stop_bits)
            .timeout(Duration::from_millis(1));

        std::thread::sleep(Duration::from_millis(100));

        match builder.open() {
            Ok(port) => {
                let write_port = port.try_clone().map_err(|e| e.to_string())?;

                let mut rp = tab.read_port.lock().unwrap();
                *rp = Some(port);
                drop(rp);

                let mut wp = tab.write_port.lock().unwrap();
                *wp = Some(write_port);
                drop(wp);

                self.start_reader(app, tab_id.to_string(), tab);
                Ok(())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn close_port(&self, tab_id: &str) {
        let tabs = self.tabs.lock().unwrap();
        if let Some(tab) = tabs.get(tab_id) {
            let mut rp = tab.read_port.lock().unwrap();
            *rp = None;
            let mut wp = tab.write_port.lock().unwrap();
            *wp = None;
            let mut r_lock = tab.is_reading.lock().unwrap();
            *r_lock = false;
        }
    }

    fn start_reader(&self, app: AppHandle, tab_id: String, tab: Arc<TabState>) {
        let read_port = tab.read_port.clone();
        let write_port = tab.write_port.clone();
        let is_reading = tab.is_reading.clone();
        let reactions = tab.reactions.clone();
        let log_file = tab.log_file.clone();
        let log_format = tab.log_format.clone();
        let rolling_buffer = tab.rolling_buffer.clone();

        let mut reader_lock = is_reading.lock().unwrap();
        if *reader_lock {
            return;
        }
        *reader_lock = true;
        drop(reader_lock);

        thread::spawn(move || {
            let mut serial_buf: Vec<u8> = vec![0; 4096];

            loop {
                if !*is_reading.lock().unwrap() {
                    break;
                }

                let read_result = {
                    let mut p = read_port.lock().unwrap();
                    if let Some(port) = p.as_mut() {
                        match port.read(serial_buf.as_mut_slice()) {
                            Ok(t) => Some(t),
                            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => Some(0),
                            Err(_) => None,
                        }
                    } else {
                        None
                    }
                };
                let mut should_sleep = true;

                match read_result {
                    Some(bytes_read) => {
                        if bytes_read > 0 {
                            should_sleep = false;
                            let data = serial_buf[..bytes_read].to_vec();
                            let ts = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap()
                                .as_millis();

                            let _ = app.emit(
                                "serial-data",
                                (tab_id.clone(), data.clone(), ts as u64, "RX"),
                            );

                            // BROADCAST TO WEBRTC PEERS (Mirroring)
                            let label = if tab_id == "main" { "serial-bridge".to_string() } else { format!("serial-{}", tab_id) };
                            let data_to_broadcast = data.clone();
                            tauri::async_runtime::block_on(async move {
                                crate::share_manager::broadcast_remote_data(label, data_to_broadcast).await;
                            });

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
                                                let ts = SystemTime::now()
                                                    .duration_since(UNIX_EPOCH)
                                                    .unwrap()
                                                    .as_millis();
                                                let _ = app.emit(
                                                    "serial-data",
                                                    (
                                                        tab_id.clone(),
                                                        r.response_data.clone(),
                                                        ts as u64,
                                                        "TX_AUTO",
                                                    ),
                                                );

                                                let mut wp = write_port.lock().unwrap();
                                                if let Some(port) = wp.as_mut() {
                                                    let _ = port.write_all(&r.response_data);
                                                    let _ = port.flush();
                                                }

                                                crate::log_utils::write_log_entry(
                                                    &log_file,
                                                    &log_format,
                                                    &r.response_data,
                                                    "TX_AUTO",
                                                );

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
                    }
                    None => {
                        let mut r_lock = is_reading.lock().unwrap();
                        *r_lock = false;
                        eprintln!("Serial read error or disconnected on tab {}", tab_id);
                        break;
                    }
                }

                if should_sleep {
                    thread::sleep(Duration::from_millis(1));
                }
            }
        });
    }

    pub fn write_data(
        &self,
        app: &AppHandle,
        tab_id: &str,
        data: Vec<u8>,
        direction: &str,
    ) -> Result<(), String> {
        let tab = self.get_or_create_tab(tab_id);
        use std::io::Write;
        let mut p = tab.write_port.lock().unwrap();
        if let Some(port) = p.as_mut() {
            match port.write_all(&data) {
                Ok(_) => {
                    let _ = port.flush();
                    let ts = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_millis();
                    // Emit event so the local terminal and the share_manager can see it
                    let _ = app.emit(
                        "serial-data",
                        (
                            tab_id.to_string(),
                            data.clone(),
                            ts as u64,
                            direction.to_string(),
                        ),
                    );
                    crate::log_utils::write_log_entry(
                        &tab.log_file,
                        &tab.log_format,
                        &data,
                        direction,
                    );
                    Ok(())
                }
                Err(e) => Err(e.to_string()),
            }
        } else {
            Err("Port not open".to_string())
        }
    }
}
