import * as SecureStore from 'expo-secure-store';
import { parseSyncBaseline, serializeSyncBaseline, type SyncBaseline } from './sync-flow';

export type { SyncBaseline };

/**
 * All secret material on the phone lives here (ADR: device linking & mobile
 * secret storage). Policy, per the plan:
 *
 *  - WHEN_UNLOCKED_THIS_DEVICE_ONLY on every item: never migrates to a new
 *    device and never lands in an iCloud/adb backup. Transport between
 *    devices stays explicit (the QR link), exactly like the desktop's
 *    device.secret file posture.
 *  - The cached master key additionally sets requireAuthentication, so iOS
 *    Keychain / Android Keystore gates each read behind biometrics (the
 *    mobile analog of ADR 0002 background unlock).
 *
 * NEEDS ON-DEVICE VALIDATION: SecureStore accessibility + requireAuthentication
 * behavior (Face ID prompt on read, denial path, device without biometrics)
 * cannot be exercised outside a real device.
 */

const DEVICE_SECRET_KEY = 'nk.device_secret_hex';
const CACHED_MASTER_KEY = 'nk.cached_master_key_hex';
const BIOMETRIC_FLAG_KEY = 'nk.biometric_unlock_enabled';
const SYNC_SERVER_KEY = 'nk.sync_server_url';
const SYNC_BASELINE_KEY = 'nk.sync_baseline';
// Legacy, read once and deleted: the three keys the baseline used to be split
// across (ADR 0044, sixth review kill shot).
const SYNC_VERSION_KEY = 'nk.sync_last_version';
const SYNC_SYNCED_AT_KEY = 'nk.sync_last_synced_at';
const SYNC_LOCAL_DIRTY_KEY = 'nk.sync_local_dirty';
const SYNC_LAST_SHA_KEY = 'nk.sync_last_sha';
const SYNC_LAST_GENERATION_KEY = 'nk.sync_last_generation';
const CONNECTOR_SERVER_KEY = 'nk.connector_server_url';
const CONNECTOR_SHARED_SCOPES_KEY = 'nk.connector_shared_scopes';
const CONNECTOR_PAIRED_AT_KEY = 'nk.connector_paired_at';
const JOURNAL_CARD_DISMISSED_KEY = 'nk.journal_card_dismissed';

const BASE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// --- device secret (from the link QR / manual paste) ---

export async function saveDeviceSecretHex(hex: string): Promise<void> {
  await SecureStore.setItemAsync(DEVICE_SECRET_KEY, hex, BASE_OPTIONS);
}

export async function loadDeviceSecretHex(): Promise<string | null> {
  return SecureStore.getItemAsync(DEVICE_SECRET_KEY, BASE_OPTIONS);
}

// --- biometric-gated master-key cache (optional, opt-in) ---

export async function cacheMasterKeyHex(hex: string): Promise<void> {
  await SecureStore.setItemAsync(CACHED_MASTER_KEY, hex, {
    ...BASE_OPTIONS,
    requireAuthentication: true,
  });
  // Separate unauthenticated flag: reading the key itself always triggers the
  // biometric prompt, so the UI needs a prompt-free way to know the cache exists.
  await SecureStore.setItemAsync(BIOMETRIC_FLAG_KEY, '1', BASE_OPTIONS);
}

/** Triggers the OS biometric prompt. Returns null if absent or if auth is refused. */
export async function readCachedMasterKeyHex(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(CACHED_MASTER_KEY, {
      ...BASE_OPTIONS,
      requireAuthentication: true,
    });
  } catch {
    // Auth canceled/failed, or keychain item invalidated (e.g. biometrics
    // re-enrolled). The passphrase path is always available.
    return null;
  }
}

export async function biometricUnlockEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(BIOMETRIC_FLAG_KEY, BASE_OPTIONS)) === '1';
}

/** "Lock vault" semantics from the plan: deletes the cached key. */
export async function clearCachedMasterKey(): Promise<void> {
  await SecureStore.deleteItemAsync(CACHED_MASTER_KEY);
  await SecureStore.deleteItemAsync(BIOMETRIC_FLAG_KEY);
}

// --- sync sidecar (mobile analog of ~/.northkeep/sync.json; never a secret) ---

