# ADR 0004: Local GUI: loopback web app + Tauri shell

Status: Accepted 2026-07-05 (Jay chose desktop now over the blueprint's deferral) · Review: 2026-07-05, no critical or high findings; fixes applied

## Context
Most people won't operate a CLI. The GUI must not weaken the vault: a local HTTP server holding plaintext would otherwise be readable by any process or malicious website on the machine.

## Decision
- D1: One UI, two shells. All product logic lives in `apps/web`: a loopback HTTP server (Node built-ins only) plus one vanilla HTML/JS page, no build step or framework. `northkeep ui` opens it in a browser; `apps/desktop` is a ~70-line Tauri shell that spawns the same server, reads its announced URL and wraps it in a native window.
- D2: Loopback hardening. Binds 127.0.0.1 on a random port. A per-session bearer token (32 random bytes) is delivered once in the opening URL; every `/api` call needs it (`X-NorthKeep-Token`, constant-time compare). A non-loopback Host header gets 403 (DNS rebinding). Strict CSP (`default-src 'none'`, inline-only script/style, `connect-src 'self'`), no CORS headers, `Cache-Control: no-store`. The bare page carries no data and is served without the token.
- D3: Unlock over loopback. POST `/api/unlock` carries the passphrase one hop to the same-user process, equivalent trust to typing it into Terminal. The derived key is held in server memory, zeroed on lock or exit; "keep unlocked on this Mac" writes it to the Keychain via the ADR 0002 path. The Tauri shell kills the server on window close.
- D4: Import uploads touch disk briefly. The uploaded export is written to `NORTHKEEP_HOME/.upload-<uuid>` (0600, inside the 0700 dir) only as long as the `unzip -p` parsers need, then deleted (test-asserted). Candidates then live in server memory only.
- D5: Tauri dev posture. The shell spawns the system `node` (override: `NORTHKEEP_SERVER_JS`). Bundling (`bundle.active: false`), icons, Node-sidecar packaging, signing and notarization are deferred; revisit before any build leaves this machine.

## Consequences
- Easier: non-CLI users get the vault; view-source is the UI security review.
- Harder: review fixes must hold: `/api/lock` reports the true post-lock state and an explicit lock works even when an env var grants access (shown as an "env override" pill); import jobs TTL-evict and delete on commit; the wrong-passphrase path zeros its key.
- Limits: the source ZIP already sits unencrypted in Downloads, so D4 adds no new exposure class, but plaintext does touch disk briefly.

## Rejected
- Vault logic in Tauri/Rust: would fork the crypto surface.
- A framework frontend: build chain and dependency surface for a 3-view browser.

## What leaves the machine
The original has no egress section. Its dependency note states the network access is the loopback listener above, nothing outbound. Dependencies: `@tauri-apps/cli` (dev-only) and crates `tauri`/`tauri-build`; the web server adds zero npm dependencies.

## Links
Extends: ADR 0002 (Keychain path)
Full record: docs/design/adr-0004-local-gui.md
