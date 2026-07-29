# VNC Remote Desktop Setup Guide for Host Machines

Plan Terminal includes built-in support for **VNC Remote Desktop** over WebRTC. You do **not** need to buy or install any client-side viewer software—Plan Terminal includes an embedded HTML5 VNC engine (`@novnc/novnc`).

To control a remote machine's desktop, the **Host Machine** (the computer whose screen you want to control) simply needs a free, open-source VNC server running on TCP port `5900`.

---

## 1. Raspberry Pi OS (Bookworm / Wayland)

Raspberry Pi OS (Bookworm) uses Wayland by default. The recommended free, open-source VNC server for Wayland is **`wayvnc`**.

### Installation & Run:
```bash
# 1. Install wayvnc
sudo apt update
sudo apt install -y wayvnc

# 2. Run wayvnc listening on port 5900 (local interface)
wayvnc 127.0.0.1 5900
```

### Auto-start on Boot (Systemd Service):
Create `/etc/systemd/system/wayvnc.service`:
```ini
[Unit]
Description=WayVNC Remote Desktop Server
After=graphical.target

[Service]
ExecStart=/usr/bin/wayvnc 127.0.0.1 5900
Restart=always
User=pi

[Install]
WantedBy=graphical.target
```
Enable it:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wayvnc
```

---

## 2. Linux (X11 / Ubuntu / Debian)

For Linux systems running X11, **`x11vnc`** or **`tigervnc`** are 100% free and open-source (GPL).

### Installation & Run:
```bash
# 1. Install x11vnc
sudo apt update
sudo apt install -y x11vnc

# 2. Set an optional VNC password
x11vnc -storepasswd mypassword ~/.vnc/passwd

# 3. Run x11vnc on port 5900
x11vnc -rfbport 5900 -forever -bg -rfbauth ~/.vnc/passwd
```

---

## 3. Windows (10 / 11)

Windows can use **TightVNC Server** or **UltraVNC** (100% free and open-source GPL).

1. Download the free **TightVNC Server** installer from [tightvnc.com](https://www.tightvnc.com/).
2. Run the installer and select **TightVNC Server**.
3. Set your administrative and connection password during setup.
4. TightVNC runs automatically as a Windows service listening on port `5900`.

---

## 4. macOS

macOS includes a **built-in free VNC server** (Screen Sharing).

1. Open **System Settings** → **General** → **Sharing**.
2. Enable **Screen Sharing**.
3. Click the `(i)` info icon next to Screen Sharing → **Computer Settings**.
4. Enable **"VNC viewers may control screen with password"** and type your password.
5. macOS is now ready for Plan Terminal VNC connections on port `5900`.

---

## Connecting in Plan Terminal

1. Open **Plan Terminal**.
2. In the top connection dropdown, select **VNC (Remote Desktop)**.
3. Set Host (`127.0.0.1` or target IP) and Port (`5900`).
4. Click **Connect**.
5. Enjoy full interactive remote desktop control (mouse, keyboard, scale-to-fit, view-only mode, and full screen)!
