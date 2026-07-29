# VNC Remote Desktop Setup Guide for Host Machines

Plan Terminal includes built-in support for **VNC Remote Desktop** over WebRTC and native TCP. You do **not** need to buy or install any client-side viewer software—Plan Terminal includes an embedded HTML5 VNC engine (`@novnc/novnc`).

To control a remote machine's desktop, the **Host Machine** (the computer whose screen you want to control) simply needs a free VNC server running on TCP port `5900`.

---

## 1. Raspberry Pi OS (Bookworm / Wayland & X11)

Raspberry Pi OS ships with built-in VNC support. You can choose between **x11vnc**, **wayvnc**, or **RealVNC**.

### Option A: `x11vnc` (Recommended for X11 / Classic Desktop)

1. Stop default RealVNC if running (to free port 5900):
   ```bash
   sudo systemctl stop vncserver-x11-serviced
   sudo systemctl disable vncserver-x11-serviced
   ```

2. Install `x11vnc`:
   ```bash
   sudo apt update && sudo apt install -y x11vnc
   ```

3. Run `x11vnc`:
   - **No password**:
     ```bash
     x11vnc -rfbport 5900 -nopw -forever -bg
     ```
   - **With password** (e.g. `mypassword`):
     ```bash
     x11vnc -storepasswd mypassword ~/.vnc/passwd
     x11vnc -rfbport 5900 -rfbauth ~/.vnc/passwd -forever -bg
     ```

### Option B: `wayvnc` (Recommended for Wayland)

1. Install `wayvnc`:
   ```bash
   sudo apt update && sudo apt install -y wayvnc
   ```

2. Run `wayvnc` listening on port `5900`:
   ```bash
   wayvnc 0.0.0.0 5900
   ```

### Option C: RealVNC (`vncserver-x11`)

If you prefer using the pre-installed RealVNC server:
1. Configure RealVNC for standard VNC password authentication:
   ```bash
   sudo vncpasswd -service
   echo -e "Authentication=VncAuth\nEncryption=PreferOff" | sudo tee -a /etc/vnc/config.d/vncserver-x11
   sudo systemctl restart vncserver-x11-serviced
   ```

---

## 2. Linux (Ubuntu / Debian / Fedora)

For Linux desktops (X11):

```bash
# 1. Install x11vnc
sudo apt update && sudo apt install -y x11vnc

# 2. Run x11vnc on port 5900
x11vnc -rfbport 5900 -nopw -forever -bg
```

---

## 3. Windows (10 / 11)

Windows can use **TightVNC Server** or **UltraVNC** (100% free and open-source GPL).

1. Download free **TightVNC Server** from [tightvnc.com](https://www.tightvnc.com/).
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

## 🔌 Connecting in Plan Terminal

1. Open **Plan Terminal**.
2. In the top connection dropdown, select **`VNC (Remote Desktop)`**.
3. Enter **Host IP** (e.g. `192.168.1.20`) and **Port** (`5900`).
4. Enter **Password** (or leave blank if running in `-nopw` mode).
5. Click **Connect**.
6. Enjoy full interactive remote desktop control (mouse, keyboard, scale-to-fit, view-only mode, and full screen)!
