import { describe, expect, it } from 'vitest';
import { handleSync, MAX_BLOB_BYTES, type SyncRequest } from '../src/handler.js';
import { InMemoryStorage } from '../src/storage.js';

/** A minimal well-formed vault blob: NKV1 magic + a full 52-byte header. */
function fakeVaultBlob(marker = 0xaa, size = 200): Buffer {
  const blob = Buffer.alloc(size, marker);
  Buffer.from('NKV1', 'ascii').copy(blob, 0);
  return blob;
}

const TOKEN = 'a'.repeat(64);

function req(partial: Partial<SyncRequest>): SyncRequest {
  return { method: 'GET', path: '/api/status', token: TOKEN, baseVersion: null, body: null, ...partial };
}

describe('handleSync', () => {
  it('rejects a missing/short token with 401', async () => {
    const s = new InMemoryStorage();
    expect((await handleSync(req({ token: null }), s)).status).toBe(401);
    expect((await handleSync(req({ token: 'short' }), s)).status).toBe(401);
  });

  it('404s status/blob before anything is pushed', async () => {
    const s = new InMemoryStorage();
    expect((await handleSync(req({ path: '/api/status' }), s)).status).toBe(404);
    expect((await handleSync(req({ path: '/api/blob' }), s)).status).toBe(404);
  });

  it('first push creates the account and round-trips the blob', async () => {
    const s = new InMemoryStorage();
    const blob = fakeVaultBlob();
    const put = await handleSync(req({ method: 'PUT', path: '/api/blob', baseVersion: 0, body: blob }), s);
    expect(put.status).toBe(200);
    expect((put.body as { version: number }).version).toBe(1);

    const get = await handleSync(req({ path: '/api/blob' }), s);
    expect(get.status).toBe(200);
    expect((get.body as Buffer).equals(blob)).toBe(true);
    expect(get.headers?.['x-version']).toBe('1');
  });

  it('enforces optimistic concurrency: stale base version → 409 with current version', async () => {
    const s = new InMemoryStorage();
    await handleSync(req({ method: 'PUT', path: '/api/blob', baseVersion: 0, body: fakeVaultBlob() }), s); // v1
    await handleSync(req({ method: 'PUT', path: '/api/blob', baseVersion: 1, body: fakeVaultBlob(0xbb) }), s); // v2
    const stale = await handleSync(req({ method: 'PUT', path: '/api/blob', baseVersion: 1, body: fakeVaultBlob(0xcc) }), s);
    expect(stale.status).toBe(409);
    expect((stale.body as { version: number }).version).toBe(2);
  });

  it('a duplicate first push (base 0 when a blob exists) is a 409, not an overwrite', async () => {
    const s = new InMemoryStorage();
    await handleSync(req({ method: 'PUT', path: '/api/blob', baseVersion: 0, body: fakeVaultBlob() }), s); // v1
    const again = await handleSync(req({ method: 'PUT', path: '/api/blob', baseVersion: 0, body: fakeVaultBlob(0xbb) }), s);
    expect(again.status).toBe(409);
    expect((again.body as { version: number }).version).toBe(1);
  });

  it('isolates accounts: a different token cannot read the first account\'s blob', async () => {
    const s = new InMemoryStorage();
    await handleSync(req({ method: 'PUT', path: '/api/blob', baseVersion: 0, body: fakeVaultBlob() }), s);
    const other = await handleSync(req({ path: '/api/blob', token: 'b'.repeat(64) }), s);
    expect(other.status).toBe(404); // no blob under the other token
  });

  it('rejects a body that is not a NorthKeep vault blob (400)', async () => {
    const s = new InMemoryStorage();
    const notAVault = Buffer.alloc(200, 0x00); // no NKV1 magic
    const put = await handleSync(req({ method: 'PUT', path: '/api/blob', baseVersion: 0, body: notAVault }), s);
    expect(put.status).toBe(400);
  });

  it('rejects an oversized blob (413)', async () => {
    const s = new InMemoryStorage();
    const huge = fakeVaultBlob(0xaa, MAX_BLOB_BYTES + 1);
    const put = await handleSync(req({ method: 'PUT', path: '/api/blob', baseVersion: 0, body: huge }), s);
    expect(put.status).toBe(413);
  });

  it('rejects PUT with a missing base version (400)', async () => {
    const s = new InMemoryStorage();
    const put = await handleSync(req({ method: 'PUT', path: '/api/blob', baseVersion: null, body: fakeVaultBlob() }), s);
    expect(put.status).toBe(400);
  });

  it('allowlist: a private server rejects non-listed accounts with 403', async () => {
    const s = new InMemoryStorage();
    const { createHash } = await import('node:crypto');
    const allowed = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
    const opts = { allowedTokenHashes: new Set([allowed]) };

    // The listed token works…
    const ok = await handleSync(req({ method: 'PUT', path: '/api/blob', baseVersion: 0, body: fakeVaultBlob() }), s, opts);
    expect(ok.status).toBe(200);
    // …a different token is refused outright (before any storage access).
    const denied = await handleSync(req({ path: '/api/status', token: 'z'.repeat(64) }), s, opts);
    expect(denied.status).toBe(403);
  });

  it('unknown routes 404 before the access gate — no subscription lookup, no auth probe (review H1)', async () => {
    const s = new InMemoryStorage();
    let gateCalls = 0;
    const opts = {
      subscriptionActive: async () => {
        gateCalls++;
        return false;
      },
    };
    // A non-subscribed token on an unserved path must get 404, not 402, and
    // must not cost a subscription (DB) lookup.
    expect((await handleSync(req({ path: '/x' }), s, opts)).status).toBe(404);
    expect((await handleSync(req({ method: 'PUT', path: '/x', body: fakeVaultBlob() }), s, opts)).status).toBe(404);
    expect((await handleSync(req({ method: 'POST', path: '/api/status' }), s, opts)).status).toBe(404);
    expect(gateCalls).toBe(0);
    // Tokenless unknown path is also a plain 404 (no 401 auth oracle).
    expect((await handleSync(req({ path: '/x', token: null }), s, opts)).status).toBe(404);
    // Known routes still hit the gate and 402.
    expect((await handleSync(req({ path: '/api/status' }), s, opts)).status).toBe(402);
    expect(gateCalls).toBe(1);
  });

  it('parseAllowlist parses hashes and returns null when unset', async () => {
    const { parseAllowlist } = await import('../src/handler.js');
    expect(parseAllowlist(undefined)).toBeNull();
    expect(parseAllowlist('')).toBeNull();
    const set = parseAllowlist(`${'a'.repeat(64)}, ${'b'.repeat(64)}`);
    expect(set?.size).toBe(2);
    expect(set?.has('a'.repeat(64))).toBe(true);
  });
});