export async function saveSyncServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(SYNC_SERVER_KEY, url, BASE_OPTIONS);
}

export async function loadSyncServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SYNC_SERVER_KEY, BASE_OPTIONS);
}

/**
 * THE BASELINE, read as one value (ADR 0044, sixth review kill shot). Bad JSON
 * or any field out of shape reads as null, i.e. "baseline unknown", which the
 * wake routes to establish/needs-pull and never to a push.
 *
 * READ-COMPAT: a phone upgrading from the three-key layout has no new key yet.
 * The first read assembles the baseline from the legacy keys, writes it once,
 * and deletes them. A failure anywhere in that migration is swallowed: the
 * caller still gets the assembled value, and the next read re-migrates.
 */
export async function loadSyncBaseline(): Promise<SyncBaseline | null> {
  const raw = await SecureStore.getItemAsync(SYNC_BASELINE_KEY, BASE_OPTIONS);
  if (raw !== null) return parseSyncBaseline(raw);
  return migrateLegacyBaseline();
}

async function migrateLegacyBaseline(): Promise<SyncBaseline | null> {
  const rawVersion = await SecureStore.getItemAsync(SYNC_VERSION_KEY, BASE_OPTIONS);
  const rawSha = await SecureStore.getItemAsync(SYNC_LAST_SHA_KEY, BASE_OPTIONS);
  const rawGeneration = await SecureStore.getItemAsync(SYNC_LAST_GENERATION_KEY, BASE_OPTIONS);
  if (rawVersion === null && rawSha === null && rawGeneration === null) return null;
  const version = Number(rawVersion);
  const generation = Number(rawGeneration);
  const baseline: SyncBaseline = {
    version: Number.isInteger(version) && version >= 0 ? version : 0,
    sha: rawSha !== null && /^[0-9a-f]{64}$/.test(rawSha) ? rawSha : null,
    generation: rawGeneration !== null && Number.isInteger(generation) && generation >= 0 ? generation : null,
    pendingStampSha: null,
  };
  try {
    await saveSyncBaseline(baseline);
    await SecureStore.deleteItemAsync(SYNC_VERSION_KEY, BASE_OPTIONS);
    await SecureStore.deleteItemAsync(SYNC_LAST_SHA_KEY, BASE_OPTIONS);
    await SecureStore.deleteItemAsync(SYNC_LAST_GENERATION_KEY, BASE_OPTIONS);
  } catch {
    // The legacy keys are still there; the next read migrates again.
  }
  return baseline;
}

/**
 * THE ONE WRITE. Every install and every accepted push records its baseline
 * with this call and no other, so there is no window in which the version, the
 * sha and the generation describe different moments.
 */
export async function saveSyncBaseline(baseline: SyncBaseline): Promise<void> {
  await SecureStore.setItemAsync(SYNC_BASELINE_KEY, serializeSyncBaseline(baseline), BASE_OPTIONS);
}

/**
 * Merge one field into the baseline. Thin wrappers below use it so existing
 * callers keep working; anything that records a landed sync must use
 * saveSyncBaseline instead, or it is writing the baseline in pieces again.
 */
async function patchSyncBaseline(patch: Partial<SyncBaseline>): Promise<void> {
  const current = (await loadSyncBaseline()) ?? { version: 0, sha: null, generation: null, pendingStampSha: null };
  await saveSyncBaseline({ ...current, ...patch });
}

export async function saveLastSyncVersion(version: number): Promise<void> {
  await patchSyncBaseline({ version });
}

export async function loadLastSyncVersion(): Promise<number> {
  return (await loadSyncBaseline())?.version ?? 0;
}

/** The hash of bytes a push stamped but the server never accepted (see SyncBaseline). */
export async function savePendingStampSha(sha: string | null): Promise<void> {
  await patchSyncBaseline({ pendingStampSha: sha });
}

// --- ADR 0044: the sync age and the unpushed-edit flag ---

/** ISO timestamp of the last push or pull that landed. Drives "Synced N ago". */
export async function saveLastSyncedAt(iso: string): Promise<void> {
  await SecureStore.setItemAsync(SYNC_SYNCED_AT_KEY, iso, BASE_OPTIONS);
}

