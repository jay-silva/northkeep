# ADR 0024: Mobile device linking and secret storage

- **Date:** 2026-07-16
- **Status:** Proposed. NOT trusted for real vaults until (1) the invariant-#3
  adversarial review of the mobile key-handling surface, INCLUDING the new
  desktop path that exposes device.secret as a QR, passes; and (2) the desktop
  QR-rendering side is actually built (it does not exist yet). The mobile
  side (scan, store, biometric cache, lock-on-background) is scaffolded in
  apps/mobile against these decisions; the desktop side is described here and
  deferred.
- **Deciders:** Jay, Claude Code

## Context

Track M puts the encrypted vault on the phone. To open it, the phone needs the
same two secrets the desktop uses: the passphrase (typed, never stored) and the
32-byte device.secret. On the desktop, device.secret lives in
`~/.northkeep/device.secret` (0600 file; packages/core/src/platform.ts). The
phone has no such file and must receive the secret from the machine that holds
the vault.

The launch plan chose an offline QR hand-off: the desktop GUI renders
`northkeep://link/v1?ds=<base64 of the 32-byte device.secret>` on demand, and
the phone scans it with the camera. The mobile parser
(apps/mobile/src/lib/link-url.ts) and the scan screen
(apps/mobile/app/device-link.tsx) are built and unit-tested for parsing; the
secret then goes into the platform keychain.

The mobile key-derivation and crypto substitutes are settled in ADR 0023
(react-native-libsodium + react-native-quick-crypto, proven byte-exact in Node).
This ADR covers only how the secret gets onto the phone and how it is stored,
cached, and locked there.

## Decision

### Transport: an on-demand, offline QR

The desktop renders the link QR only when the user explicitly asks to link a
phone, and only for as long as that screen is open. The payload is the raw
device.secret (base64 inside the `northkeep://link/v1` URL). The phone scans it
with the camera and never transmits it anywhere; the hand-off is device to
device, over the air gap between screen and camera, with no server in the path.
A manual paste fallback accepts the full URL, the bare base64, or the 64-hex
form straight from the desktop `device.secret` file.

Rationale: the device.secret is the long-lived half of the vault key material.
Keeping its transport explicit and offline means it never touches our
infrastructure and never rides an account-recovery or cloud channel that could
later be compromised or subpoenaed. This mirrors the desktop posture, where the
secret is a local file the user copies deliberately.

### Storage: expo-secure-store, this-device-only, never iCloud

Every secret item on the phone is written with
`WHEN_UNLOCKED_THIS_DEVICE_ONLY` (apps/mobile/src/lib/secure-store.ts). That
accessibility class keeps the item out of iCloud Keychain and out of encrypted
device backups, and prevents it from migrating to a new phone. The consequence
is deliberate: re-linking a replacement phone requires scanning a fresh QR from
the desktop, exactly as the desktop requires deliberately copying the secret
file. Transport stays explicit; the secret is never silently replicated.

### Biometric-gated master-key cache

Deriving the master key runs Argon2id at MODERATE cost (256 MiB), which is slow
on a phone. To avoid re-running it on every foreground, the app offers an
opt-in cache of the DERIVED master key (not the passphrase), stored with
`requireAuthentication: true` so iOS Keychain / Android Keystore gate every read
behind Face ID, Touch ID, or the device PIN. This is the mobile analog of the
desktop background-unlock decision (ADR 0002): a convenience that trades a
narrow, biometrics-gated at-rest exposure of the derived key for not holding the
passphrase and not re-deriving. A separate, unauthenticated flag records that
the cache exists so the unlock screen can offer the biometric path without first
triggering a prompt. "Lock vault" deletes the cached key.

### Lock-on-background

The vault locks (open Vault closed, in-memory key zeroed) when the app leaves
the foreground (`AppState === 'background'`, not the transient `inactive`
state), so a backgrounded app holds no plaintext and no live key. The
biometrics-gated cache in the keychain survives, so reopening is one biometric
prompt rather than a full passphrase + Argon2id cycle. App-switcher snapshot
blurring is deferred to M6-5.

