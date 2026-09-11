# NorthKeep 0.22.0 build preparation

Rules version: 2026-09-07.1. Date: 2026-09-11.

The owner selected both platforms. Mac includes the accepted Memories and Projects interface. iPhone retains its existing interface and receives the shared-code changes. Mac Tauri and web update-check versions are 0.22.0. iPhone is 0.22.0, build 27.

## Packaging correction

The first isolated production staging attempt exposed dependency drift: `pnpm deploy --legacy` ignored the workspace lockfile and attempted jose 6.2.11, while the reviewed lockfile pins 6.2.3. The build stopped before downloading it.

`stage-server.sh` now requires a lockfile and forces shared-lockfile deployment with command-local workspace injection and hoisted linking. pnpm 11.9.0 creates a deployment-specific lockfile and installs with `frozenLockfile: true`. The existing workspace configuration and root lockfile stay unchanged. An independent reviewer checked the local pnpm implementation and confirmed conversion of existing workspace links to copied packages.

Verification of the corrected staging:

- Offline deployment completed from the existing package cache.
- All 157 staged third-party package versions occur in the reviewed lockfile; jose is 6.2.3.
- All nine expected NorthKeep workspace packages include compiled entry points.
- Stage checks passed: 77 MB, no surviving symlinks, two macOS arm64 native addons.
- The pinned Node 24.14.0 archive passed SHA-256 and GPG verification against a pinned release key.
- Under the bundled Node runtime, SQLite worked in memory and sodium generated random bytes. The staged UI returned HTTP 200; the API rejected an unauthenticated request with HTTP 401. No real vault or model call was used.
- Root pnpm and Cargo lockfiles remained unchanged; shell syntax and diff checks passed.

## Platform checks

Mac workspace compilation and Tauri optimized native compilation passed in an isolated worktree with empty HOME and keychain access disabled. The generated app Info.plist reports 0.22.0 and the executable is arm64. This local build has an ad hoc linker signature, no Developer ID signature or notarization, and is not a public release artifact. Native GUI launch and second-Mac Gatekeeper acceptance are still required on the signed artifact.

For the updated iPhone metadata, TypeScript and offline iOS Metro export passed: 1,567 modules, 42 assets, 7.6 MB Hermes bundle. Public Expo config resolves to version 0.22.0 and build 27. EAS account ownership was checked read-only. No native source or dependency changes were introduced in this build preparation, so no CocoaPods compile was added. Metro reported one skipped temporary Rust compiler path while the Mac compiler was running; export completed successfully.

The previously completed product regression evidence remains 1,578 tests passed, one skipped, plus 12 HTTP checks. This packaging change was checked against the staged runtime rather than represented as another full-suite run.

The unsigned local DMG packaging completed at 56,759,968 bytes. The artifact is labeled `NorthKeep_0.22.0_aarch64-UNSIGNED.dmg` in the local build folder, with a SHA-256 manifest. Tauri CI mode skipped Finder layout automation for this verification image.

## Release boundary

No EAS build, Apple notarization/submission, source push, tag, hosted deployment or release publication was performed. Owner-run commands and artifact verification are in the local build handoff. Fully quit NorthKeep and all locally connected AI hosts before installing; reopen them and verify fresh revision-bound tools plus a read-only Resume before project writes. See `docs/update-memory-projects.md` for the upgrade procedure and remaining local-versus-hosted limits.
