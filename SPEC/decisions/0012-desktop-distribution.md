# ADR 0012 — Desktop distribution: signed, notarized macOS DMG

- **Date:** 2026-07-11
- **Status:** Accepted — pipeline built + empirically verified 2026-07-11
  (scripts/desktop-bundle/, apps/desktop/src-tauri/). Only the first *signed*
  build remains, gated on Jay's Apple credentials.
- **Deciders:** Jay (chose "full native app" — double-clickable, no dev
  tooling), Claude Code
- **Supersedes:** the deliberate deferral in ADR 0004, Decision 5 ("bundling,
  signing, and notarization are distribution work — revisit before any build
  leaves this machine"). This is that revisit.

## Context

Today the desktop app only runs on a dev machine: the Tauri shell
(`apps/desktop/src-tauri/src/main.rs`) spawns the **system** `node` on
`apps/web/dist/server.js`, which requires pnpm/Node tooling and a built
monorepo. `bundle.active` is `false`. For end users we need a `.app` a
non-engineer can double-click, delivered as a DMG that macOS Gatekeeper
accepts — which on current macOS means Developer ID code signing **and**
notarization by Apple.

Constraints that shape this decision:

- **Invariant 5 (no telemetry)** and **invariant 7 (networked deps need an
  ADR)** — rules out the Tauri auto-updater for now (it polls a remote
  endpoint).
- **Dependency count is a metric to minimize** — rules out packagers that add
  runtimes or toolchains (bun, yao-pkg) when a zero-new-dep path exists.
- **Native addons:** the server tree depends on `better-sqlite3` (loads its
  addon via the `bindings` package from `build/Release/better_sqlite3.node`)
  and `sodium-native` (node-gyp-build-style loader from
  `prebuilds/darwin-arm64/`). Verified in `node_modules` on this machine.
  Both loaders resolve `.node` files by walking the real filesystem — they
  break inside virtual-filesystem or single-file packagers unless patched.
  (`sqlite-vec`, when we add it, is the same shape: one more native library
  shipped on disk.)
- **Keychain:** unlock persistence shells out to `/usr/bin/security`
  (`packages/mcp-server/src/keychain.ts`), so whatever we ship must be able
  to spawn Apple's CLI tools — i.e., **no App Sandbox** (we distribute
  outside the Mac App Store, so sandbox is not required; hardened runtime
  is).

## Decision 1: Ship a real Node runtime, not a single-executable build

We considered three ways to make the Node server run without installed
tooling:

