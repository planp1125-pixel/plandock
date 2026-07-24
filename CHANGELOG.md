
# Changelog

All notable changes to the **Plan Terminal** project will be documented in this file.

---

## [Unreleased]

---

## [0.5.19] - 2026-07-24

### Fixed
- **Ubuntu Ports Repository for ARM64**: Configured `ports.ubuntu.com` for `[arch=arm64]` APT sources in `.github/workflows/build.yml` to resolve 404 package fetching errors during multiarch sysroot installation.

---

## [0.5.18] - 2026-07-24

### Fixed
- **Raspberry Pi ARM64 Multiarch Sysroot**: Added Ubuntu `dpkg --add-architecture arm64` multiarch package sysroot and `PKG_CONFIG_PATH="/usr/lib/aarch64-linux-gnu/pkgconfig"` with `PKG_CONFIG_ALLOW_CROSS=1` in GitHub Actions. Resolves `glib-sys` / `webkit2gtk-sys` cross-compilation errors cleanly.

---

## [0.5.17] - 2026-07-24

### Fixed & Performance
- **Raspberry Pi Fast Native Cross-Compilation**: Switched Raspberry Pi ARM64 builds from slow QEMU emulation (`run-on-arch-action`) to native `cross-rs` compilation (`useCross: true`). Reduces build times from 30+ minutes down to 2–3 minutes and eliminates QEMU memory segfaults.

---

## [0.5.16] - 2026-07-24

### Fixed
- **Raspberry Pi ARM64 QEMU Build Fix**: Resolved `cc: internal compiler error: Segmentation fault` during `libc` linking by configuring `CARGO_BUILD_JOBS=2` and `RUSTFLAGS="-C codegen-units=1"` inside `.github/workflows/build.yml`.

---

## [0.5.15] - 2026-07-24

### Added & Fixed
- **Raspberry Pi Build Support**: Added native ARM64 compilation to the GitHub Actions release pipeline to automatically generate `.deb` and `.AppImage` packages for Raspberry Pi and other ARM64 Linux devices.

---

## [0.5.14] - 2026-07-24

### Added & Fixed
- **Live Sequence & Reaction Popup Modal Mirroring**: Opening the Sequence or Reaction Editor modal on either Host or Web Viewer automatically opens the exact same popup modal on the remote screen in real-time. Closing or saving closes both modals simultaneously.
- **Automated Public Releases**: Fixed GitHub Actions release pipeline to publish packages publicly immediately (disabled draft mode).
- **Remote Hardware Connection Trigger & Error Mirroring**: Clicking "Connect" on the Web App triggers physical port opening on the Host desktop. If connection fails (e.g. invalid serial port, TCP refused, SSH auth failed), the error popup is mirrored directly to the Web App.
- **WebRTC Control Channel JSON Slicing Fix**: Fixed a Rust control message parsing bug where leading `0x0B` control sub-type bytes caused JSON deserialization errors during remote connect requests.
- **TCP Server Mode Socket Address & Port Reuse**: Configured `socket2` with `SO_REUSEADDR` and `SO_REUSEPORT` flags and added global `disconnect_all()` clean-up to prevent `Bind failed: Address already in use (os error 98)` on TCP server re-binds.
- **Protocol Dropdown State Transmitter**: Attached direct state sync transmitters to the protocol selector dropdown (`Serial ↔ TCP ↔ SSH`) and SSH auth modes.

---

## [0.5.13] - 2026-07-24

### Security & Verification
- **Web Viewer Request ID Display**: Web Viewer displays its own Client Request ID (e.g. `100-348-829`) on the connection modal and status bar for identity verification over phone/chat before the host accepts the connection.

