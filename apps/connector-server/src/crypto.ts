/**
 * Encryption-at-rest for the connector store (ADR 0020).
 *
 * The claim this module makes true and falsifiable: "the connector database
 * holds only ciphertext, and the server stores no decryption key." Every
 * shared-entry row is encrypted under a per-account 32-byte DEK; the DEK is
 * never stored raw — only WRAPPED under key-encryption keys (KEKs) derived from
 * credentials the server sees ONLY transiently on a request (the connector
 * token, a pairing code, an authorization code, an access/refresh token). The
 * DB holds credential HASHES (sha256) plus DEK wraps; neither yields a key.
 *
 * Invariant #3: libsodium primitives ONLY —
 *   - KEK derivation: TWO-step keyed BLAKE2b (crypto_generichash), mixing the
 *     request-presented credential AND a server-environment pepper held OUTSIDE
 *     the database. Per-credential-class domain labels keep the classes
 *     separated. Both inputs are required: the pepper closes the pairing-code
 *     brute-force (a pairing code is only ~40 bits, its sha256 is in the DB, so
 *     a DB-only thief could otherwise grind the code offline, derive its KEK,
 *     and unwrap the account DEK). With the pepper outside the DB, no KEK is
 *     derivable from DB state alone.
 *   - DEK wrapping: crypto_secretbox (XSalsa20-Poly1305), versioned "nkw1:".
 *   - Row encryption: XChaCha20-Poly1305 AEAD, versioned "nkc1:", with
 *     AAD = "nk-conn-row-v1" || accountHash. The AAD binds a ciphertext to its
 *     account (a cross-account ciphertext transplant fails to open) but
 *     deliberately EXCLUDES entry_id: /client/ack remaps a row's id as pure
 *     metadata and must never need the DEK.
 *
 * Dependency: libsodium-wrappers (pure-wasm, serverless-safe — sodium-native's
 * prebuilt addon does not load on Vercel functions). Lazy-initialized once.
 */

import sodiumLib from 'libsodium-wrappers';

// Per-credential-class KEK domain labels. Distinct labels mean a KEK derived
// from (say) a pairing code can never unwrap a wrap made for a token KEK.
export const KEK_LABEL_CONNECTOR_TOKEN = 'nk-conn-kek-conn-v1';
export const KEK_LABEL_PAIRING_CODE = 'nk-conn-kek-pair-v1';
export const KEK_LABEL_AUTH_CODE = 'nk-conn-kek-code-v1';
export const KEK_LABEL_TOKEN = 'nk-conn-kek-token-v1';

/** Versioned format prefixes: wrapped DEKs and encrypted rows. */
export const WRAP_PREFIX = 'nkw1';
export const ROW_PREFIX = 'nkc1';

/** The server-environment KEK pepper must be at least this many bytes. */
export const KEK_PEPPER_MIN_BYTES = 32;

/**
 * A fixed, DEV/TEST-ONLY pepper so InMemory storage (local dev and the test
 * suite) runs without any env config. It is deliberately non-secret and
 * obvious. The production guard in createConnectorServer REFUSES to run a real
 * (Neon) database with this — the hosted deploy must supply CONNECTOR_KEK_PEPPER.
 */
export const DEV_KEK_PEPPER: Uint8Array = new Uint8Array(KEK_PEPPER_MIN_BYTES).fill(0x6e); // 'n'

/**
 * Parse the base64 `CONNECTOR_KEK_PEPPER` env value to bytes, or null if unset.
 * Throws (a startup config error) if it is present but shorter than the floor.
 */
export function parseKekPepper(raw: string | undefined): Uint8Array | null {
  if (!raw) return null;
  const bytes = new Uint8Array(Buffer.from(raw, 'base64'));
  if (bytes.length < KEK_PEPPER_MIN_BYTES) {
    throw new Error(
      `CONNECTOR_KEK_PEPPER must decode to at least ${KEK_PEPPER_MIN_BYTES} bytes (base64). Got ${bytes.length}.`,
    );
  }
  return bytes;
}

/** AAD domain label for row encryption (concatenated with the accountHash). */
const ROW_AAD_LABEL = 'nk-conn-row-v1';

const DEK_BYTES = 32;

/**
 * Typed failure for unwrap/decrypt: a wrap or row that does not open under the
 * presented credential chain. Callers map this to invalid_grant (OAuth) or
 * HTTP 409 reencrypt_required (client routes) — NEVER a 500 with internals.
 */
export class ConnectorCryptoError extends Error {
  readonly code = 'connector_crypto_failed';
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorCryptoError';
  }
}

let sodiumReady: Promise<typeof sodiumLib> | null = null;

/** Lazy one-time wasm init; every exported function awaits this. */
async function sodium(): Promise<typeof sodiumLib> {
  if (!sodiumReady) sodiumReady = sodiumLib.ready.then(() => sodiumLib);
  return sodiumReady;
}

