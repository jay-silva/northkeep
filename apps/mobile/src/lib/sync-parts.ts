import { MAX_BLOB_BYTES, SINGLE_REQUEST_MAX, SubscriptionRequiredError, UploadReplacedError, effectiveCap } from '@northkeep/sync';
import type { DeadlineScope } from './deadline';

/**
 * ADR 0078 on the phone: a vault over 4 MB moves in parts of up to 3 MB, the
 * same wire contract as packages/sync/src/client.ts pullParts / pushParts.
 * Kept free of expo imports so Node tests drive it against the real server
 * handler; sync.ts passes in expo/fetch and a fresh deadline for each request,
 * so one stalled part fails without the whole transfer sharing one timer.
 */

/** The parts of a Response this module reads; expo/fetch and Node fetch both satisfy it. */
export interface PartsResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PartsTransport {
  fetch(url: string, init: { method?: string; headers: Record<string, string>; body?: Uint8Array<ArrayBuffer> | string; redirect: 'error'; signal: AbortSignal }): Promise<PartsResponse>;
  deadline(): DeadlineScope;
  sha256Hex(bytes: Buffer): Promise<string>;
}

/** What GET /api/status says about a vault in parts. */
export interface PartsStatus {
  version: number;
  sha256: string;
  size: number;
  uploadId: string;
  parts: number;
}

const UPLOAD_ID = /^[0-9a-f]{32}$/;

async function request<T>(
  t: PartsTransport,
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: Uint8Array<ArrayBuffer> | string },
  read: (res: PartsResponse, d: DeadlineScope) => Promise<T>,
): Promise<T> {
  const d = t.deadline();
  try {
    const res = await d.race(t.fetch(url, { ...init, redirect: 'error', signal: d.signal }));
    return await read(res, d);
  } finally {
    d.done();
  }
}

/** Reads the parts fields of a status body; null when the vault is a single blob. */
export function partsStatusOf(body: Record<string, unknown>): PartsStatus | null {
  if (body.upload_id === undefined || body.upload_id === null) return null;
  const uploadId = String(body.upload_id);
  const parts = Number(body.parts);
  const size = Number(body.size);
  if (!UPLOAD_ID.test(uploadId) || !Number.isInteger(parts) || parts < 1 || !Number.isInteger(size)) {
    throw new Error('Sync server reported a malformed vault. Nothing was changed.');
  }
  // Refuse before downloading anything this build could not hold (ADR 0078 D2).
  if (size > MAX_BLOB_BYTES) {
    throw new Error(`The server copy is over this app's ${MAX_BLOB_BYTES / 1024 / 1024} MB limit. Update NorthKeep to sync it.`);
  }
  const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : 0;
  const sha256 = typeof body.sha256 === 'string' ? body.sha256.toLowerCase() : '';
  return { version, sha256, size, uploadId, parts };
}

/** Downloads every part of one upload. Null when the server no longer keeps it (410), so the caller starts over. */
export async function pullPartsMobile(
  t: PartsTransport,
  serverUrl: string,
  token: string,
  status: PartsStatus,
): Promise<{ blob: Buffer; version: number } | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (let n = 0; n < status.parts; n++) {
    const chunk = await request(
      t,
      `${serverUrl}/api/blob/uploads/${status.uploadId}/parts/${n}`,
      { headers: { authorization: `Bearer ${token}` } },
      async (res, d) => {
        if (res.status === 410) return null;
        if (res.status === 402) throw new SubscriptionRequiredError();
        if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on pull.`);
        return Buffer.from(await d.race(res.arrayBuffer()));
      },
    );
    if (chunk === null) return null;
    total += chunk.length;
    if (total > status.size) throw new Error('Downloaded vault is larger than the server said. Nothing was changed.');
    chunks.push(chunk);
  }
  const blob = Buffer.concat(chunks);
  if (blob.length !== status.size) throw new Error('Downloaded vault is incomplete. Nothing was changed.');
  if (status.sha256 && (await t.sha256Hex(blob)) !== status.sha256) {
    throw new Error('Downloaded vault failed its integrity check. Nothing was changed.');
  }
  return { blob, version: status.version };
}

function overLimit(bytes: number, cap: number): Error {
  return new Error(`Vault is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${cap / 1024 / 1024} MB sync limit.`);
}

/** Opens an upload, sends each part, then commits at the base version (ADR 0078 D1). */
export async function pushPartsMobile(
  t: PartsTransport,
  serverUrl: string,
  token: string,
  body: Uint8Array,
  baseVersion: number,
  sha256: string,
): Promise<{ ok: boolean; conflict: boolean; version: number }> {
  const auth = { authorization: `Bearer ${token}` };
  const json = { ...auth, 'content-type': 'application/json' };
  const opened = await request(t, `${serverUrl}/api/blob/uploads`, { method: 'POST', headers: json }, async (res, d) => {
    if (res.status === 402) throw new SubscriptionRequiredError();
    if (res.status === 404) {
      throw new Error('This sync server only takes vaults up to 4 MB. Update the server or make the vault smaller.');
    }
    if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on push.`);
    return (await d.race(res.json())) as { upload_id?: unknown; part_bytes?: unknown; cap_bytes?: unknown };
  });
  const id = String(opened.upload_id);
  const partBytes = Number(opened.part_bytes);
  if (!UPLOAD_ID.test(id) || !Number.isInteger(partBytes) || partBytes < 1024 * 1024 || partBytes > SINGLE_REQUEST_MAX) {
    throw new Error('Sync server answered the push with something unexpected. Nothing was changed.');
  }
  const cap = effectiveCap(opened.cap_bytes);
  if (body.length > cap) throw overLimit(body.length, cap);

  const parts = Math.ceil(body.length / partBytes);
  for (let n = 0; n < parts; n++) {
    // A fresh plain Uint8Array per part: expo/fetch needs a TypedArray body (see sync.ts sha256Hex).
    const part = new Uint8Array(body.subarray(n * partBytes, (n + 1) * partBytes));
    await request(
      t,
      `${serverUrl}/api/blob/uploads/${id}/${n}`,
      { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: part },
      async (res) => {
        if (res.status === 409) throw new UploadReplacedError();
        if (res.status === 402) throw new SubscriptionRequiredError();
        if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on push.`);
      },
    );
  }
  return request(
    t,
    `${serverUrl}/api/blob/uploads/${id}/commit`,
    { method: 'POST', headers: json, body: JSON.stringify({ base: baseVersion, parts, size: body.length, sha256 }) },
    async (res, d) => {
      if (res.status === 409) {
        const conflict = (await d.race(res.json().catch(() => ({})))) as { version?: number; replaced?: boolean };
        if (conflict.replaced) throw new UploadReplacedError();
        return { ok: false, conflict: true, version: conflict.version ?? baseVersion };
      }
      if (res.status === 413) throw overLimit(body.length, cap);
      if (res.status === 402) throw new SubscriptionRequiredError();
      if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on push.`);
      const done = (await d.race(res.json())) as { version: number };
      return { ok: true, conflict: false, version: done.version };
    },
  );
}
