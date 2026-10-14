# ADR 0024: Mobile device linking and secret storage

Status: Accepted (shipped in the iOS app), dated 2026-07-16; status corrected 2026-07-25 from "Proposed" · Review: open contradiction: the record's body says the invariant #3 adversarial review (including the desktop QR path) had NOT happened and the desktop QR renderer was NOT built; it authorizes only the mobile receiving side.

## Context
To open the vault, the phone needs the passphrase (typed, never stored) and the 32-byte device.secret, which on desktop is `~/.northkeep/device.secret` (0600). Mobile crypto is in ADR 0023.

## Decision
- D1: Transport is an on-demand, offline QR. The desktop (not yet built per the record) is to render `northkeep://link/v1?ds=<base64 device.secret>` only while the user has the link screen open. The phone scans it and never transmits it; no server is in the path. A manual paste fallback accepts the full URL, bare base64, or the 64-hex file form.
- D2: Every secret item on the phone is written with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` via expo-secure-store: out of iCloud Keychain and backups, never migrated.
- D3: An opt-in cache of the derived master key (not the passphrase), stored with `requireAuthentication: true` so every read needs Face ID, Touch ID or device PIN. This avoids re-running Argon2id at MODERATE cost (256 MiB). An unauthenticated flag records only that the cache exists. "Lock vault" deletes the cached key. This mirrors desktop background unlock (ADR 0002).
- D4: The vault locks (Vault closed, in-memory key zeroed) on `AppState === 'background'`, not `inactive`. App-switcher snapshot blurring is deferred to M6-5.

## Consequences
- Harder: re-linking a new phone needs the desktop.
- Threats accepted: the on-screen QR is shoulder-surfable and as sensitive as a recovery key: shown briefly, dismissed immediately, never screenshotted or screen-shared. With the passphrase it is full vault access; alone it grants sync-transport access (pull ciphertext, derive accountId/token), so a leak means rotate. Alone it does not reveal plaintext. The biometrics-gated derived-key cache is the residual at-rest exposure.
- Required before merge in the original record: the invariant #3 review (including whether the QR needs a display timeout and a shoulder-surfing warning), and on-device checks that `WHEN_UNLOCKED_THIS_DEVICE_ONLY` excludes backups, `requireAuthentication` gates each read (including denial, no-biometrics and re-enrollment paths), the camera scan flow works end to end, and background lock leaves no plaintext in the app-switcher snapshot.

## Rejected
- Pushing the secret through an account or cloud channel: puts key material on our infrastructure.
- A per-phone secret: needs key wrapping and re-encryption; the shared device.secret (ADR 0009) opens the identical `.nkv`.

## What leaves the machine
The original has no egress section. Its threat model states: "The hand-off never contacts NorthKeep infrastructure; the sync server still only ever sees ciphertext and the derived token hash." Rendering device.secret as a QR is a new way to get key material out of the desktop, and the record says it needs the invariant #3 review before it ships.

## Links
Related: ADR 0002, ADR 0009, ADR 0023 · Full record: docs/design/adr-0024-mobile-device-linking.md
