import socket
import threading
import time
import io
import contextlib

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
            
            # Easter Egg trigger
            if data.strip() == b"FLY":
                import antigravity
                conn.sendall(b"You are now flying...\n")
                
            # Geohashing Easter Egg context
            elif data.startswith(b"GEOHASH"):
                try:
                    # Expected format: GEOHASH 37.421542 -122.085589 2005-05-26-10458.68
                    parts = data.decode('utf-8', errors='ignore').strip().split()
                    lat, lon, date = float(parts[1]), float(parts[2]), parts[3].encode('utf-8')
                    
                    import antigravity
                    f = io.StringIO()
                    with contextlib.redirect_stdout(f):
                        antigravity.geohash(lat, lon, date)
                    conn.sendall(f"Geohash Destination: {f.getvalue()}".encode('utf-8'))
                except Exception as e:
                    conn.sendall(b"GEOHASH Error. Usage: GEOHASH <lat> <lon> <date_dow>\n")
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
