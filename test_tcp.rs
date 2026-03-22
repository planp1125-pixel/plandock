use std::io::{Read, Write};
use std::net::TcpStream;
fn main() {
    let mut stream = TcpStream::connect("127.0.0.1:9999").unwrap();
    stream.set_nodelay(true).unwrap();
    let mut clone = stream.try_clone().unwrap();
    clone.write_all(b"Hello TCP Server From Clone\n").unwrap();
    clone.flush().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(500));
}
