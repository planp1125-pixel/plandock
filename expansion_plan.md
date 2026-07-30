# Remote Connection Reliability — Expansion Plan

Status as of 2026-07-30 · v0.5.31

This document picks up where a debugging/planning session left off. It's written so
work can continue from a different machine with no prior context beyond this file
and the repo history.

---

## 1. What's already fixed (v0.5.31, on `main`)

Two confirmed bugs were found and fixed:

1. **Host UI hijacked to a bogus tab on Accept** — `plan-terminal/src/App.tsx`.
   The generic `"serial-bridge"` WebRTC control channel matched a prefix check
   (`label.startsWith('serial-')`) meant only for per-port mirror channels, so every
   accepted connection spawned a fake `Remote: serial (...)` tab and switched to it,
   discarding whatever tab the host was actually on. Fixed by excluding the literal
   `"serial-bridge"` label from that branch. **Shipped** in commit `67e01e6`, pushed
   to `origin/main`.

2. **Signal-relay session race on reconnect** — `plan-signal/src/main.rs`.
   When a device's WebSocket reconnects after a network blip, the *old* socket's
   delayed cleanup could unconditionally delete the *new* live session from the
   server's session map, silently marking the device offline and dropping any
   connection request sent to it afterward. Fixed by only letting a socket's cleanup
   remove the session if it still owns the current map entry
   (`Sender::same_channel`).
   **⚠️ NOT YET DEPLOYED.** This fix is committed locally in the `plan-signal` repo
   (commit `fb0d014`, on top of `c0ad2dc`) but **not pushed** — pushing from the
   original machine failed because that repo's `origin` remote has no stored
   GitHub credentials and no credential helper was configured there. To finish
   this:
   ```
   cd plan-signal
   git push origin main
   ```
   Then confirm Render (or wherever `plan-signal.onrender.com` is hosted) redeploys
   from the new commit — the fix has zero effect until the live server is rebuilt.

   Note: that repo also has **other pre-existing staged/uncommitted changes**
   (`Dockerfile` switched to copying a prebuilt `plan-signal-bin` instead of
   building in-container, plus a `machine_id` column/dedup migration in `src/db.rs`).
   Those were left alone — untouched, still staged — because it wasn't clear if they
   were finished/tested. Review them before pushing anything further.

---

## 2. Known follow-up bug (not yet fixed)

**Switching the shared tab leaks the previous one's data to the peer.**
`plan-terminal/src-tauri/src/share_manager.rs`, `share_active_tab()` (~line 74).
Every call registers a new `serial-data` forwarding listener via `ctx.app.listen(...)`
but never removes the previous one. So if the host shares Tab A, then later clicks
Share on Tab B, Tab A's output keeps being forwarded too — both tabs' data ends up
interleaved on the single connection, since the peer only has one "remote" view and
packets carry no per-tab framing. Fix direction: track and call the returned
`unlisten` handle from the previous `share_active_tab` call before registering a new
one (or key listeners by peer and replace instead of accumulate).

---

## 3. Main open item: no TURN server (this is the current focus)

### The problem

Both WebRTC peer connections only configure **STUN**, never **TURN**:

- `plan-terminal/src/utils/remote_signaling.ts` (~line 94–99, `initPeerConnection()`)
- `plan-terminal/src-tauri/src/share_manager.rs` (~line 1165–1172, `create_webrtc_config()`)

```ts
// remote_signaling.ts
const config: RTCConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ]
};
```

```rust
// share_manager.rs
fn create_webrtc_config() -> RTCConfiguration {
    RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            ..Default::default()
        }],
        ..Default::default()
    }
}
```

STUN alone only helps two peers attempt a **direct** connection. It fails outright
(not degraded — completely fails, with the current code giving zero user-facing
error) whenever either side is behind:

- **Symmetric NAT** (many ISP routers, mobile carriers, enterprise firewalls) —
  the external port STUN observes isn't the one that'll actually be used.
- **CGNAT** (mobile data, some ISPs) — no way to reach a specific device inbound
  at all.
- **Corporate firewalls / some public Wi-Fi** — outbound UDP is often blocked or
  restricted.
- **Double-NAT home setups.**

