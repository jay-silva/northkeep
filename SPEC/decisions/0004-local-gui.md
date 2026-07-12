# ADR 0004 — Local GUI: loopback web app + Tauri shell

- **Date:** 2026-07-05
- **Status:** Accepted
- **Deciders:** Jay (chose desktop-now over the blueprint's post-validation
  deferral; approved the plan), Claude Code

## Context

Most people won't operate a CLI. The GUI must not weaken the vault: a local
HTTP server holding plaintext would otherwise be readable by any process or
malicious website on the machine.

## Decision 1: One UI, two shells

All product logic lives in `apps/web` — a loopback HTTP server (Node
built-ins only) plus a single-file vanilla HTML/JS page (no build step, no
frameworks: view-source is the security review). `northkeep ui` opens it in
a browser; `apps/desktop` is a ~70-line Tauri shell that spawns the same
server, reads its announced URL, and wraps it in a native window. Rejected:
implementing vault logic in Tauri/Rust (would fork the crypto surface) or a
framework frontend (build chain + dependency surface for a 3-view browser).

## Decision 2: Loopback server hardening

- Binds 127.0.0.1, random port.
- Per-session bearer token (32 random bytes) delivered once in the opening
  URL; every `/api` call needs it (`X-NorthKeep-Token`, constant-time
  compare). The page strips the token from the URL bar and keeps it in
  sessionStorage.
- Host-header must be loopback → DNS-rebinding attempts get 403.
- Strict CSP (`default-src 'none'` + inline-only script/style,
  `connect-src 'self'`), no CORS headers, `Cache-Control: no-store`.
- The bare page is served without the token (it contains no data); all data
  flows through the tokened API.

## Decision 3: Unlock over loopback

POST `/api/unlock` carries the passphrase one hop across loopback to the
same-user process — equivalent trust to typing it into Terminal. The derived
key is held in server memory (zeroed on lock/exit); "keep unlocked on this
Mac" writes the derived key to the Keychain via the existing ADR-0002 path.
The Tauri shell kills the server on window close, taking the held key with
it.

## Decision 4: Import uploads touch disk briefly

Browsers can't hand over file paths, so the uploaded export is written to
`NORTHKEEP_HOME/.upload-<uuid>` (0600, inside the 0700 dir) exactly as long
as the existing `unzip -p` parsers need, then deleted (test-asserted). The
source ZIP already sits unencrypted in the user's Downloads, so this adds no
new exposure class. Candidates then live in server memory only; commit is
the same short locked write as the CLI's 4-phase import.

## Decision 5: Tauri dev posture

Rust shell compiles on the dev machine and spawns the system `node` (path
override: `NORTHKEEP_SERVER_JS`). Bundling (`bundle.active: false` for now),
icons/branding, Node-sidecar packaging, signing, and notarization
(Apple Developer, $99/yr) are distribution work, deliberately deferred —
revisit before any build leaves this machine.

## Adversarial review (2026-07-05)

Reviewed with this milestone. Positive assurance: token auth (constant-time,
no pre-auth data route, token never in the served page), loopback bind +
host-header rebinding defense, CSRF posture (token + no CORS + `form-action
'none'`), key-buffer hygiene (fresh buffer per `resolveMasterKey`, copied
before `openWithKey` consumes it), XSS escaping of all stored fields, and the
temp-upload lifecycle (parsers read eagerly; `finally` delete can't race the
async extraction; filename sanitized; 0600 under 0700). No critical/high
findings. Fixed from the review: `/api/lock` now reports the true post-lock
state and an explicit-lock flag makes it effective even when an env var
grants access (previously a silent no-op) — surfaced in the UI as an "env
override" pill and a lock warning; import jobs TTL-evict and delete on commit
so extracted plaintext doesn't linger; the wrong-passphrase derive path zeros
its key; `type`/`id` fields escaped for defense-in-depth. New e2e test covers
the env-grant lock case.

## Dependencies introduced

`@tauri-apps/cli` (dev-only, prebuilt), crates `tauri`/`tauri-build`
(the decided shell framework). The web server itself adds zero npm
dependencies. Network access: the loopback listener described above; nothing
outbound.
