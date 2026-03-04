use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub struct TcpManager {
    stream: Arc<Mutex<Option<TcpStream>>>,
    is_reading: Arc<Mutex<bool>>,
    log_file: Arc<Mutex<Option<BufWriter<File>>>>,
}

impl TcpManager {
    pub fn new() -> Self {
        Self {
            stream: Arc::new(Mutex::new(None)),
            is_reading: Arc::new(Mutex::new(false)),
            log_file: Arc::new(Mutex::new(None)),
        }
    }

    pub fn connect(&self, app: AppHandle, host: &str, port: u16) -> Result<(), String> {
        // Close any existing connection
        self.disconnect();

        let addr = format!("{}:{}", host, port);
        eprintln!("[TCP] Connecting to {}", addr);

        let stream = TcpStream::connect_timeout(
            &addr
                .parse()
                .map_err(|e| format!("Invalid address: {}", e))?,
            Duration::from_secs(5),
        )
        .map_err(|e| format!("Connection failed: {}", e))?;

        // Set non-blocking read timeout
        stream
            .set_read_timeout(Some(Duration::from_millis(1)))
            .map_err(|e| e.to_string())?;

        // Clone for the write side
        let write_stream = stream.try_clone().map_err(|e| e.to_string())?;

        {
            let mut s = self.stream.lock().unwrap();
            *s = Some(write_stream);
        }

        // Start reader thread
        self.start_reader(app, stream);

        eprintln!("[TCP] Connected to {}", addr);
        Ok(())
    }

    pub fn disconnect(&self) {
        {
            let mut r = self.is_reading.lock().unwrap();
            *r = false;
        }
        // Give reader thread time to exit
        thread::sleep(Duration::from_millis(50));
        {
            let mut s = self.stream.lock().unwrap();
            if let Some(ref stream) = *s {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            *s = None;
        }
        eprintln!("[TCP] Disconnected");
    }

    pub fn is_connected(&self) -> bool {
        self.stream.lock().unwrap().is_some()
    }

    pub fn write_data(&self, data: Vec<u8>) -> Result<(), String> {
        let mut s = self.stream.lock().unwrap();
        if let Some(ref mut stream) = *s {
            stream
                .write_all(&data)
                .map_err(|e| format!("TCP write failed: {}", e))?;
            stream.flush().map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Not connected".to_string())
        }
    }

    fn start_reader(&self, app: AppHandle, mut read_stream: TcpStream) {
        let is_reading = self.is_reading.clone();

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

                match read_stream.read(&mut buf) {
                    Ok(0) => {
                        // Connection closed by remote
                        eprintln!("[TCP] Connection closed by remote");
                        let _ = app.emit("tcp-disconnected", ());
                        break;
                    }
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_millis();

                        // Emit to frontend (same event format as serial)
                        let _ = app.emit("serial-data", (data.clone(), ts, "RX"));
                    }
                    Err(ref e)
                        if e.kind() == std::io::ErrorKind::TimedOut
                            || e.kind() == std::io::ErrorKind::WouldBlock =>
                    {
                        // No data available, sleep briefly
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(e) => {
                        eprintln!("[TCP] Read error: {}", e);
                        let _ = app.emit("tcp-disconnected", ());
                        break;
                    }
                }
            }

            let mut r = is_reading.lock().unwrap();
            *r = false;
        });
    }
}