export async function loadLastSyncedAt(): Promise<string | null> {
  const raw = await SecureStore.getItemAsync(SYNC_SYNCED_AT_KEY, BASE_OPTIONS);
  return raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

/**
 * True while a local save is waiting for its push to land. Persisted (not
 * just in syncState) so a push that failed before a relaunch is still known
 * to be unpushed afterwards; the wake pull refuses to run over it.
 */
export async function saveLocalDirty(dirty: boolean): Promise<void> {
  if (dirty) await SecureStore.setItemAsync(SYNC_LOCAL_DIRTY_KEY, '1', BASE_OPTIONS);
  else await SecureStore.deleteItemAsync(SYNC_LOCAL_DIRTY_KEY, BASE_OPTIONS);
}

export async function loadLocalDirty(): Promise<boolean> {
  return (await SecureStore.getItemAsync(SYNC_LOCAL_DIRTY_KEY, BASE_OPTIONS)) === '1';
}

/**
 * Hex sha256 of the vault file as it stood after the last push the server
 * accepted or the last pull that installed its copy. The wake compares the
 * file on disk against this before any automatic pull; null (never synced,
 * or a phone that synced before this key existed) counts as changed, so the
 * wake pushes rather than pulls (ADR 0044, second review).
 *
 * A THIN WRAPPER over the single baseline value since the sixth review: it
 * read-modify-writes one field. Anything recording a landed sync must call
 * saveSyncBaseline once instead.
 */
export async function saveLastSyncSha(sha: string | null): Promise<void> {
  await patchSyncBaseline({ sha: sha && /^[0-9a-f]{64}$/.test(sha) ? sha : null });
}

export async function loadLastSyncSha(): Promise<string | null> {
  return (await loadSyncBaseline())?.sha ?? null;
}

/**
 * The sync generation sealed inside the bytes this phone LAST SYNCED: the
 * generation the server accepted on the last successful push, or the one
 * carried by the last blob a pull installed. The mobile analog of the
 * desktop's `sync.json` `lastGeneration` (packages/sync/src/config.ts), and
 * it is load-bearing in two places (ADR 0044, fifth review):
 *
 *   - the push decides whether to bump against it, so a push retried four
 *     times gains ONE generation rather than four;
 *   - the pull's replay check compares an incoming blob against it, rather
 *     than against the local file's stamp (which inflates with unpushed
 *     edits and establishes nothing).
 *
 * Null on a phone that predates this key, and on a phone whose only sync so
 * far was a first pull with no key to read the installed generation with.
 * Null means "no baseline": the push bumps, and the replay check is inert.
 *
 * A THIN WRAPPER over the single baseline value (see saveLastSyncSha).
 */
export async function saveLastSyncGeneration(generation: number | null): Promise<void> {
  await patchSyncBaseline({ generation });
}

export async function loadLastSyncGeneration(): Promise<number | null> {
  // A corrupt value reads as "no baseline", never as 0: 0 is a real baseline
  // that would refuse honest blobs, and a garbled value must never be able to
  // wedge a pull. parseSyncBaseline enforces that for the whole value.
  return (await loadSyncBaseline())?.generation ?? null;
}

// --- connector sidecar (Phase B Cloud Connect: the mobile analog of the
// desktop's ~/.northkeep/connector.json, which is node:fs-only). Holds only
// WHERE the connector server is. Never a secret: the connector token is
// re-derived from the device secret on demand (ADR 0019), exactly like the
// sync creds.
//
// The shared-scope LIST no longer lives here: ADR 0038 moved it into the
// encrypted vault's scopes table so it syncs with the vault and matches the
// desktop exactly. The legacy key survives below only as a one-time migration
// source (read once, folded into the vault, deleted). ---

export async function saveConnectorServerUrl(url: string): Promise<void> {
  // A pairing belongs to one server, so a different URL drops the marker;
  // setting the same URL again keeps it (same rule as the desktop sidecar).
  const current = await SecureStore.getItemAsync(CONNECTOR_SERVER_KEY, BASE_OPTIONS);
  if (current !== url) await clearConnectorPairedAt();
  await SecureStore.setItemAsync(CONNECTOR_SERVER_KEY, url, BASE_OPTIONS);
}

/**
 * Record that this phone started a pairing with the configured connector
 * server (ADR 0050 Decision 5). Not a secret: it only says this device has an
 * account there, which is what lets a sync fold from an empty shared list
 * without creating one.
 */
export async function saveConnectorPairedAt(at: Date = new Date()): Promise<void> {
  await SecureStore.setItemAsync(CONNECTOR_PAIRED_AT_KEY, at.toISOString(), BASE_OPTIONS);
}

/** When this phone last started a pairing with the configured server, or null. */
export async function loadConnectorPairedAt(): Promise<string | null> {
  return SecureStore.getItemAsync(CONNECTOR_PAIRED_AT_KEY, BASE_OPTIONS);
}

export async function clearConnectorPairedAt(): Promise<void> {
  await SecureStore.deleteItemAsync(CONNECTOR_PAIRED_AT_KEY, BASE_OPTIONS);
}

export async function loadConnectorServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(CONNECTOR_SERVER_KEY, BASE_OPTIONS);
}

