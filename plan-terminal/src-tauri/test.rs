use serde::{Serialize, Deserialize};

#[derive(Debug, Serialize, Deserialize)]
struct SerialEventPayload(String, Vec<u8>, u64, String);

fn main() {
    let json = r#"["main",[104,101],12345,"TX"]"#;
    let payload: SerialEventPayload = serde_json::from_str(json).unwrap();
    println!("{:?}", payload);
    println!("starts_with TX: {}", payload.3.starts_with("TX"));
}
