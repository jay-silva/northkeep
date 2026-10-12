# Desktop bundle pipeline (ADR 0012, ADR 0064)

Builds the distributable desktop app: a Tauri shell, a pinned Node runtime
as sidecar, and the production server tree.

- macOS: `NorthKeep.app` + DMG. arm64 (Apple Silicon) only; requires macOS 13.5+ at runtime. Signing and notarization are unchanged.
- Linux x64: unsigned AppImage and `.deb`. Not a public release. Built on Ubuntu 22.04 in CI so the bundles link glibc 2.35.

## The scripts

| Script | What it does |
| --- | --- |
| `build.sh` | Orchestrates everything below, then runs `tauri build`. This is the only command you normally run. |
| `fetch-node.sh` | Downloads the pinned Node (see `NODE_VERSION` inside, the single place the version is pinned), verifies SHA-256 against nodejs.org's `SHASUMS256.txt` on every run, and extracts `node` to `binaries/northkeep-server-<target-triple>` (`aarch64-apple-darwin` or `x86_64-unknown-linux-gnu`). Tarballs are cached in `apps/desktop/.node-cache/`. |
| `stage-server.sh` | Assembles the self-contained server tree at `apps/desktop/src-tauri/server-tree/` via shared-lockfile `pnpm deploy --prod` with command-local workspace injection and hoisted linking (real files, no symlinks, native prebuilds on disk), prunes foreign-platform prebuilds and `.bin`, and verifies the essentials. Missing lockfiles are refused. Legacy deployment is disabled because it can resolve untested dependency versions. |
| `presign.sh` | With `APPLE_SIGNING_IDENTITY` set: codesigns every `*.node` addon and the Node sidecar (`--options runtime --timestamp`) before Tauri bundles them — notarization rejects unsigned Mach-Os in Resources. Skips gracefully when unset. |

Bundle configuration is merged via `tauri build --config`. macOS uses
`tauri.bundle.conf.json` (`app` and `dmg`). Linux uses
`tauri.linux.bundle.conf.json` (`appimage` and `deb`). That Linux file is
deliberately not named `tauri.linux.conf.json`: Tauri would auto-merge that
name into `tauri dev`. `tauri.conf.json` stays dev-clean, so `pnpm tauri dev`
keeps working without the sidecar staged.

Prerequisites: pnpm, the Rust toolchain (`rustup`), `curl`. Linux also needs
the Tauri webkit packages (`libwebkit2gtk-4.1-dev` and the related libraries
listed in `.github/workflows/desktop-linux.yml`). Nothing else.

## (a) Unsigned local test build

```sh
scripts/desktop-bundle/build.sh                # .app + .dmg
scripts/desktop-bundle/build.sh --bundles app  # .app only (faster)
```

Artifacts:

- `apps/desktop/src-tauri/target/release/bundle/macos/NorthKeep.app`
- `apps/desktop/src-tauri/target/release/bundle/dmg/NorthKeep_<ver>_aarch64.dmg`

The unsigned app runs fine on the build machine. On any *other* machine
Gatekeeper will refuse it — that is what signing + notarization is for.

Quick smoke test:

```sh
open apps/desktop/src-tauri/target/release/bundle/macos/NorthKeep.app
# window opens, vault UI loads; on quit, `pgrep northkeep-server` is empty
```

## (a2) Unsigned Linux build

On x86_64 Linux:

```sh
scripts/desktop-bundle/build.sh
```

Artifacts:

- `apps/desktop/src-tauri/target/release/bundle/appimage/NorthKeep_<ver>_amd64.AppImage`
- `apps/desktop/src-tauri/target/release/bundle/deb/NorthKeep_<ver>_amd64.deb`

These are unsigned. They are for local and CI use, not a public release.
GitHub Actions (Ubuntu 22.04) builds them on pull requests that touch the
desktop app, the server it bundles, or this pipeline, and on manual dispatch.
The workflow uploads both files as artifacts.

### Linux runtime libraries

The `.deb` `Depends` line, and an AppImage on a machine that does not already
have them, needs:

- `libegl1`
- `libwebkit2gtk-4.1-0`
- `libgtk-3-0`
- `librsvg2-2`

`tauri.linux.bundle.conf.json` lists `libegl1` and `librsvg2-2`. Tauri's
bundler always appends `libwebkit2gtk-4.1-0` and `libgtk-3-0`, so the
package control file names all four once.

```sh
sudo apt-get install -y libegl1 libwebkit2gtk-4.1-0 libgtk-3-0 librsvg2-2
```

Those are runtime packages. Building still needs the `-dev` packages listed
in `.github/workflows/desktop-linux.yml`.

### Where the vault is written

The desktop shell forwards `NORTHKEEP_HOME` to the bundled server. When that
variable is set, `vault.nkv`, `device.secret`, and `master.key` are written
only under that directory. Launch itself writes none of them, so the directory
stays empty until you create a vault. Parking the key (`master.key`) happens
later, when you keep the vault unlocked and the Secret Service is not available.

## (b) Signed + notarized release build

One-time Apple setup is in ADR 0012 ("What Jay must provide"). Then export —
in your shell only, never committed, never pasted into logs:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<TEAMID>)"
export APPLE_ID="<apple-id email>"
export APPLE_PASSWORD="<app-specific password>"   # not your Apple ID password
export APPLE_TEAM_ID="<TEAMID>"

scripts/desktop-bundle/build.sh
```

- `APPLE_SIGNING_IDENTITY` drives both `presign.sh` and Tauri's own signing
  (Tauri reads it from the environment; it is deliberately not in any config
  file). Find the exact string with:
  `security find-identity -v -p codesigning | grep "Developer ID Application"`
- The three `APPLE_*` notarization vars make Tauri submit to Apple via
  `notarytool` and staple automatically. Alternative (nicer for CI later):
  `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` instead of the
  Apple ID trio.
- Notarization uploads the app to Apple and usually takes a few minutes.

After the first signed build, verify (these are ADR 0012's acceptance items):

```sh
spctl -a -vv apps/desktop/src-tauri/target/release/bundle/macos/NorthKeep.app
xcrun stapler validate apps/desktop/src-tauri/target/release/bundle/dmg/NorthKeep_*.dmg
# if the DMG itself is not stapled (only the .app), staple it manually:
#   xcrun notarytool submit <dmg> --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
#   xcrun stapler staple <dmg>
```

Then the real acceptance test: copy the DMG to a second Mac (or fresh user
account), double-click, open, create/unlock a vault — no Gatekeeper block, no
keychain prompt regression, and `northkeep-server` exits when the window
closes.

## Updating the pinned Node

Node security releases obligate a NorthKeep re-release (ADR 0012). Bump
`NODE_VERSION` in `fetch-node.sh`, rebuild, done — the checksum verification
picks up the new release's SHASUMS automatically. Check the pin at each
Friday tag.

## Known quirks

- Tauri's DMG step drives Finder via AppleScript; on a fresh machine it can
  prompt once for Accessibility/Automation permission.
- Run `build.sh`, not raw `pnpm tauri build`: the wrapper stages the sidecar
  and server tree first and passes the bundle config overlay. (Plain
  `pnpm tauri build` still works but produces the old unbundled binary.)
- Entitlements: the bundle signs with JIT allowed (`entitlements.plist`).
  The tighter no-JIT posture was tested and shelved — V8's jitless mode
  removes WebAssembly, which breaks Node's `fetch()` and thereby the Ollama
  probe (invariant 6). Details in `entitlements-jitless.plist` and ADR 0012.