### Added & Fixed
- **Seamless Bi-Directional State Mirroring**: Full real-time synchronization between Host desktop app and Web Viewers for protocol toggling (`Serial ↔ TCP ↔ SSH`), Baud Rates, Parity, Data/Stop Bits, Flow Control, TCP Host/Port/Mode, and SSH parameters.
- **Bi-Directional Sequence & Reaction Editing**: Creating, editing, or deleting sequences and reactions on either side synchronizes live.
- **Bi-Directional Hardware Connect/Disconnect**: Requesting hardware connection/disconnection from the remote viewer opens/closes physical ports on the Host desktop with status validation and error feedback.
- **Reconnection & Multi-Peer State Fix**: Fixed an issue where reconnecting Web Viewers would lock at "Waiting for remote connections..." by emitting `remote-peer-connected` on DataChannel handshake.

---

## [0.5.11] - 2026-07-22

### Release
- **Release Build Trigger**: Version bump to `0.5.11` across Rust backend and React frontend.

---

## [0.5.10] - 2026-07-22

### Added
- **TCP Server Mode**: Implemented native `listen_tcp` listener support alongside client mode, allowing Plan Terminal to bind to local ports (`0.0.0.0`) and receive incoming TCP client connections directly.
- **Universal Input Enablement**: Enabled interactive terminal command input bar across all active protocol types.

### Fixed
- **TCP Server Auto-Resume**: Automatically resumes TCP server listening state on reconnection and suppresses unnecessary disconnect alerts.
- **React Variable Initialization Order**: Fixed a React initialization crash during component rendering.

---

## [0.5.9] - 2026-07-21

### Fixed
- **WebRTC Directionality Sync**: Fixed an issue where the remote web viewer and remote desktop clients would improperly display locally transmitted data (TX) as received data (RX).
- **Desktop-to-Desktop Remote Data Parsing**: Corrected a bug where raw WebRTC terminal data lacked a direction byte when sent between desktop applications, causing data corruption and improper serial logging.
- **Remote SSH Channel Identification**: Fixed SSH payloads being improperly broadcasted as serial payloads over WebRTC in Remote Mode.

---

## [0.5.8] - 2026-07-20

### Added
- **Remote Web Viewer Mode**: Enables remote engineers to monitor and control physical serial devices through a browser-based, zero-install interface at `plan-terminal.vercel.app/?id=[DEVICE_ID]`.
- **Project State Auto-Sync**: `.plant` configurations (Sequences, Rules, Charts) now automatically synchronize between the Host desktop and remote Web Viewers over WebRTC.
- **Trigger-Based Precision Execution**: Remote browser inputs do not send raw data over the internet; they send a lightweight `0x11/0x05` trigger. The Host receives the trigger and executes the sequence locally, bypassing network latency for precise hardware timing.

### Changed
- Refactored `Workspace.tsx` connection panel to seamlessly adapt and hide desktop-specific menus when operating in Web Viewer mode.

---

## [0.5.7] - 2026-07-19

### Optimized & Fixed
- **Forced Layout Thrashing (System Freeze/Crash Fix)**: Fixed a serious layout thrashing bug inside the terminal scroll management `useLayoutEffect`. By caching `containerRect` outside the loop and checking visible items only when `autoScroll` is disabled, we eliminated up to 2,000 synchronous reflows per render cycle.
- **Log List DOM Density optimization**: Reduced DOM render capacity in the terminal viewport from 1000 to 400 entries to optimize React reconciliation performance.
- **Safety checks on payload**: Added explicit type and existence checks (`Array.isArray`) to incoming message streams to prevent app crashes from corrupt data formats.
- **High-Speed/Large Data Performance Optimization:** Pre-aggregated incoming serial/TCP/SSH log chunks before updating React state to resolve UI hang/freeze issues under high-throughput data streams.
- **Terminal Rendering Size Cap:** Enforced a maximum capacity limit of 8000 bytes per individual log entry. This splits massive continuous streams into digestible entries, preventing React from rendering massive single-node updates.
- **Port Selection Dropdown Fix:** Prevented the UI from automatically changing the port number in the dropdown if the tab is already connected.
- **Resource Busy Fix:** Added explicit port closing before opening a serial connection to release OS locks and prevent `Resource busy` errors.
- **TCP/SSH TX Display:** Fixed an issue where data sent via TCP and SSH connections was not being displayed in the terminal as TX data. The backend now correctly emits the transmit events to the frontend.

