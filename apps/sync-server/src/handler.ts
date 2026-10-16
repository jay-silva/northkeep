import { createHash, randomBytes } from 'node:crypto';
import type { Storage } from './storage.js';
import { DEFAULT_CAP_BYTES, maxParts, PART_BYTES, SINGLE_REQUEST_MAX, UPLOAD_ID_PATTERN } from './parts.js';

/**
 * The sync server's request logic (ADR 0009), framework-agnostic and
 * storage-agnostic so it can be exercised under a plain node:http harness in
 * tests and wrapped by Vercel functions in production.
 *
 * INVARIANT #2: this server stores CIPHERTEXT + version numbers only. It never
 * decrypts, never sees a key or a passphrase, and never logs blob contents.
 * The bearer token is a device-secret-derived secret; storage is keyed by its
 * SHA-256 (`tokenHash`), so a database leak reveals only hashes, and even the
 * token itself decrypts nothing.
 */

/** Largest vault one single PUT or GET carries; bigger ones sync in parts (ADR 0078). */
export const MAX_BLOB_BYTES = SINGLE_REQUEST_MAX;
const NKV_MAGIC = Buffer.from('NKV1', 'ascii');
const NKV_HEADER_LENGTH = 52;

export interface SyncRequest {
  method: string;
  /** Pathname only, e.g. '/api/status' or '/api/blob'. */
  path: string;
  /** Bearer token from Authorization, or null. */
  token: string | null;
  /** X-Base-Version on PUT. */
  baseVersion: number | null;
  /** Raw request body for PUT and POST (a blob, a part, or commit JSON). */
  body: Buffer | null;
}

export interface SyncResponse {
  status: number;
  /** JSON object, or a raw Buffer (for the blob download). */
  body?: Record<string, unknown> | Buffer;
  headers?: Record<string, string>;
}

export interface SyncOptions {
  /**
   * Access allowlist of `sha256(token)` hashes. Listed accounts sync FREE —
   * the vault owner's own account and anyone comped, plus self-hosters who run
   * their own private server. Get your hash from `northkeep sync id`.
   */
  allowedTokenHashes?: ReadonlySet<string> | null;
  /**
   * Billing gate (M5b). When provided, an account NOT on the allowlist must
   * have an active subscription to sync (else 402). Undefined = billing off
   * (self-host / open), and only the allowlist gates (ADR 0009/0010).
   */
  subscriptionActive?: (tokenHash: string) => Promise<boolean>;
  /** Largest vault this server stores, in bytes (ADR 0078 D2). */
  capBytes?: number;
}

type Route =
  | { kind: 'status' }
  | { kind: 'blob-get' }
  | { kind: 'blob-put' }
  | { kind: 'upload-create' }
  | { kind: 'part-put'; uploadId: string; n: number }
  | { kind: 'part-get'; uploadId: string; n: number }
  | { kind: 'commit'; uploadId: string };