## The key-handling change this introduces (invariant #3, loud flag)

Rendering device.secret as a QR is a NEW WAY TO GET THE VAULT KEY MATERIAL OUT
OF THE DESKTOP. Today device.secret only ever exists as a 0600 file that nothing
displays. A GUI/API path that reads that file and paints it on screen (or an
equivalent `northkeep link` CLI command) is a key-handling change, and CLAUDE.md
invariant #3 requires an explicit adversarial-review session before it ships.
That review has NOT happened, and the desktop QR renderer has NOT been built.
Nothing in this ADR authorizes shipping the desktop side; it authorizes the
mobile receiving side and records the design the desktop side must be reviewed
against.

## Threat model

- **On-screen QR is shoulder-surfable.** Anyone who photographs the QR while it
  is displayed obtains the device.secret, which (combined with the passphrase)
  is full vault access, and (alone) is enough to derive the sync credentials and
  pull the ciphertext blob. The QR is therefore as sensitive as a recovery key:
  it must be shown briefly, on demand, dismissed immediately, never persisted to
  a screenshot or a shared screen, and the GUI copy must say so. The adversarial
  review must decide whether to add a short display timeout and an on-screen
  warning.
- **A stolen device.secret alone does not reveal plaintext**, because the
  passphrase is still required to derive the master key and decrypt the vault.
  It DOES grant sync-transport access (pull the ciphertext, derive accountId /
  token), so a leaked secret should be treated as a reason to rotate, the same
  as on desktop.
- **The secret at rest on the phone** is protected by the Secure Enclave / TEE
  backed keychain, this-device-only, never in a backup. The residual exposure is
  the biometrics-gated derived-key cache, which is the same accepted trade the
  desktop background-unlock makes.
- **No new server surface.** The hand-off never contacts NorthKeep
  infrastructure; the sync server still only ever sees ciphertext and the
  derived token hash.

## Alternatives considered

- **Type the 64-hex secret by hand.** Always available as the fallback, but
  error-prone for 64 characters; the QR is the primary path with paste as
  backup.
- **Push the secret through an account / cloud channel.** Rejected: it would put
  the vault key material on our infrastructure and break the explicit-offline
  posture that lets us say the transport never touches our servers.
- **Derive a phone-specific secret instead of sharing the desktop one.**
  Rejected for v1: the whole point of the shared device.secret (ADR 0009) is
  that the same passphrase + secret reproduces the same master key anywhere, so
  the phone can open the identical `.nkv`. A per-device secret would require a
  key-wrapping scheme and re-encryption, a larger change than the launch needs.
- **Bluetooth / local-network pairing.** More moving parts and a live channel to
  secure; the air-gapped QR is simpler and strictly offline.

## Needs on-device validation / adversarial review before merge

1. The invariant-#3 adversarial review of the full mobile key-handling surface
   (this ADR plus ADR 0023), explicitly including the not-yet-built desktop QR
   exposure of device.secret and whether the on-screen QR needs a timeout and a
   shoulder-surfing warning.
2. On-device confirmation of the SecureStore behavior that cannot run off a
   device: `WHEN_UNLOCKED_THIS_DEVICE_ONLY` really excludes the item from iCloud
   and backups; `requireAuthentication` really gates each read behind biometrics;
   the denial / no-biometrics-enrolled / re-enrollment-invalidation paths behave
   as the code assumes.
3. On-device confirmation of the camera permission flow, the repeated
   `onBarcodeScanned` callback cadence, and an end-to-end scan of a QR generated
   by the (future) desktop renderer.
4. On-device confirmation of the `AppState` background transition driving the
   lock, and that no plaintext survives in the app-switcher snapshot (the
   snapshot-blur work itself is M6-5).
