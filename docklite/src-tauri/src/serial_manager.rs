use serde::{Deserialize, Serialize};
use serialport::{
    DataBits, FlowControl, Parity, SerialPort, SerialPortInfo, SerialPortType, StopBits,
};
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
pub struct Reaction {
    pub trigger_data: Vec<u8>,
    pub response_data: Vec<u8>,
}

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
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            read_port: Arc::new(Mutex::new(None)),
            write_port: Arc::new(Mutex::new(None)),
            is_reading: Arc::new(Mutex::new(false)),
            reactions: Arc::new(Mutex::new(Vec::new())),
            packet_timeout: Arc::new(Mutex::new(100)),
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
        let packet_timeout_clone = self.packet_timeout.clone();

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

                            // Still maintain rolling buffer for reactions
                            rolling_buffer.extend_from_slice(&data);
                            if rolling_buffer.len() > 8192 {
                                let len = rolling_buffer.len();
                                rolling_buffer.drain(0..len - 8192);
                            }

                            let reactions = reactions_clone.lock().unwrap();
                            for r in reactions.iter() {
                                if !r.trigger_data.is_empty()
                                    && rolling_buffer.ends_with(&r.trigger_data)
                                {
                                    // Capture timestamp BEFORE write (when reaction is triggered)
                                    let ts = SystemTime::now()
                                        .duration_since(UNIX_EPOCH)
                                        .unwrap()
                                        .as_millis();
                                    
                                    // Emit event immediately (before wire transmission)
                                    let _ = app.emit(
                                        "serial-data",
                                        (r.response_data.clone(), ts, "TX_AUTO"),
                                    );

                                    // Clear matched portion to prevent re-triggering
                                    let trigger_len = r.trigger_data.len();
                                    let buf_len = rolling_buffer.len();
                                    if buf_len >= trigger_len {
                                        rolling_buffer.truncate(buf_len - trigger_len);
                                    }

                                    // Now do the actual write (blocking, but event already emitted)
                                    let mut wp = write_port_clone.lock().unwrap();
                                    if let Some(port) = wp.as_mut() {
                                        let _ = port.write_all(&r.response_data);
                                        let _ = port.flush();
                                    }
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
                    Ok(())
                }
                Err(e) => Err(e.to_string()),
            }
        } else {
            Err("Port not open".to_string())
        }
    }
}
