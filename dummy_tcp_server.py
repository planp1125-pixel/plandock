import socket
import threading
import time

def handle_client(conn, addr):
    print(f"[+] Connected by {addr}")
    try:
        # Send fake trigger
        time.sleep(1)
        print("Sending SYSTEM\\r")
        conn.sendall(b"SYSTEM\r")
        while True:
            data = conn.recv(1024)
            if not data:
                break
            print(f"[RX] {data.decode('utf-8', errors='replace')} (Hex: {data.hex()})")
    except Exception as e:
        print(f"[-] Error: {e}")
    finally:
        conn.close()

def server_loop():
    host = '127.0.0.1'
    port = 9999
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((host, port))
        s.listen()
        print(f"Listening on {host}:{port} ...")
        
        while True:
            conn, addr = s.accept()
            t = threading.Thread(target=handle_client, args=(conn, addr))
            t.daemon = True
            t.start()

if __name__ == "__main__":
    server_loop()
