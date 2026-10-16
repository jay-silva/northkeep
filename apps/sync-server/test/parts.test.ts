import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleSync, type SyncRequest, type SyncResponse } from '../src/handler.js';
import { NeonStorage } from '../src/neon-storage.js';
import { PART_BYTES } from '../src/parts.js';
import { InMemoryStorage, type Storage } from '../src/storage.js';

/**
 * ADR 0078 parts protocol, run against both storages: the in-memory one and
 * NeonStorage over PGlite (real Postgres SQL, one connection). Each statement
 * the server sends is checked for what it promises, not how it is written.
 */

const TOKEN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const CAP = 10 * 1024 * 1024;

function pgliteAsNeon(db: PGlite): NeonQueryFunction<false, false> {
  return ((strings: TemplateStringsArray | string, ...values: unknown[]) => {
    if (typeof strings === 'string') return db.query(strings).then((r) => r.rows);
    let text = strings[0] ?? '';
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1] ?? ''}`;
    return db.query(text, values).then((r) => r.rows);
  }) as unknown as NeonQueryFunction<false, false>;
}

function vault(size: number, seed = 1): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed * 7) & 0xff;
  Buffer.from('NKV1', 'ascii').copy(b, 0);
  return b;
}

function sha(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function split(b: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < b.length; i += PART_BYTES) out.push(b.subarray(i, i + PART_BYTES));
  return out;
}

type Call = (partial: Partial<SyncRequest>, token?: string) => Promise<SyncResponse>;

function caller(storage: Storage): Call {
  return (partial, token = TOKEN) =>
    handleSync(
      { method: 'GET', path: '/api/status', token, baseVersion: null, body: null, ...partial },
      storage,
      { capBytes: CAP },
    );
}

function body(r: SyncResponse): Record<string, unknown> {
  return r.body as Record<string, unknown>;
}

async function open(call: Call, token = TOKEN): Promise<string> {
  const r = await call({ method: 'POST', path: '/api/blob/uploads' }, token);
  expect(r.status).toBe(200);
  return body(r).upload_id as string;
}

async function sendParts(call: Call, id: string, blob: Buffer, token = TOKEN): Promise<number> {
  const parts = split(blob);
  for (const [n, p] of parts.entries()) {
    const r = await call({ method: 'PUT', path: `/api/blob/uploads/${id}/${n}`, body: p }, token);
    expect(r.status).toBe(200);
  }
  return parts.length;
}

function commitBody(base: number, blob: Buffer, parts: number): Buffer {
  return Buffer.from(JSON.stringify({ base, parts, size: blob.length, sha256: sha(blob) }));
}

async function push(call: Call, base: number, blob: Buffer, token = TOKEN): Promise<SyncResponse> {
  const id = await open(call, token);
  const parts = await sendParts(call, id, blob, token);
  return call({ method: 'POST', path: `/api/blob/uploads/${id}/commit`, body: commitBody(base, blob, parts) }, token);
}

async function pull(call: Call): Promise<Buffer> {
  const status = body(await call({ path: '/api/status' }));
  const id = status.upload_id as string;
  const chunks: Buffer[] = [];
  for (let n = 0; n < (status.parts as number); n++) {
    const r = await call({ path: `/api/blob/uploads/${id}/parts/${n}` });
    expect(r.status).toBe(200);
    chunks.push(r.body as Buffer);
  }
  return Buffer.concat(chunks);
}

const kinds: Array<[string, () => Promise<{ storage: Storage; close: () => Promise<void> }>]> = [
  ['in-memory', async () => ({ storage: new InMemoryStorage(), close: async () => {} })],
  [
    'postgres (PGlite)',
    async () => {
      const db = new PGlite();
      return { storage: new NeonStorage(pgliteAsNeon(db)), close: () => db.close() };
    },
  ],
];

for (const [kind, make] of kinds) {
  describe(`parts protocol on ${kind}`, () => {
    let storage: Storage;
    let close: () => Promise<void>;
    let call: Call;

    beforeEach(async () => {
      ({ storage, close } = await make());
      call = caller(storage);
    });
    afterEach(async () => close());

    it('round-trips a 7 MiB vault in parts and reports it in status', async () => {
      const blob = vault(7 * 1024 * 1024);
      const r = await push(call, 0, blob);
      expect(r.status).toBe(200);
      expect(body(r).version).toBe(1);
      const status = body(await call({ path: '/api/status' }));
      expect(status).toMatchObject({ version: 1, size: blob.length, sha256: sha(blob), parts: 3, cap_bytes: CAP });
      expect((await pull(call)).equals(blob)).toBe(true);
    });

    it('a stale base conflicts and leaves the current version readable', async () => {
      const v1 = vault(5 * 1024 * 1024, 1);
      expect((await push(call, 0, v1)).status).toBe(200);
      const v2 = vault(5 * 1024 * 1024, 2);
      expect((await push(call, 1, v2)).status).toBe(200);
      const stale = await push(call, 1, vault(5 * 1024 * 1024, 3));
      expect(stale.status).toBe(409);
      expect(body(stale).version).toBe(2);
      expect((await pull(call)).equals(v2)).toBe(true);
    });

    it('a duplicate first push in parts is a conflict, not an overwrite', async () => {
      expect((await push(call, 0, vault(5 * 1024 * 1024, 1))).status).toBe(200);
      const again = await push(call, 0, vault(5 * 1024 * 1024, 2));
      expect(again.status).toBe(409);
      expect(body(again).version).toBe(1);
    });

    it('opening a second upload replaces the first; committing the first is refused', async () => {
      const blob = vault(4 * 1024 * 1024 + 10);
      const first = await open(call);
      const parts = await sendParts(call, first, blob);
      await open(call);
      const r = await call({ method: 'POST', path: `/api/blob/uploads/${first}/commit`, body: commitBody(0, blob, parts) });
      expect(r.status).toBe(409);
      expect(body(r).replaced).toBe(true);
      expect((await call({ path: '/api/status' })).status).toBe(404);
    });

    it('refuses missing parts, a wrong hash, and a short middle part', async () => {
      const blob = vault(7 * 1024 * 1024);
      const id = await open(call);
      const parts = split(blob);
      await call({ method: 'PUT', path: `/api/blob/uploads/${id}/0`, body: parts[0] });
      await call({ method: 'PUT', path: `/api/blob/uploads/${id}/2`, body: parts[2] });
      const missing = await call({ method: 'POST', path: `/api/blob/uploads/${id}/commit`, body: commitBody(0, blob, 3) });
      expect(missing.status).toBe(400);

      await call({ method: 'PUT', path: `/api/blob/uploads/${id}/1`, body: parts[1] });
      const wrong = Buffer.from(JSON.stringify({ base: 0, parts: 3, size: blob.length, sha256: 'c'.repeat(64) }));
      expect((await call({ method: 'POST', path: `/api/blob/uploads/${id}/commit`, body: wrong })).status).toBe(400);

      const short = await open(call);
      await call({ method: 'PUT', path: `/api/blob/uploads/${short}/0`, body: parts[0]!.subarray(0, 100) });
      await call({ method: 'PUT', path: `/api/blob/uploads/${short}/1`, body: parts[1] });
      const odd = Buffer.concat([parts[0]!.subarray(0, 100), parts[1]!]);
      const r = await call({ method: 'POST', path: `/api/blob/uploads/${short}/commit`, body: commitBody(0, odd, 2) });
      expect(r.status).toBe(400);
    });

    it('parts are write-once: a resend of a part keeps the first bytes', async () => {
      const blob = vault(4 * 1024 * 1024 + 10);
      const id = await open(call);
      const parts = await sendParts(call, id, blob);
      const tampered = Buffer.alloc(PART_BYTES, 0x41);
      expect((await call({ method: 'PUT', path: `/api/blob/uploads/${id}/0`, body: tampered })).status).toBe(200);
      const r = await call({ method: 'POST', path: `/api/blob/uploads/${id}/commit`, body: commitBody(0, blob, parts) });
      expect(r.status).toBe(200);
      expect((await pull(call)).equals(blob)).toBe(true);
    });

    it("another account cannot write to, commit, or read this account's upload", async () => {
      const blob = vault(4 * 1024 * 1024 + 10);
      const id = await open(call);
      const parts = await sendParts(call, id, blob);
      const put = await call({ method: 'PUT', path: `/api/blob/uploads/${id}/1`, body: Buffer.from('x') }, OTHER);
      expect(put.status).toBe(409);
      const commit = await call(
        { method: 'POST', path: `/api/blob/uploads/${id}/commit`, body: commitBody(0, blob, parts) },
        OTHER,
      );
      expect(commit.status).toBe(409);
      expect((await call({ method: 'POST', path: `/api/blob/uploads/${id}/commit`, body: commitBody(0, blob, parts) })).status).toBe(200);
      expect((await call({ path: `/api/blob/uploads/${id}/parts/0` }, OTHER)).status).toBe(410);
    });

    it('a pull that spans a push still reads the version it started on', async () => {
      const v1 = vault(5 * 1024 * 1024, 1);
      await push(call, 0, v1);
      const status = body(await call({ path: '/api/status' }));
      const id = status.upload_id as string;
      const first = (await call({ path: `/api/blob/uploads/${id}/parts/0` })).body as Buffer;
      await push(call, 1, vault(5 * 1024 * 1024, 2));
      await push(call, 2, vault(5 * 1024 * 1024, 3));
      const second = (await call({ path: `/api/blob/uploads/${id}/parts/1` })).body as Buffer;
      expect(Buffer.concat([first, second]).equals(v1)).toBe(true);
    });

    it('the single GET refuses a vault stored in parts; a single PUT returns to one row', async () => {
      await push(call, 0, vault(5 * 1024 * 1024));
      const old = await call({ path: '/api/blob' });
      expect(old.status).toBe(409);
      const small = vault(1000, 9);
      const put = await call({ method: 'PUT', path: '/api/blob', baseVersion: 1, body: small });
      expect(put.status).toBe(200);
      expect(body(put).version).toBe(2);
      const get = await call({ path: '/api/blob' });
      expect(get.status).toBe(200);
      expect((get.body as Buffer).equals(small)).toBe(true);
      expect(body(await call({ path: '/api/status' }))).toMatchObject({ version: 2, upload_id: null, parts: 0 });
    });

    it('single PUT and parts share one version counter', async () => {
      await call({ method: 'PUT', path: '/api/blob', baseVersion: 0, body: vault(1000) });
      expect(body(await push(call, 1, vault(5 * 1024 * 1024))).version).toBe(2);
      const put = await call({ method: 'PUT', path: '/api/blob', baseVersion: 1, body: vault(1000, 2) });
      expect(put.status).toBe(409);
      expect(body(put).version).toBe(2);
    });

    it('refuses a commit over the cap and a part over the part size', async () => {
      const id = await open(call);
      const over = Buffer.from(JSON.stringify({ base: 0, parts: 4, size: CAP + 1, sha256: 'c'.repeat(64) }));
      expect((await call({ method: 'POST', path: `/api/blob/uploads/${id}/commit`, body: over })).status).toBe(413);
      const big = Buffer.alloc(PART_BYTES + 1, 1);
      expect((await call({ method: 'PUT', path: `/api/blob/uploads/${id}/0`, body: big })).status).toBe(400);
      expect((await call({ method: 'PUT', path: `/api/blob/uploads/${id}/4`, body: Buffer.from('x') })).status).toBe(404);
    });

    it('status never needs the blob', async () => {
      await push(call, 0, vault(5 * 1024 * 1024));
      const original = storage.get.bind(storage);
      storage.get = async () => {
        throw new Error('status read the blob');
      };
      expect((await call({ path: '/api/status' })).status).toBe(200);
      storage.get = original;
    });
  });
}

describe('upload retention (in-memory clock)', () => {
  it('keeps at most three superseded versions, each for ten minutes', async () => {
    const storage = new InMemoryStorage();
    let now = 1_000_000;
    storage.now = () => now;
    const call = caller(storage);
    const ids: string[] = [];
    for (let v = 0; v < 5; v++) {
      await push(call, v, vault(4 * 1024 * 1024 + 10, v));
      ids.push(body(await call({ path: '/api/status' })).upload_id as string);
      now += 1000;
    }
    const readable = async (id: string) => (await call({ path: `/api/blob/uploads/${id}/parts/0` })).status === 200;
    expect(await readable(ids[0]!)).toBe(false);
    expect(await Promise.all(ids.slice(1).map(readable))).toEqual([true, true, true, true]);
    now += 11 * 60 * 1000;
    await open(call);
    expect(await Promise.all(ids.slice(1, 4).map(readable))).toEqual([false, false, false]);
    expect(await readable(ids[4]!)).toBe(true);
  });
});
