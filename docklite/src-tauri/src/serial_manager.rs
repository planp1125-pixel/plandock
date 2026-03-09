use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};
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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PortInfo {
    port_name: String,
    info: String,
}

use crate::project_manager::{parse_hex_string, Reaction};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SerialConfig {
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: u8,        // 5, 6, 7, 8
    pub flow_control: String, // "None", "Software", "Hardware"
    pub parity: String,       // "None", "Odd", "Even"
    pub stop_bits: u8,        // 1, 2
}

pub struct SerialManager {
    read_port: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    write_port: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    is_reading: Arc<Mutex<bool>>,
    reactions: Arc<Mutex<Vec<Reaction>>>,
    packet_timeout: Arc<Mutex<u64>>,
    log_file: Arc<Mutex<Option<BufWriter<File>>>>,
    log_format: Arc<Mutex<LogFormat>>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            read_port: Arc::new(Mutex::new(None)),
            write_port: Arc::new(Mutex::new(None)),
            is_reading: Arc::new(Mutex::new(false)),
            reactions: Arc::new(Mutex::new(Vec::new())),
            packet_timeout: Arc::new(Mutex::new(100)),
            log_file: Arc::new(Mutex::new(None)),
            log_format: Arc::new(Mutex::new(LogFormat::Both)),
        }
    }

    pub fn set_packet_timeout(&self, timeout: u64) {
        let mut t_lock = self.packet_timeout.lock().unwrap();
        *t_lock = timeout;
    }

    pub fn set_reactions(&self, new_reactions: Vec<Reaction>) {
        let mut r_lock = self.reactions.lock().unwrap();
        *r_lock = new_reactions;
    }

    /// Start real-time logging to a file
    pub fn start_logging(&self, path: &str, format: &str) -> Result<(), String> {
        let log_format = match format {
            "hex" => LogFormat::Hex,
            "ascii" => LogFormat::Ascii,
            _ => LogFormat::Both,
        };

        eprintln!(
            "[LOG] Starting logging to: {} with format: {:?}",
            path, log_format
        );

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;

        let mut writer = BufWriter::new(file);

        // Write header
        let header = format!(
            "=== Plan Terminal Log Started: {} ===\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        );
        writer
            .write_all(header.as_bytes())
            .map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;

        let mut lf = self.log_format.lock().unwrap();
        *lf = log_format;
        drop(lf);

        let mut lfile = self.log_file.lock().unwrap();
        *lfile = Some(writer);

        // Write a test marker to confirm logging pipeline is working
        if let Some(ref mut w) = *lfile {
            let test_line = format!(
                "[{}] --- Logging active, format: {:?}, waiting for data... ---\n",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                log_format
            );
            let _ = w.write_all(test_line.as_bytes());
            let _ = w.flush();
        }

        eprintln!(
            "[LOG] Logging started successfully. log_file is Some: {}",
            lfile.is_some()
        );

        Ok(())
    }

    /// Stop logging and close the file
    pub fn stop_logging(&self) {
        let mut lfile = self.log_file.lock().unwrap();
        if let Some(ref mut writer) = *lfile {
            let footer = format!(
                "=== Plan Terminal Log Ended: {} ===\n",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            );
            let _ = writer.write_all(footer.as_bytes());
            let _ = writer.flush();
        }
        *lfile = None;
    }

    /// Check if logging is active
    pub fn is_logging(&self) -> bool {
        self.log_file.lock().unwrap().is_some()
    }

    /// Write a log entry
    fn write_log_entry(
        log_file: &Arc<Mutex<Option<BufWriter<File>>>>,
        log_format: &Arc<Mutex<LogFormat>>,
        data: &[u8],
        direction: &str,
    ) {
        let mut lfile = match log_file.lock() {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[LOG] Failed to lock log_file: {}", e);
                return;
            }
        };
        if let Some(ref mut writer) = *lfile {
            let format = *log_format.lock().unwrap();
            let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.6f");

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
                    .collect::<String>(),
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
            };

            let line = format!("[{}] {} {}\n", timestamp, direction, formatted_data);
            if let Err(e) = writer.write_all(line.as_bytes()) {
                eprintln!("[LOG] write_all failed: {}", e);
            }
            if let Err(e) = writer.flush() {
                eprintln!("[LOG] flush failed: {}", e);
            }
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

    pub fn open_port(&self, app: AppHandle, config: SerialConfig) -> Result<(), String> {
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

        match builder.open() {
            Ok(port) => {
                // Clone the port for separate read/write handles
                let write_port = port.try_clone().map_err(|e| e.to_string())?;

                let mut rp = self.read_port.lock().unwrap();
                *rp = Some(port);
                drop(rp);

                let mut wp = self.write_port.lock().unwrap();
                *wp = Some(write_port);
                drop(wp);

                // Start generic async reader
                self.start_reader(app);
                Ok(())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn close_port(&self) {
        let mut rp = self.read_port.lock().unwrap();
        *rp = None;
        drop(rp);

        let mut wp = self.write_port.lock().unwrap();
        *wp = None;
        drop(wp);

        let mut r_lock = self.is_reading.lock().unwrap();
        *r_lock = false;
    }

    fn start_reader(&self, app: AppHandle) {
        let read_port_clone = self.read_port.clone();
        let write_port_clone = self.write_port.clone();
        let is_reading = self.is_reading.clone();
        let reactions_clone = self.reactions.clone();
        let _packet_timeout_clone = self.packet_timeout.clone();
        let log_file_clone = self.log_file.clone();
        let log_format_clone = self.log_format.clone();

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
                    let mut p = read_port_clone.lock().unwrap();
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

                            // Emit immediately: Zero Latency
                            let _ = app.emit("serial-data", (data.clone(), ts, "RX"));

                            // Write to log file if logging is active
                            Self::write_log_entry(&log_file_clone, &log_format_clone, &data, "RX");

                            // Still maintain rolling buffer for reactions
                            rolling_buffer.extend_from_slice(&data);
                            if rolling_buffer.len() > 8192 {
                                let len = rolling_buffer.len();
                                rolling_buffer.drain(0..len - 8192);
                            }

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

                                if !trigger_bytes.is_empty()
                                    && rolling_buffer.ends_with(&trigger_bytes)
                                {
                                    // Capture timestamp BEFORE write (when reaction is triggered)
                                    let ts = SystemTime::now()
                                        .duration_since(UNIX_EPOCH)
                                        .unwrap()
                                        .as_millis();

                                    // Parse response
                                    let response_bytes = if r.view_mode == "Hex" {
                                        parse_hex_string(&r.response_sequence_id)
                                            .unwrap_or_default()
                                    } else {
                                        r.response_sequence_id.as_bytes().to_vec()
                                    };

                                    // Emit event immediately (before wire transmission)
                                    let _ = app.emit(
                                        "serial-data",
                                        (response_bytes.clone(), ts, "TX_AUTO"),
                                    );

                                    // Clear matched portion to prevent re-triggering
                                    let trigger_len = trigger_bytes.len();
                                    let buf_len = rolling_buffer.len();
                                    if buf_len >= trigger_len {
                                        rolling_buffer.truncate(buf_len - trigger_len);
                                    }

                                    // Now do the actual write (blocking, but event already emitted)
                                    let mut wp = write_port_clone.lock().unwrap();
                                    if let Some(port) = wp.as_mut() {
                                        let _ = port.write_all(&response_bytes);
                                        let _ = port.flush();
                                    }

                                    // Log TX_AUTO to file
                                    Self::write_log_entry(
                                        &log_file_clone,
                                        &log_format_clone,
                                        &response_bytes,
                                        "TX_AUTO",
                                    );
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

    pub fn write_data(&self, data: Vec<u8>) -> Result<(), String> {
        use std::io::Write;
        let mut p = self.write_port.lock().unwrap();
        if let Some(port) = p.as_mut() {
            match port.write_all(&data) {
                Ok(_) => {
                    let _ = port.flush();
                    // Log TX data
                    Self::write_log_entry(&self.log_file, &self.log_format, &data, "TX");
                    Ok(())
                }
                Err(e) => Err(e.to_string()),
            }
        } else {
            Err("Port not open".to_string())
        }
    }
}
