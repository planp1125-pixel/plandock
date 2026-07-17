# Changelog

All notable changes to the **Plan Terminal** project will be documented in this file.

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