Rough industry rule of thumb: pure STUN/P2P succeeds ~80–90% of the time for
arbitrary internet-to-internet connections. Remote-access tools skew worse than
that average, since the use case disproportionately involves someone on a
corporate network or mobile hotspot reaching a home machine. Confirmed
symptom in testing: signaling (offer/answer relay) succeeds reliably, but the
web viewer stays stuck on "Requesting Connection..." forever because the P2P
data channel never opens — and the host side shows no error because
`share_manager.rs` marks the peer "connected" the instant the data channel
object is *created*, not when it actually finishes opening (~line 645–649),
so the host UI isn't proof the link succeeded.

### The plan

Add a TURN server as a **fallback**, keeping the existing STUN servers. WebRTC
tries the direct STUN-based path first automatically; TURN (and its bandwidth
cost) is only used for the subset of connections that can't establish P2P
directly. This is standard practice, not a workaround.

**Decision (given budget/hardware constraints — no self-hosting for now):**
use a free-tier hosted TURN provider. Recommended: **Metered.ca** (free tier,
no credit card required to start, simple dashboard for generating
`turn:`/`turns:` credentials). Reasonable alternatives if that doesn't pan out:
Cloudflare Calls, Twilio Network Traversal Service, Xirsys — all require adding
a payment method upfront, which is why Metered.ca was preferred.

Revisit later: once there's real usage/revenue, either upgrade the same
provider's paid tier or move to self-hosted `coturn` on a VPS (needs UDP 3478 +
a relay port range like 49152–65535 open — not compatible with a plain PaaS web
service like Render's standard tier, needs a real VPS with full port control).
Not a decision needed today.

### Steps to finish this from the new machine

1. **Sign up** at Metered.ca (or chosen provider) and generate TURN credentials
   from their dashboard. You'll get something like:
   - TURN URL(s), e.g. `turn:relay.metered.ca:80` and `turns:relay.metered.ca:443`
   - `username` and `credential` (password)

2. **Hand the credentials to whoever is continuing this work** (paste them in,
   or store as env vars / secrets — do not commit them in plaintext to the repo).

3. **Wire them into both places:**

   `plan-terminal/src/utils/remote_signaling.ts`:
   ```ts
   const config: RTCConfiguration = {
       iceServers: [
           { urls: 'stun:stun.l.google.com:19302' },
           { urls: 'stun:stun1.l.google.com:19302' },
           {
               urls: ['turn:relay.metered.ca:80', 'turns:relay.metered.ca:443'],
               username: '<TURN_USERNAME>',
               credential: '<TURN_CREDENTIAL>',
           },
       ]
   };
   ```

   `plan-terminal/src-tauri/src/share_manager.rs`:
   ```rust
   fn create_webrtc_config() -> RTCConfiguration {
       RTCConfiguration {
           ice_servers: vec![
               RTCIceServer {
                   urls: vec!["stun:stun.l.google.com:19302".to_string()],
                   ..Default::default()
               },
               RTCIceServer {
                   urls: vec![
                       "turn:relay.metered.ca:80".to_string(),
                       "turns:relay.metered.ca:443".to_string(),
                   ],
                   username: "<TURN_USERNAME>".to_string(),
                   credential: "<TURN_CREDENTIAL>".to_string(),
                   ..Default::default()
               },
           ],
           ..Default::default()
       }
   }
   ```

   Avoid hardcoding real credentials directly in source if they're long-lived —
   prefer env vars / a config fetch, especially on the Rust/desktop side where the
   binary is distributed to end users and could be reverse-engineered for the
   credential. (Many TURN providers support short-lived, per-session credentials
   fetched from an API at connect time instead of static ones — worth checking
   Metered.ca's docs for this before hardcoding.)

4. **Add ICE connection-state diagnostics** while in this code, since failures are
   currently silent. Add `oniceconnectionstatechange` (TS side) and the Rust
   equivalent (`on_peer_connection_state_change` / `on_ice_connection_state_change`
   on `RTCPeerConnection`) with console/log output, so a stuck connection shows
   *why* instead of hanging on "Requesting Connection..." with no explanation.
   Consider surfacing a timeout + error message in the UI too
   (`Workspace.tsx` ~line 2168–2193, the "Connect to Host" button/overlay).

5. **Test across two genuinely different networks** (e.g. phone hotspot ↔ home
   Wi-Fi) to confirm the previously-stuck case now completes via TURN relay.

---

## 4. Other flagged item (unrelated, security hygiene)

`origin` for the main `plan-terminal`/`plandock` repo has a GitHub personal
access token embedded directly in the remote URL (`git remote -v`), which is
how pushes succeeded during this session. Worth rotating that token and
switching to a credential helper or SSH key instead of a URL-embedded PAT,
since it's stored in plaintext in `.git/config`.