---

## [0.5.6] - 2026-07-18

### Changed
- **Project Directory Rename:** Renamed the Tauri app client directory from `docklite` to `plan-terminal` to match the official project branding.

### Fixed
- **Connection Tab State Loss:** Fixed active connection and tab states being reset or lost during tab switching and app updates.

---

## [0.5.5] - 2026-07-17

### Fixed
- **SSH Connection Argument Mismatch:** Resolved `connect_ssh missing required key user` error by aligning frontend SafeInvoke parameters (`user`, `authMode`, and `authSecret`) with Rust backend API signatures.
- **Connection Type Reset Bug:** Fixed active protocol resetting back to `Serial` whenever command sequences or reactions were updated in the sidebar, by decoupling project load triggers from active workspace config state.
- **SSH Command Execution from Library:** Auto-appended newline (`\n`) to sequences sent from the command library when connected via SSH, allowing them to execute immediately instead of remaining in the remote shell's input buffer.

---

## [0.5.4] - 2026-07-17

### Added
- **Bottom Status Bar:** Added a native status bar at the bottom showing connection state (green/red dot), protocol/parameter details, live logging/session recording state, and real-time RX/TX byte and packet counters.
- **Native Keyboard Shortcuts:** Added keyboard shortcuts for frequent actions:
  - `Ctrl + Alt + C`: Connect
  - `Ctrl + Alt + D`: Disconnect
  - `Ctrl + Alt + F` / `Ctrl + F`: Search / Find in Terminal
  - `Ctrl + Alt + K`: Clear Terminal
  - `Ctrl + Alt + L`: Toggle Live Logging options
  - `Ctrl + Alt + R`: Toggle Session Recording
- **Text Labels next to Icons**: Added text labels to main toolbar icons (Find, Clear, Chart, Log, Export).

### Changed
- **Reaction Engine Optimization:** Reordered the critical path to process zero-delay (`delay_ms == 0`) actions synchronously on the reader thread before emitting UI events and logs, minimizing latency/jitter. Applies to serial, TCP, and SSH managers.
- **Native Desktop Styling:** Redesigned the global layout with a crisp `4px` corner radius, a clean vertical border resize handle that highlights on hover, compact inputs/buttons, and flat status indicators.
- **GitHub Actions Upgrades:** Upgraded Node workflow setup to use Node.js 22 LTS, and updated checkout and setup-node actions to `v4` to address deprecation warnings.

---

## [0.5.3] - 2026-07-15

### Added
- **DNS Hostname Resolution for TCP & SSH:** Replaced literal IP parsing in the Rust backend (`tcp_manager.rs` and `ssh_manager.rs`) with standard DNS hostname resolution (`std::net::ToSocketAddrs`). Connections now support hostnames like `localhost`, `device.local`, and domain names.
- **Developer Architecture Documentation:** Created root `README.md` containing active hosting details (Render & Supabase configuration) and instructions for toggling target signaling environments.
- **Trial Documentation:** Added `trial_info.md` detailing the 30-day evaluation behavior and storage metrics. Added `.gitignore` rule to prevent committing local trial information.

### Changed
- **Local Signaling Default:** Redirected WebRTC signaling and HTTP claiming routes in frontend components (`remote_signaling.ts`, `RemoteContext.tsx`) and the Rust backend (`share_manager.rs`) to default local address `localhost:3000` to support offline development.
- **UI Version Display:** Updated the primary interface header to display the correct version (`v0.5.3`).

---

## [0.5.2] - 2026-07-11

### Changed
- **Google Cloud Run Deprecation:** Decommissioned the online Google Cloud Run `plan-signal` server (`asia-south1` region) to save cloud costs.
- **Version Bump:** Bumped version to `0.5.2` across `package.json`, `Cargo.toml`, and `tauri.conf.json`.

---

## [0.5.1] - 2026-07-09

### Added
- **Gumroad License Verification:** Added integration with Gumroad's license key verification API to allow activation of the Pro Edition.
- **Tauri Config Integration:** Updated app bundle rules for multi-platform distribution.
