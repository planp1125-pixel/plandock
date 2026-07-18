use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy)]
pub enum LogFormat {
    Hex,
    Ascii,
    Both,
    Jsonl,
}

pub fn write_log_entry(
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
            let ascii_str: String = data
                .iter()
                .map(|&b| if b >= 32 && b < 127 { b as char } else { '.' })
                .collect();
            format!(
                "{{\"ts\":{},\"time\":\"{}\",\"dir\":\"{}\",\"data\":{:?},\"ascii\":\"{}\"}}\n",
                ts_ms,
                timestamp,
                direction,
                data,
                ascii_str.replace("\"", "\\\"").replace("\\", "\\\\")
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