/**
 * Two-step KEK derivation, libsodium keyed BLAKE2b only:
 *   k1  = generichash(key = credential utf8 bytes, msg = domain label)
 *   KEK = generichash(key = pepper bytes,          msg = k1)
 * The KEK depends on BOTH the request-presented credential AND the
 * server-environment pepper. Neither alone yields it: a DB thief has the
 * credential HASHES (not the credentials) and never the pepper, so no KEK is
 * derivable from database state alone. This is what defends the low-entropy
 * pairing code (ADR 0020 crypto review). Step 1 stays byte-compatible with the
 * creds.ts pattern; step 2 folds in the pepper.
 */
export async function deriveKek(label: string, secret: string, pepper: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  const k1 = s.crypto_generichash(DEK_BYTES, s.from_string(label), s.from_string(secret));
  return s.crypto_generichash(DEK_BYTES, k1, pepper);
}

/** A fresh random 32-byte per-account data-encryption key. */
export async function generateDek(): Promise<Uint8Array> {
  const s = await sodium();
  return s.randombytes_buf(DEK_BYTES);
}

/** Wrap a DEK under a KEK: "nkw1:<b64 nonce>:<b64 secretbox ct>". */
export async function wrapDek(dek: Uint8Array, kek: Uint8Array): Promise<string> {
  const s = await sodium();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ct = s.crypto_secretbox_easy(dek, nonce, kek);
  return `${WRAP_PREFIX}:${b64(nonce)}:${b64(ct)}`;
}

/** Unwrap "nkw1:..." with a KEK. Throws ConnectorCryptoError on any failure. */
export async function unwrapDek(wrap: string, kek: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  const parts = parseVersioned(wrap, WRAP_PREFIX);
  try {
    return s.crypto_secretbox_open_easy(parts.ct, parts.nonce, kek);
  } catch {
    throw new ConnectorCryptoError('DEK wrap does not open under this credential');
  }
}

/** The plaintext row envelope: what the AEAD protects for each shared entry. */
export interface RowPlain {
  type: string;
  content: string;
}

/**
 * Encrypt one shared-entry row under the account DEK:
 * "nkc1:<b64 nonce>:<b64 XChaCha20-Poly1305 ct>" over JSON {type, content},
 * AAD-bound to the account (NOT the entry id — ack's id-remap stays metadata-only).
 */
export async function encryptRow(
  row: { accountHash: string; type: string; content: string },
  dek: Uint8Array,
): Promise<string> {
  const s = await sodium();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plain: RowPlain = { type: row.type, content: row.content };
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    s.from_string(JSON.stringify(plain)),
    rowAad(row.accountHash),
    null,
    nonce,
    dek,
  );
  return `${ROW_PREFIX}:${b64(nonce)}:${b64(ct)}`;
}

/** Decrypt a "nkc1:..." row for an account. Throws ConnectorCryptoError on failure. */
export async function decryptRow(stored: string, accountHash: string, dek: Uint8Array): Promise<RowPlain> {
  const s = await sodium();
  const parts = parseVersioned(stored, ROW_PREFIX);
  let plainBytes: Uint8Array;
  try {
    plainBytes = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, parts.ct, rowAad(accountHash), parts.nonce, dek);
  } catch {
    throw new ConnectorCryptoError('Row ciphertext does not open for this account/DEK');
  }
  try {
    const parsed = JSON.parse(s.to_string(plainBytes)) as RowPlain;
    if (typeof parsed.type !== 'string' || typeof parsed.content !== 'string') {
      throw new Error('bad envelope');
    }
    return { type: parsed.type, content: parsed.content };
  } catch {
    throw new ConnectorCryptoError('Row envelope is not valid JSON {type, content}');
  }
}

/** True iff a stored content string is an encrypted row (legacy plaintext detector). */
export function isEncryptedRow(stored: string): boolean {
  return stored.startsWith(`${ROW_PREFIX}:`);
}

function rowAad(accountHash: string): Uint8Array {
  const label = Buffer.from(ROW_AAD_LABEL, 'utf8');
  const acct = Buffer.from(accountHash, 'utf8');
  return new Uint8Array(Buffer.concat([label, acct]));
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function parseVersioned(value: string, prefix: string): { nonce: Uint8Array; ct: Uint8Array } {
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== prefix || !parts[1] || !parts[2]) {
    throw new ConnectorCryptoError(`Not a ${prefix} value`);
  }
  const nonce = new Uint8Array(Buffer.from(parts[1], 'base64'));
  const ct = new Uint8Array(Buffer.from(parts[2], 'base64'));
  if (nonce.length === 0 || ct.length === 0) throw new ConnectorCryptoError(`Malformed ${prefix} value`);
  return { nonce, ct };
}
