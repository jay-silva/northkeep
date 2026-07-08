import { createHash, timingSafeEqual } from 'node:crypto';
import type { Storage } from './storage.js';

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

export const MAX_BLOB_BYTES = 4 * 1024 * 1024;
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
  /** Raw request body for PUT (the ciphertext blob). */
  body: Buffer | null;
}

export interface SyncResponse {
  status: number;
  /** JSON object, or a raw Buffer (for the blob download). */
  body?: Record<string, unknown> | Buffer;
  headers?: Record<string, string>;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function json(status: number, body: Record<string, unknown>): SyncResponse {
  return { status, body };
}

export async function handleSync(req: SyncRequest, storage: Storage): Promise<SyncResponse> {
  if (!req.token || req.token.length < 16) {
    return json(401, { error: 'Missing or malformed bearer token.' });
  }
  // Storage is keyed by the token hash; presenting the token is the auth.
  const tokenHash = createHash('sha256').update(req.token, 'utf8').digest('hex');

  if (req.method === 'GET' && req.path === '/api/status') {
    const row = await storage.get(tokenHash);
    if (!row) return json(404, { error: 'No synced vault yet.' });
    return json(200, {
      version: row.version,
      sha256: row.sha256,
      size: row.size,
      updatedAt: row.updatedAt,
    });
  }

  if (req.method === 'GET' && req.path === '/api/blob') {
    const row = await storage.get(tokenHash);
    if (!row) return json(404, { error: 'No synced vault yet.' });
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

  if (req.method === 'PUT' && req.path === '/api/blob') {
    const blob = req.body ?? Buffer.alloc(0);
    if (blob.length > MAX_BLOB_BYTES) {
      return json(413, { error: `Vault exceeds the ${MAX_BLOB_BYTES / 1024 / 1024} MB sync limit.` });
    }
    // Reject anything that isn't a Northkeep vault blob — the server won't act
    // as arbitrary free storage.
    if (blob.length < NKV_HEADER_LENGTH || !constantTimeMagic(blob)) {
      return json(400, { error: 'Body is not a Northkeep vault blob.' });
    }
    const base = req.baseVersion;
    if (base === null || !Number.isInteger(base) || base < 0) {
      return json(400, { error: 'Missing or invalid X-Base-Version.' });
    }
    const result = await storage.put(tokenHash, blob, sha256Hex(blob), base);
    if (!result.ok) return json(409, { version: result.version });
    return json(200, { version: result.version });
  }

  return json(404, { error: 'Not found.' });
}

/** Constant-time magic check (avoids leaking how many bytes matched). */
function constantTimeMagic(blob: Buffer): boolean {
  return timingSafeEqual(blob.subarray(0, 4), NKV_MAGIC);
}
