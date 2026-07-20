# Changelog

All notable changes to the **Plan Terminal** project will be documented in this file.

---

## [Unreleased]

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
