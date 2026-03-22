use crate::ActiveReaction;
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LogFormat {
    Hex,
    Ascii,
    Both,
    Jsonl,
}

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
    pub log_format: Arc<Mutex<LogFormat>>,
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
            log_format: Arc::new(Mutex::new(LogFormat::Jsonl)),
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
    }

    pub fn start_logging(&self, tab_id: &str, path: String) -> Result<(), String> {
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

    fn write_log_entry(
        log_file: &Arc<Mutex<Option<BufWriter<File>>>>,
        log_format: &Arc<Mutex<LogFormat>>,
        data: &[u8],
        direction: &str,
    ) {
        let mut lfile = match log_file.lock() {
            Ok(l) => l,
            Err(_) => return,
        };
        if let Some(ref mut writer) = *lfile {
            let format = *log_format.lock().unwrap();
            let ts_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis();
            let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.6f");

            let line = if matches!(format, LogFormat::Jsonl) {
                format!(
                    "{{\"ts\":{},\"dir\":\"{}\",\"data\":{:?}}}\n",
                    ts_ms, direction, data
                )
            } else {
                let formatted_data = match format {
                    LogFormat::Hex => data
                        .iter()
                        .map(|b| format!("{:02X}", b))
                        .collect::<Vec<_>>()
                        .join(" "),
                    LogFormat::Ascii => data
                        .iter()
                        .map(|b| {
                            if *b >= 32 && *b < 127 {
                                (*b as char).to_string()
                            } else {
                                format!("<{:02X}>", b)
                            }
                        })
                        .collect(),
                    LogFormat::Both => {
                        let hex = data
                            .iter()
                            .map(|b| format!("{:02X}", b))
                            .collect::<Vec<_>>()
                            .join(" ");
                        let ascii: String = data
                            .iter()
                            .map(|b| {
                                if *b >= 32 && *b < 127 {
                                    *b as char
                                } else {
                                    '.'
                                }
                            })
                            .collect();
                        format!("{} | {}", hex, ascii)
                    }
                    LogFormat::Jsonl => String::new(),
                };
                format!("[{}] {} {}\n", timestamp, direction, formatted_data)
            };

            let _ = writer.write_all(line.as_bytes());
            let _ = writer.flush();
        }
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
        let mut tabs = self.tabs.lock().unwrap();
        if let Some(tab) = tabs.remove(tab_id) {
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

        let mut reader_lock = is_reading.lock().unwrap();
        if *reader_lock {
            return;
        }
        *reader_lock = true;
        drop(reader_lock);

        thread::spawn(move || {
            let mut serial_buf: Vec<u8> = vec![0; 4096];
            let mut rolling_buffer: Vec<u8> = Vec::new();

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

                            let _ =
                                app.emit("serial-data", (tab_id.clone(), data.clone(), ts, "RX"));

                            Self::write_log_entry(&log_file, &log_format, &data, "RX");

                            rolling_buffer.extend_from_slice(&data);
                            if rolling_buffer.len() > 8192 {
                                let len = rolling_buffer.len();
                                rolling_buffer.drain(0..len - 8192);
                            }

                            loop {
                                let mut matched = false;
                                {
                                    let rxns = reactions.lock().unwrap();
                                    for r in rxns.iter() {
                                        if !r.trigger_data.is_empty() {
                                            if let Some(pos) = rolling_buffer
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
                                                        ts,
                                                        "TX_AUTO",
                                                    ),
                                                );

                                                let mut wp = write_port.lock().unwrap();
                                                if let Some(port) = wp.as_mut() {
                                                    let _ = port.write_all(&r.response_data);
                                                    let _ = port.flush();
                                                }

                                                Self::write_log_entry(
                                                    &log_file,
                                                    &log_format,
                                                    &r.response_data,
                                                    "TX_AUTO",
                                                );

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
                    }
                    None => break,
                }

                if should_sleep {
                    thread::sleep(Duration::from_millis(1));
                }
            }
        });
    }

    pub fn write_data(&self, tab_id: &str, data: Vec<u8>) -> Result<(), String> {
        let tab = self.get_or_create_tab(tab_id);
        use std::io::Write;
        let mut p = tab.write_port.lock().unwrap();
        if let Some(port) = p.as_mut() {
            match port.write_all(&data) {
                Ok(_) => {
                    let _ = port.flush();
                    Self::write_log_entry(&tab.log_file, &tab.log_format, &data, "TX");
                    Ok(())
                }
                Err(e) => Err(e.to_string()),
            }
        } else {
            Err("Port not open".to_string())
        }
    }
}