/**
 * MIGRATION ONLY (ADR 0038): the pre-0038 shared-scope list, if this install
 * ever wrote one. Absent (already-migrated 0.19.0, or never shared) is
 * distinct from corrupt: the caller pins fold-done on absent so a restored
 * key cannot re-stamp, and leaves corrupt unmarked so a later readable value
 * can still fold (review F4).
 */
export type LegacySharedScopes =
  | { status: 'absent' }
  | { status: 'corrupt' }
  | { status: 'ok'; scopes: string[] };

export async function loadLegacyConnectorSharedScopes(): Promise<LegacySharedScopes> {
  const raw = await SecureStore.getItemAsync(CONNECTOR_SHARED_SCOPES_KEY, BASE_OPTIONS);
  if (!raw) return { status: 'absent' };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { status: 'corrupt' };
    const scopes = parsed.filter((s): s is string => typeof s === 'string');
    return { status: 'ok', scopes: [...new Set(scopes)].sort() };
  } catch {
    return { status: 'corrupt' };
  }
}

/** Delete the legacy list after fold-in, so a stale copy can never resurrect a share the user has since revoked. */
export async function clearLegacyConnectorSharedScopes(): Promise<void> {
  await SecureStore.deleteItemAsync(CONNECTOR_SHARED_SCOPES_KEY, BASE_OPTIONS);
}

// --- journal setup card (Memories tab, Phase B WS3): a plain dismissed flag ---

export async function saveJournalCardDismissed(): Promise<void> {
  await SecureStore.setItemAsync(JOURNAL_CARD_DISMISSED_KEY, '1', BASE_OPTIONS);
}

export async function loadJournalCardDismissed(): Promise<boolean> {
  return (await SecureStore.getItemAsync(JOURNAL_CARD_DISMISSED_KEY, BASE_OPTIONS)) === '1';
}

// --- sign-out / wipe-local ---

/** Removes every NorthKeep item from the keychain. The vault file is deleted separately. */
export async function wipeAllSecrets(): Promise<void> {
  await SecureStore.deleteItemAsync(CACHED_MASTER_KEY);
  await SecureStore.deleteItemAsync(BIOMETRIC_FLAG_KEY);
  await SecureStore.deleteItemAsync(DEVICE_SECRET_KEY);
  await SecureStore.deleteItemAsync(SYNC_SERVER_KEY);
  await SecureStore.deleteItemAsync(SYNC_BASELINE_KEY);
  await SecureStore.deleteItemAsync(SYNC_VERSION_KEY);
  await SecureStore.deleteItemAsync(SYNC_SYNCED_AT_KEY);
  await SecureStore.deleteItemAsync(SYNC_LOCAL_DIRTY_KEY);
  await SecureStore.deleteItemAsync(SYNC_LAST_SHA_KEY);
  await SecureStore.deleteItemAsync(SYNC_LAST_GENERATION_KEY);
  await SecureStore.deleteItemAsync(CONNECTOR_SERVER_KEY);
  await SecureStore.deleteItemAsync(CONNECTOR_SHARED_SCOPES_KEY);
  await SecureStore.deleteItemAsync(CONNECTOR_PAIRED_AT_KEY);
  await SecureStore.deleteItemAsync(JOURNAL_CARD_DISMISSED_KEY);
}