1. **Node SEA (single executable application).** Still marked *Stability:
   1.1 — Active development* in the Node docs. Native addons cannot execute
   from inside the blob: the documented pattern is to embed them as assets,
   **write them to a temp directory at runtime, and `process.dlopen()` them**
   ([Node SEA docs](https://nodejs.org/api/single-executable-applications.html)).
   Writing executable code to `os.tmpdir()` at runtime is a security
   regression for a vault product (another same-user process can race/swap
   the file, and the code executed is no longer the code sealed by the app
   signature). The alternative — ship `.node` files beside the executable —
   requires patching both addon loaders. Rejected.
2. **pkg / bun.** `vercel/pkg` is deprecated; Tauri's own Node-sidecar guide
   now points at the community fork `yao-pkg`
   ([Tauri: Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)),
   which patches `require()` with a virtual filesystem — same native-addon
   problem, plus a new build dependency. `bun build --compile` swaps the
   runtime under our crypto code and adds a dependency. Both rejected.
3. **Bundle the stock Node binary + the built server tree.** Node is already
   the decided runtime (CLAUDE.md stack). The addon loaders work unmodified
   against a real `node_modules` tree. Everything on disk is sealed by the
   `.app` code signature, so integrity is equivalent to a single executable
   — tampering with any file breaks Gatekeeper. Cost is size (~110 MB
   uncompressed for the arm64 `node` binary; the DMG compresses well —
   expect roughly 40–60 MB total, **VERIFY at first build**).

**Chosen: option 3.** Zero new npm dependencies; the only new artifact is a
pinned official Node binary fetched at build time from nodejs.org and
verified against the release `SHASUMS256.txt` (build-time download, nothing
at runtime — noted here for invariant-7 transparency).

## Decision 2: Bundle layout and process architecture

```
Northkeep.app/Contents/
  MacOS/
    northkeep-desktop            ← Tauri shell (unchanged role: dumb window)
    northkeep-server             ← renamed stock Node binary (externalBin)
  Resources/
    server/
      dist/server.js …           ← built apps/web output
      node_modules/…             ← production deps only (better-sqlite3,
                                    sodium-native prebuilds, @mcp/sdk, zod,
                                    copied @northkeep/* workspace packages)
```

- `bundle.externalBin: ["binaries/northkeep-server"]` places the Node binary
  in `Contents/MacOS/`; Tauri requires the staged file to carry a
  target-triple suffix (`northkeep-server-aarch64-apple-darwin`)
  ([Tauri: embedding external binaries](https://v2.tauri.app/develop/sidecar/)).
- `bundle.resources` maps the staged server tree into `Resources/server/`.
  The tree is produced by a production-only install of `apps/web` with its
  workspace deps (e.g. `pnpm --filter @northkeep/web deploy --prod <staging>`
  — **VERIFY** it carries each workspace package's `dist/`; fall back to a
  small staging script if not).
- **The shell keeps spawning the child itself with `std::process::Command`**
  — we do *not* adopt `tauri-plugin-shell`. The plugin's sidecar API is a
  convenience for JS-side spawning; our 70-line Rust shell only needs a
  path, and skipping the plugin avoids a new crate + capability surface. In
  release builds the shell resolves `northkeep-server` as a sibling of
  `current_exe()` and `server.js` via Tauri's resource-dir API; the existing
  dev path (system `node` + workspace `dist`) stays behind
  `cfg!(debug_assertions)`.
- **`NORTHKEEP_SERVER_JS` becomes dev-only** (compiled out of release
  builds). A signed app that will execute any script path handed to it via
  an environment variable is a mild living-off-the-land vector; nothing in
  the packaged product needs the override.

### Port/token handoff (unchanged, and still sound)

The server prints `NORTHKEEP_UI_URL=http://127.0.0.1:<port>/?token=…` on
stdout; the shell reads it over the **private parent–child pipe** — not
argv, not a file, not the environment — so no other process can observe the
token. The shell then opens the webview at that URL and the page strips the
token into `sessionStorage` exactly as in ADR 0004. Inside a bundle nothing
about this changes: loopback bind, Host-header check, constant-time token
compare, and CSP all remain the product's real security boundary; signing
adds integrity of the code, not a new trust model. Optional hardening
(follow-up, not required): have the shell inject the token via a webview
initialization script and load the bare URL, so the token never appears in
the webview's navigation history at all.

### Shutdown semantics

Today the shell `kill()`s the child (SIGKILL) on exit, which is correct as a
backstop but skips the server's `lock()` path. Packaged build: send SIGTERM
first, give the server ~2 s to run its lock/zeroization handler (to be added
— a small `process.on('SIGTERM')` in `server.ts`), then SIGKILL. Also handle
the reverse direction: if the child exits unexpectedly, show a native error
dialog and quit rather than leaving a dead window.

## Decision 3: Signing, entitlements, notarization, DMG

Per the [Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/):

- `bundle.macOS.hardenedRuntime` defaults to `true`; we set
  `signingIdentity` to the Developer ID Application identity and point
  `entitlements` at an `Entitlements.plist`.
- **Entitlements.** Node's V8 allocates executable JIT memory, which the
  hardened runtime blocks without `com.apple.security.cs.allow-jit` (and on
  some Node builds `com.apple.security.cs.allow-unsigned-executable-memory`
  — start with both, then try tightening). Tauri signs every binary in the
  bundle with the *same* entitlements file, which is fine here because we
  have no App Sandbox to conflict with. **Preferred experiment (VERIFY):**
  launch the sidecar with `node --jitless`, which makes V8 interpreter-only
  and needs *no* JIT entitlements — the tightest posture, and our loopback
  server + native crypto won't miss the JIT. If `--jitless` proves flaky,
  fall back to the allow-jit entitlements.
- **Keychain:** spawning `/usr/bin/security` needs **no entitlement** —
  keychain-access-group entitlements exist for sharing items between apps
  via the Security framework, not for exec'ing Apple's CLI. The keychain
  item's ACL names the `security` tool itself (that's who created it), and
  we keep reading it through the same tool, so existing "keep unlocked"
  items keep working. **VERIFY on the first signed build** that no keychain
  prompt appears; if one does, it's a one-time "Always Allow".
- **`.node` files must be signed.** Notarization rejects any unsigned Mach-O
  in the bundle, and Tauri's bundler signs executables/frameworks (since
  1.5) but not arbitrary Mach-O files inside `Resources/`. The build script
  therefore runs `codesign --sign "<identity>" --options runtime --timestamp`
  over every `*.node` (and the staged Node binary) in the staging directory
  **before** `tauri build`; the signatures travel with the copied files and
  the outer app signature seals them. Known failure mode if skipped:
  [tauri#11992](https://github.com/tauri-apps/tauri/issues/11992) (externalBin
  + notarization failures, unresolved upstream as filed) — our contingency
  if externalBin signing misbehaves is to place the Node binary via
  `bundle.macOS.files` under `Contents/Helpers/` and sign it ourselves.
- **Notarization** is automatic once the env vars are present: either
  `APPLE_ID` + `APPLE_PASSWORD` (app-specific password) + `APPLE_TEAM_ID`,
  or an App Store Connect API key (`APPLE_API_ISSUER` / `APPLE_API_KEY` /
  `APPLE_API_KEY_PATH`). Tauri submits via `notarytool` and staples.
  **VERIFY** that the DMG (not just the .app) ends up notarized/stapled; if
  Tauri only staples the .app, add one manual
  `xcrun notarytool submit … && xcrun stapler staple` step for the DMG.
  Note for the record: notarization uploads the binaries to Apple at *build*
  time; and Gatekeeper's runtime notarization check is OS behavior, not
  ours — neither violates invariant 5, but we say it out loud.
- **DMG:** `tauri build --bundles app,dmg` produces both. Tauri's DMG step
  drives Finder via AppleScript for window layout — it can prompt for
  Accessibility permission the first time on a fresh machine; fine for
  local builds, a known quirk for CI later.
- **Targets:** `aarch64-apple-darwin` only for the first release (Jay's and
  every 2021+ Mac). Intel/universal (`lipo` of two Node binaries + two Rust
  builds) is deliberately deferred. `minimumSystemVersion` must be raised
  from Tauri's 10.13 default to what the pinned Node 24 build supports
  (macOS 11+ for arm64 — **VERIFY exact floor** for the pinned version).

## Decision 4: No auto-update (for now)

The Tauri updater plugin polls a release endpoint from every user's machine
— a phone-home and a new networked dependency, squarely inside invariants 5
and 7. **We ship without any updater.** Updates are manual: download the new
DMG, drag to Applications. The app's About view shows the version so users
can compare against the release page. If manual updates prove too painful,
a future ADR can propose a *user-initiated* "check for updates" (explicit
click, no background polling) with its network access spelled out — that is
explicitly out of scope here.

## What Jay must provide / do (one-time, ~1–2 hours + Apple wait time)

1. **Enroll in the Apple Developer Program** — $99/yr at
   [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/).
   Enroll as an **individual** (fast, ships under "Jason Silva") or as an
   organization (Silva Peak Enterprises LLC — requires a D-U-N-S number and
   days-to-weeks of verification; the app would show the LLC name). Individual
   is the pragmatic start; you can migrate later. Approval is usually <48 h.
2. **Create a "Developer ID Application" certificate.** Easiest path: open
   Xcode → Settings → Accounts → add your Apple ID → *Manage Certificates* →
   "+" → **Developer ID Application**. (Only the account holder can create
   this cert type.) Alternatively via developer.apple.com/account with a CSR
   from Keychain Access. It lands in your login Keychain; we'll read its
   identity string (looks like
   `Developer ID Application: Jason Silva (TEAMID1234)`).
3. **Create an app-specific password** for notarization: sign in at
   [account.apple.com](https://account.apple.com) → Sign-In and Security →
   App-Specific Passwords → generate one named e.g. `northkeep-notary`.
   (Alternative: an App Store Connect API key — slightly nicer for CI later;
   either works.)
4. **Note your Team ID** — shown on the developer account Membership page.
5. Hand the three values (signing identity, Apple ID + app-specific
   password, Team ID) to the build **as environment variables only** — never
   committed, never in chat logs, per the global secrets rule.

## Consequences & honest limits

- **Size:** the DMG grows from "tiny Rust shell" to an estimated 40–60 MB
  because it carries a full Node runtime. Accepted cost of the zero-new-deps
  path.
- **We become a runtime redistributor.** Node security releases now obligate
  a Northkeep re-release. Pin the version in one place in the build script;
  check it at each Friday tag.
- **Apple in the loop:** signing ties releases to Apple credentials; a
  revoked/expired cert (yearly-ish maintenance) blocks new builds — existing
  installs keep working. Notarization adds minutes and an upload to Apple
  per release.
- **arm64 only** at first; Intel Mac users are unserved until the universal
  build task.
- **No auto-update** means users on old builds stay on old builds until they
  act. That is the deliberate privacy trade; KNOWN-LIMITS.md should say so.
- **Ollama is still separate.** Tier-2 redaction/extraction requires the
  user to install Ollama themselves; the GUI already degrades loudly
  (invariant 6). Bundling Ollama is out of scope.
- **First-launch friction remains:** Gatekeeper still shows the standard
  "downloaded from the internet" confirmation even for notarized apps.
- **Unverified items are marked VERIFY above**; the first signed build is
  the acceptance test for all of them.

## Implementation tasks

1. `apps/web`: add SIGTERM handler that runs the session `lock()` path, then
   exits (with test).
2. Build script (`apps/desktop/scripts/stage.mjs` or similar): fetch pinned
   Node from nodejs.org + verify SHASUMS256; stage production server tree
   (pnpm deploy or equivalent); rename Node binary with target-triple
   suffix; `codesign --options runtime --timestamp` all `*.node` files and
   the Node binary.
3. `main.rs`: release-mode path resolution (sibling `northkeep-server`,
   resource-dir `server/dist/server.js`); gate `NORTHKEEP_SERVER_JS` and the
   system-node path behind `cfg!(debug_assertions)`; SIGTERM-then-SIGKILL
   shutdown; child-death error dialog. Try `--jitless` spawn first.
4. `tauri.conf.json`: `bundle.active: true`, targets `["app","dmg"]`,
   `externalBin`, `resources`, `macOS.{signingIdentity via env, entitlements,
   minimumSystemVersion}`; add `Entitlements.plist`.
5. Real app icon (current icons are Tauri defaults).
6. Jay completes the Apple checklist above; first signed+notarized build on
   his machine; acceptance test: copy the DMG to a second Mac (or a fresh
   account), double-click, open app, unlock vault, confirm no Gatekeeper
   block, no keychain prompt regression, Activity Monitor shows
   `northkeep-server` exiting when the window closes.
7. Update KNOWN-LIMITS.md (manual updates, arm64-only) and ADR 0004's
   Decision 5 pointer to this ADR.
8. Adversarial review pass per house rules (key handling is untouched, but
   the spawn-path and env-gating changes deserve eyes).

## Dependencies introduced

- **Runtime npm deps: zero.**
- **Bundled artifact:** pinned official Node binary (checksum-verified at
  build time; nodejs.org download happens on the build machine only).
- **Services:** Apple Developer Program (signing/notarization at build
  time). No new network access in the shipped product: the loopback listener
  of ADR 0004, nothing outbound.

## Implementation notes (2026-07-11 — first build of the pipeline)

The build pipeline now exists (`scripts/desktop-bundle/`, see its README) and
produced a working unsigned `.app` + DMG on this machine. Results for the
items marked **VERIFY** above, plus deviations:

- **`--jitless` is rejected** (Decision 3's preferred experiment). Verified
  on Node v24.14.0/darwin-arm64: `--jitless` removes `WebAssembly` entirely,
  and Node's global `fetch()` (undici) parses HTTP with WASM llhttp — so
  every `fetch()` throws (`WebAssembly is not defined`), the Ollama
  availability probe returns `false`, and Tier-2 redaction silently degrades
  even with Ollama running: an invariant-6 violation, not mere flakiness.
  Vault crypto (sodium-native) and better-sqlite3 were unaffected, and vault
  create/unlock latency was identical (~0.85 s) with and without the flag —
  the JIT buys us nothing, but WASM loss disqualifies. **We ship with the
  allow-jit entitlements** (`apps/desktop/src-tauri/entitlements.plist`);
  the no-JIT variant is preserved as `entitlements-jitless.plist` for the
  day `packages/librarian` talks to Ollama over `node:http` instead of
  `fetch()` — that change would make the tighter posture viable.
- **`pnpm deploy` carries workspace `dist/`** — confirmed with pnpm 11.9.0
  using `pnpm --filter @northkeep/web deploy --prod --legacy
  --config.node-linker=hoisted` (hoisted so the tree is real files, not the
  pnpm symlink store; `--legacy` because the workspace doesn't set
  `inject-workspace-packages`). The ADR's fallback staging script was not
  needed. One found footgun: a filtered `--prod` deploy rewrites the root
  `node_modules/.pnpm-workspace-state-v1.json` (records `dev:false`), after
  which every `pnpm run` tries to purge and reinstall `--production`;
  `stage-server.sh` snapshots and restores that file around the deploy.
- **`minimumSystemVersion` is 13.5**, not the guessed "11+": the official
  Node 24 darwin-arm64 binary declares `LC_BUILD_VERSION minos 13.5`.
  Set in `tauri.bundle.conf.json`; Info.plist confirmed.
- **Size:** unsigned DMG is **49 MB** (inside the 40–60 MB estimate);
  `.app` is 174 MB uncompressed (Node binary 110 MB + 55 MB server tree
  after pruning foreign-platform sodium prebuilds).
- **Bundle config is an overlay** (`tauri.bundle.conf.json`, merged via
  `tauri build --config`) rather than edits to `tauri.conf.json`: tauri-build
  stages `externalBin` at compile time and fails when the sidecar file is
  missing, so keeping it out of the base config preserves `pnpm tauri dev`
  on a fresh checkout. Signing identity and notarization credentials come
  from the environment only (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`/
  `APPLE_PASSWORD`/`APPLE_TEAM_ID`); nothing credential-shaped is in any
  config file.
- **Shell changes landed as decided:** release builds resolve the sidecar as
  a sibling of `current_exe()` and `server/dist/server.js` via the resource
  dir; `NORTHKEEP_SERVER_JS` and the system-node path are compiled out of
  release (`cfg(debug_assertions)`); shutdown is SIGTERM, 2 s grace, then
  SIGKILL (one new Rust dep: `libc`, already in tauri's tree); a child-death
  watcher shows a native alert via `/usr/bin/osascript` (30 s auto-dismiss)
  and exits — no dialog plugin added. Verified on the built app: graceful
  quit kills the sidecar; killing the sidecar raises the alert and quits the
  shell. Caveat: SIGKILL/SIGTERM of the *shell itself* bypasses Tauri's exit
  event and orphans the sidecar — same as the pre-bundle behavior; the
  normal quit paths (⌘Q, window close) are covered.
- **The nodejs.org binary arrives already signed** (Node.js Foundation
  Developer ID, hardened-runtime flag set); `presign.sh` re-signs it with
  our identity so the bundle chains to one Developer ID.
- **Still open, needs the signed build** (Jay's Apple checklist): keychain
  prompt regression, notarization of externalBin (tauri#11992 contingency),
  whether Tauri staples the DMG or only the .app. Also still to do from the
  task list: the real app icon (task 5), KNOWN-LIMITS.md updates (task 7),
  and the adversarial review pass (task 8).
- **Task 1 (SIGTERM `lock()` handler) is DONE** (2026-07-11): the direct-run
  block in `apps/web/src/server.ts` now traps SIGTERM/SIGINT and runs
  `running.close()` → `session.lock()` (zeroizes the master key) → exit,
  idempotent-guarded against the SIGTERM→SIGKILL race. Verified: the server
  exits cleanly on SIGTERM instead of dying with the key resident.

## Sources

- Tauri v2 — embedding external binaries: https://v2.tauri.app/develop/sidecar/
- Tauri v2 — macOS code signing & notarization: https://v2.tauri.app/distribute/sign/macos/
- Tauri v2 — config reference (bundle.macOS, dmg, resources): https://v2.tauri.app/reference/config/
- Tauri v2 — Node.js as a sidecar (yao-pkg guide we rejected): https://v2.tauri.app/learn/sidecar-nodejs/
- Node.js — single executable applications (addon/temp-dir limitation): https://nodejs.org/api/single-executable-applications.html
- tauri-apps/tauri#11992 — externalBin notarization failures: https://github.com/tauri-apps/tauri/issues/11992
- Local verification: addon loader mechanics read from this repo's
  `node_modules` (better-sqlite3 `bindings` call; sodium-native
  `prebuilds/darwin-arm64`).
