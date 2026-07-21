/**
 * Encryption-at-rest for shared-scope memory CONTENT in the connector store
 * (invariant #2 + #3). The connector database is a dumb ciphertext store: the
 * `content` column holds an opaque `"nkc1:"`-prefixed blob, never plaintext. A
 * DB-only breach therefore yields ciphertext, not memories.
 *
 * Threat model / honest boundary (invariant #2):
 *  - The per-account content key is NEVER stored in the DB. It is re-derived on
 *    each request from a server-held env secret + the (non-secret) accountHash:
 *      key = HKDF-SHA256(ikm = NORTHKEEP_CONNECTOR_CONTENT_SECRET,
 *                        salt = accountHash, info = "nk-connector-content-v1", 32B)
 *    So a thief of the connector DB alone cannot read content — there is no key
 *    in it. A full RUNTIME compromise (env secret + live process) is NOT
 *    protected; invariant #2 states that boundary explicitly.
 *  - AEAD is XChaCha20-Poly1305 (@noble/ciphers, pure-JS, serverless-safe, the
 *    same audited primitive the mobile vault uses) with a fresh random 24-byte
 *    nonce per entry. NO hand-rolled crypto (invariant #3); NOT sodium-native
 *    (keeps the serverless bundle lean, mirroring entitlement.ts).
 *  - Content is encrypted per-ACCOUNT at the push boundary, before any specific
 *    AI app retrieves it, so the app's OAuth secret is intentionally NOT part of
 *    the key. Access is still gated by the existing OAuth/pairing auth: only a
 *    legitimately-paired app reaches the transient decrypt path. Cross-account
 *    isolation is cryptographic: account B's derived key cannot authenticate
 *    account A's blob (auth failure -> null).
 *
 * Scope names, entry ids, types, entry_hash, counts, and timestamps stay
 * plaintext metadata by design (invariant #2 permits metadata visibility). ONLY
 * `content` is encrypted here.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from 'node:crypto';

/** Versioned wire prefix. Bump (nkc2:) if the KDF/AEAD/layout ever changes. */
export const CONTENT_BLOB_PREFIX = 'nkc1:';
/** HKDF `info` — domain-separates this key from any other use of the secret. */
const HKDF_INFO = 'nk-connector-content-v1';
/** XChaCha20-Poly1305 nonce size. */
const NONCE_BYTES = 24;
/** Minimum accepted secret entropy. */
const MIN_SECRET_BYTES = 32;
/** Derived content-key size. */
const KEY_BYTES = 32;

/**
 * The connector content secret (input keying material for the per-account KDF),
 * read from `NORTHKEEP_CONNECTOR_CONTENT_SECRET`. Accepts hex, base64/base64url,
 * or a raw string, and requires at least 32 bytes of entropy.
 *
 * Returns null when the env var is UNSET (the caller decides fail-closed: a real
 * Neon-backed server must refuse to start without it). Throws when it is SET but
 * too weak — a loud misconfiguration, never a silent downgrade to plaintext.
 */
export function connectorContentSecretFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.NORTHKEEP_CONNECTOR_CONTENT_SECRET;
  if (raw === undefined || raw === '') return null;
  const buf = decodeSecret(raw);
  if (buf.length < MIN_SECRET_BYTES) {
    throw new Error(
      `NORTHKEEP_CONNECTOR_CONTENT_SECRET must be at least ${MIN_SECRET_BYTES} bytes of entropy ` +
        `(got ${buf.length}). Use e.g. \`openssl rand -hex 32\`.`,
    );
  }
  return buf;
}

/** hex → base64/base64url → raw utf8, taking the first form that yields >= 32 bytes. */
function decodeSecret(raw: string): Buffer {
  const s = raw.trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    const hex = Buffer.from(s, 'hex');
    if (hex.length >= MIN_SECRET_BYTES) return hex;
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const b64 = Buffer.from(s, s.includes('-') || s.includes('_') ? 'base64url' : 'base64');
    if (b64.length >= MIN_SECRET_BYTES) return b64;
  }
  return Buffer.from(s, 'utf8');
}

/** Derive the per-account content key. salt = utf8(accountHash); pure, deterministic. */
function deriveKey(accountHash: string, secret: Buffer): Uint8Array {
  return hkdf(sha256, secret, utf8ToBytes(accountHash), utf8ToBytes(HKDF_INFO), KEY_BYTES);
}

/**
 * Encrypt plaintext content for at-rest storage. Returns a versioned opaque
 * string `"nkc1:" + base64(nonce || ciphertextWithTag)`. The empty string
 * encrypts to just the auth tag (still a valid, decryptable blob).
 */
export function encryptContent(accountHash: string, plaintext: string, secret: Buffer): string {
  const key = deriveKey(accountHash, secret);
  const nonce = randomBytes(NONCE_BYTES);
  const ct = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(plaintext));
  const packed = Buffer.concat([nonce, Buffer.from(ct.buffer, ct.byteOffset, ct.byteLength)]);
  return CONTENT_BLOB_PREFIX + packed.toString('base64');
}

/**
 * Decrypt an at-rest content blob. FAIL CLOSED: returns null (never throws into a
 * request path, never leaks) for anything unreadable —
 *  - a blob without the `"nkc1:"` prefix (legacy plaintext / unknown format),
 *  - a malformed/truncated blob,
 *  - a wrong accountHash, a different secret, or a tampered blob (all surface as
 *    an AEAD auth failure, which @noble throws and we convert to null).
 * A null result means "skip this row", which is exactly the fail-closed posture
 * at every retrieve boundary.
 */
export function decryptContent(accountHash: string, blob: string, secret: Buffer): string | null {
  if (typeof blob !== 'string' || !blob.startsWith(CONTENT_BLOB_PREFIX)) return null;
  try {
    const packed = Buffer.from(blob.slice(CONTENT_BLOB_PREFIX.length), 'base64');
    if (packed.length < NONCE_BYTES) return null;
    const nonce = packed.subarray(0, NONCE_BYTES);
    const ct = packed.subarray(NONCE_BYTES);
    const key = deriveKey(accountHash, secret);
    const pt = xchacha20poly1305(key, nonce).decrypt(ct);
    return Buffer.from(pt.buffer, pt.byteOffset, pt.byteLength).toString('utf8');
  } catch {
    return null;
  }
}