/** Parses only the routes this server serves; segments are bounded before use. */
function routeOf(method: string, path: string, partLimit: number): Route | null {
  if (path === '/api/status') return method === 'GET' ? { kind: 'status' } : null;
  if (path === '/api/blob') return method === 'GET' ? { kind: 'blob-get' } : method === 'PUT' ? { kind: 'blob-put' } : null;
  if (path === '/api/blob/uploads') return method === 'POST' ? { kind: 'upload-create' } : null;
  const m = /^\/api\/blob\/uploads\/([0-9a-f]{32})\/(?:(\d{1,3})|parts\/(\d{1,3})|(commit))$/.exec(path);
  if (!m || !UPLOAD_ID_PATTERN.test(m[1]!)) return null;
  const uploadId = m[1]!;
  if (m[4] === 'commit') return method === 'POST' ? { kind: 'commit', uploadId } : null;
  const n = Number(m[2] ?? m[3]);
  if (!Number.isInteger(n) || n < 0 || n >= partLimit) return null;
  if (m[2] !== undefined) return method === 'PUT' ? { kind: 'part-put', uploadId, n } : null;
  return method === 'GET' ? { kind: 'part-get', uploadId, n } : null;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function json(status: number, body: Record<string, unknown>): SyncResponse {
  return { status, body };
}

export async function handleSync(
  req: SyncRequest,
  storage: Storage,
  options: SyncOptions = {},
): Promise<SyncResponse> {
  // Unknown routes 404 BEFORE the access gate: the subscription check costs a
  // DB round-trip, and it must not be reachable on paths the server doesn't
  // serve (that was a rate-limit-bypass amplifier — adversarial review H1).
  const capBytes = options.capBytes ?? DEFAULT_CAP_BYTES;
  const partLimit = maxParts(capBytes);
  const route = routeOf(req.method, req.path, partLimit);
  if (!route) return json(404, { error: 'Not found.' });

  if (!req.token || req.token.length < 16) {
    return json(401, { error: 'Missing or malformed bearer token.' });
  }
  // Storage is keyed by the token hash; presenting the token is the auth.
  const tokenHash = createHash('sha256').update(req.token, 'utf8').digest('hex');

  // Access gate (ADR 0009/0010): allowlisted accounts sync FREE. Otherwise, if
  // billing is on, an active subscription is required (402); if billing is off
  // but an allowlist exists, a non-listed account is a private-server 403;
  // with neither, the server is open.
  const inAllowlist = options.allowedTokenHashes?.has(tokenHash) ?? false;
  if (!inAllowlist) {
    if (options.subscriptionActive) {
      if (!(await options.subscriptionActive(tokenHash))) {
        return json(402, {
          error: 'A $10/month subscription is required to sync on this server.',
          subscribe: true,
        });
      }
    } else if (options.allowedTokenHashes) {
      return json(403, { error: 'This sync server is private.' });
    }
  }

  if (route.kind === 'status') {
    const meta = await storage.getMeta(tokenHash);
    if (!meta) return json(404, { error: 'No synced vault yet.', cap_bytes: capBytes, part_bytes: PART_BYTES });
    return json(200, {
      version: meta.version,
      sha256: meta.sha256,
      size: meta.size,
      updatedAt: meta.updatedAt,
      cap_bytes: capBytes,
      part_bytes: PART_BYTES,
      upload_id: meta.uploadId,
      parts: meta.parts,
    });
  }

  if (route.kind === 'blob-get') {
    const row = await storage.get(tokenHash);
    if (!row) return json(404, { error: 'No synced vault yet.' });
    if (row.uploadId !== null) {
      return json(409, { error: 'This vault is over 4 MB and syncs in parts. Update NorthKeep to sync it.', parts: row.parts });
    }
    return {
      status: 200,
      body: row.blob,
      headers: {
        'content-type': 'application/octet-stream',
        'x-version': String(row.version),
        'x-sha256': row.sha256,
        'cache-control': 'no-store',
      },
    };
  }

  if (route.kind === 'blob-put') {
    const blob = req.body ?? Buffer.alloc(0);
    if (blob.length > MAX_BLOB_BYTES) {
      return json(413, { error: `Vault exceeds the ${MAX_BLOB_BYTES / 1024 / 1024} MB single-request limit; sync it in parts.` });
    }
    // Reject anything that isn't shaped like a NorthKeep vault blob. NOTE: this
    // is a sanity check, NOT abuse protection — the server can't read ciphertext
    // and a forged NKV1 blob is indistinguishable from a real one. Real abuse
    // protection is the allowlist above (or billing, M5b) + the size cap.
    if (blob.length < NKV_HEADER_LENGTH || !hasVaultMagic(blob)) {
      return json(400, { error: 'Body is not a NorthKeep vault blob.' });
    }
    const base = req.baseVersion;
    if (base === null || !Number.isInteger(base) || base < 0) {
      return json(400, { error: 'Missing or invalid X-Base-Version.' });
    }
    const result = await storage.put(tokenHash, blob, sha256Hex(blob), base);
    if (!result.ok) return json(409, { version: result.version });
    await storage.pruneUploads(tokenHash);
    return json(200, { version: result.version });
  }

  if (route.kind === 'upload-create') {
    const uploadId = randomBytes(16).toString('hex');
    await storage.pruneUploads(tokenHash);
    await storage.createUpload(tokenHash, uploadId);
    return json(200, { upload_id: uploadId, part_bytes: PART_BYTES, max_parts: partLimit, cap_bytes: capBytes });
  }

  if (route.kind === 'part-put') {
    const bytes = req.body ?? Buffer.alloc(0);
    if (bytes.length === 0 || bytes.length > PART_BYTES) {
      return json(400, { error: `A part must be 1 to ${PART_BYTES} bytes.` });
    }
    const written = await storage.putPart(tokenHash, route.uploadId, route.n, bytes);
    if (written !== 'ok') return json(409, { error: 'This upload was replaced or has expired.', replaced: true });
    return json(200, { ok: true });
  }

  if (route.kind === 'commit') {
    const commit = parseCommit(req.body);
    if (!commit) return json(400, { error: 'Commit needs base, parts, size and sha256.' });
    if (commit.size > capBytes) {
      return json(413, { error: `Vault exceeds the ${capBytes / 1024 / 1024} MB sync limit.`, cap_bytes: capBytes });
    }
    if (commit.parts < 1 || commit.parts > partLimit) return json(400, { error: 'Invalid part count.' });
    const parts = await storage.readOpenParts(tokenHash, route.uploadId);
    if (!parts) return json(409, { error: 'This upload was replaced or has expired.', replaced: true });
    const problem = checkParts(parts, commit);
    if (problem) return json(400, { error: problem });
    const result = await storage.commitUpload(
      tokenHash,
      route.uploadId,
      commit.base,
      commit.sha256,
      commit.size,
      commit.parts,
    );
    if (!result.ok) {
      return result.reason === 'replaced'
        ? json(409, { error: 'This upload was replaced or has expired.', replaced: true })
        : json(409, { version: result.version });
    }
    await storage.pruneUploads(tokenHash);
    return json(200, { version: result.version });
  }

  if (route.kind === 'part-get') {
    const bytes = await storage.getPart(tokenHash, route.uploadId, route.n);
    if (!bytes) return json(410, { error: 'That version is no longer kept; start the download again.' });
    return {
      status: 200,
      body: bytes,
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
    };
  }

  return json(404, { error: 'Not found.' });
}

interface Commit {
  base: number;
  parts: number;
  size: number;
  sha256: string;
}

function parseCommit(body: Buffer | null): Commit | null {
  if (!body || body.length > 1024) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const { base, parts, size, sha256 } = raw as Record<string, unknown>;
  if (!Number.isInteger(base) || (base as number) < 0) return null;
  if (!Number.isInteger(parts) || !Number.isInteger(size) || (size as number) < NKV_HEADER_LENGTH) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { base: base as number, parts: parts as number, size: size as number, sha256 };
}

/** Contiguous parts, full-size except the last, totalling size, hashing to sha256. */
function checkParts(parts: Array<[number, Buffer]>, commit: Commit): string | null {
  if (parts.length !== commit.parts) return 'Some parts are missing.';
  let total = 0;
  const hash = createHash('sha256');
  for (let i = 0; i < parts.length; i++) {
    const [n, bytes] = parts[i]!;
    if (n !== i) return 'Some parts are missing.';
    if (i < parts.length - 1 && bytes.length !== PART_BYTES) return 'Only the last part may be short.';
    total += bytes.length;
    hash.update(bytes);
  }
  if (total !== commit.size) return 'Parts do not add up to the stated size.';
  const first = parts[0]?.[1];
  if (!first || first.length < NKV_HEADER_LENGTH || !hasVaultMagic(first)) return 'Body is not a NorthKeep vault blob.';
  if (hash.digest('hex') !== commit.sha256) return 'Parts do not match the stated sha256.';
  return null;
}

/** The 4-byte NKV1 magic (a public constant — no secret, no timing concern). */
function hasVaultMagic(blob: Buffer): boolean {
  return blob.subarray(0, 4).equals(NKV_MAGIC);
}

/** Parse `NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES` (comma/space separated) → set. */
export function parseAllowlist(raw: string | undefined): ReadonlySet<string> | null {
  if (!raw) return null;
  const hashes = raw
    .split(/[,\s]+/)
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[0-9a-f]{64}$/.test(h));
  return hashes.length > 0 ? new Set(hashes) : null;
}
