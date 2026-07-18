use chrono::Local;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::LazyLock;

static COUNTERS: LazyLock<Mutex<HashMap<String, i32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn evaluate_dynamic_tags(input: &[u8]) -> Vec<u8> {
    let mut result = Vec::new();
    let mut i = 0;

    while i < input.len() {
        // Look for "{{"
        if i + 1 < input.len() && input[i] == b'{' && input[i + 1] == b'{' {
            let mut j = i + 2;
            let mut found_end = false;
            // Find "}}"
            while j + 1 < input.len() {
                if input[j] == b'}' && input[j + 1] == b'}' {
                    found_end = true;
                    break;
                }
                j += 1;
            }

            if found_end {
                let tag_bytes = &input[i + 2..j];
                if let Ok(tag_str) = std::str::from_utf8(tag_bytes) {
                    let tag = tag_str.trim();
                    let mut replaced = false;

                    if tag == "TIME" {
                        let now = Local::now().format("%H:%M:%S").to_string();
                        result.extend_from_slice(now.as_bytes());
                        replaced = true;
                    } else if let Some(fmt) = tag.strip_prefix("TIME:") {
                        let now = Local::now().format(fmt).to_string();
                        result.extend_from_slice(now.as_bytes());
                        replaced = true;
                    } else if tag == "DATE" {
                        let now = Local::now().format("%d/%m/%Y").to_string();
                        result.extend_from_slice(now.as_bytes());
                        replaced = true;
                    } else if let Some(fmt) = tag.strip_prefix("DATE:") {
                        let now = Local::now().format(fmt).to_string();
                        result.extend_from_slice(now.as_bytes());
                        replaced = true;
                    } else if tag == "DATETIME" {
                        let now = Local::now().format("%d/%m/%Y %H:%M:%S").to_string();
                        result.extend_from_slice(now.as_bytes());
                        replaced = true;
                    } else if let Some(fmt) = tag.strip_prefix("DATETIME:") {
                        let now = Local::now().format(fmt).to_string();
                        result.extend_from_slice(now.as_bytes());
                        replaced = true;
                    } else if tag.starts_with("COUNT:") {
                        let parts: Vec<&str> = tag.split(':').collect();
                        if parts.len() == 3 {
                            if let (Ok(min), Ok(max)) = (parts[1].parse::<i32>(), parts[2].parse::<i32>()) {
                                let mut counters = COUNTERS.lock().unwrap();
                                let current = counters.entry(tag.to_string()).or_insert(min - 1);
                                *current += 1;
                                if *current > max {
                                    *current = min;
                                }
                                result.extend_from_slice(current.to_string().as_bytes());
                                replaced = true;
                            }
                        }
                    }

                    if replaced {
                        i = j + 2;
                        continue;
                    }
                }
            }
        }
        
        result.push(input[i]);
        i += 1;
    }

    result
}
