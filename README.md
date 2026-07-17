# plandock (Plan Terminal)

This repository contains the Plan Terminal desktop application and its supporting signaling server.

## Deployment & Hosting Architecture

### 1. Signaling Server (`/plan-signal`)
* **Platform:** Deployed on **Render** (https://render.com).
* **Stack:** Axum (Rust framework).
* **Port:** Runs locally on port `3000` (`http://localhost:3000` / `ws://localhost:3000/ws`).
* **Google Cloud Run (Deprecated):** Previously deployed to Google Cloud Run as `plan-signal` in the `asia-south1` region (deleted on 2026-07-11).

### 2. Database & Presence Coordinator
* **Platform:** Deployed on **Supabase** (https://supabase.com).
* **Project URL:** `https://xpxzssueokeomxopzdbr.supabase.co`
* **Purpose:** Tracks device availability status (e.g. `online`, `available`, `offline`) via the `remote_devices` table.

### 3. Client Application (`/docklite`)
* **Platform:** Tauri Desktop Application (React frontend + Rust backend).
* **Target URLs Config:** To point the client application to a different signaling server (e.g. local vs Render), update the URLs in the following files:
  1. **Frontend WebSockets:** `docklite/src/utils/remote_signaling.ts`
  2. **Frontend HTTP Client:** `docklite/src/contexts/RemoteContext.tsx`
  3. **Backend Rust Client:** `docklite/src-tauri/src/share_manager.rs`

## Keyboard Shortcuts (Desktop Edition)

Plan Terminal includes native keyboard shortcuts for fast workflows:

| Action | Shortcut |
|---|---|
| **Connect** | `Ctrl + Alt + C` |
| **Disconnect** | `Ctrl + Alt + D` |
| **Find/Search in Terminal** | `Ctrl + Alt + F` (or `Ctrl + F` / `⌘ + F`) |
| **Clear Terminal** | `Ctrl + Alt + K` |
| **Toggle Live Logging** | `Ctrl + Alt + L` |
| **Toggle Session Recording** | `Ctrl + Alt + R` |
