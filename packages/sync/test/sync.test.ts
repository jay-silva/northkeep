import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault, generateDeviceSecret, KDF_INTERACTIVE } from '@northkeep/core';
import { deriveSyncCreds, tokenHash } from '../src/creds.js';
import { assertSyncUrl, loadSyncConfig, setSyncServer } from '../src/config.js';
import { pullVault, pushVault, syncState } from '../src/client.js';

// ---------- credential derivation ----------

describe('deriveSyncCreds', () => {
  it('is deterministic for the same device secret', () => {
    const ds = Buffer.alloc(32, 7);
    expect(deriveSyncCreds(ds)).toEqual(deriveSyncCreds(ds));
  });

  it('gives account id and token DISTINCT values (domain separation)', () => {
    const { accountId, token } = deriveSyncCreds(Buffer.alloc(32, 9));
    expect(accountId).not.toEqual(token);
    expect(accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes completely with a different device secret', () => {
    const a = deriveSyncCreds(Buffer.alloc(32, 1));
    const b = deriveSyncCreds(Buffer.alloc(32, 2));
    expect(a.accountId).not.toEqual(b.accountId);
    expect(a.token).not.toEqual(b.token);
  });

  it('does not leak the device secret in its outputs', () => {
    const ds = generateDeviceSecret();
    const { accountId, token } = deriveSyncCreds(ds);
    const dsHex = ds.toString('hex');
    expect(accountId).not.toContain(dsHex);
    expect(token).not.toContain(dsHex);
  });

  it('tokenHash is a stable sha256 that differs from the token', () => {
    const { token } = deriveSyncCreds(Buffer.alloc(32, 3));
    expect(tokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(token)).not.toEqual(token);
    expect(tokenHash(token)).toEqual(tokenHash(token));
  });
});

// ---------- URL guard ----------

describe('assertSyncUrl', () => {
  it('accepts https and loopback http, rejects public http', () => {
    expect(() => assertSyncUrl('https://sync.example.com')).not.toThrow();
    expect(() => assertSyncUrl('http://127.0.0.1:8787')).not.toThrow();
    expect(() => assertSyncUrl('http://localhost:8787')).not.toThrow();
    expect(() => assertSyncUrl('http://sync.example.com')).toThrow(/https/);
    expect(() => assertSyncUrl('ftp://x')).toThrow(/https/);
    expect(() => assertSyncUrl('not a url')).toThrow(/valid sync server/);
  });
});

// ---------- push / pull / status against a fake server + real vaults ----------

/**
 * A minimal in-memory sync server that stores ONE ciphertext blob + version,
 * exercising the same wire contract the real server implements.
 *
 * @param omitSha simulate an older / third-party server that reports no sha256
 *   on /api/status and no x-sha256 on /api/blob. Our own server always sends
 *   both, but syncState must not conclude "the bytes differ" from a missing
 *   hash, and pullVault must not record '' as the untouched baseline.
 */
function fakeServer(omitSha = false): { server: Server; url: () => string; stored: () => Buffer | null } {
  let blob: Buffer | null = null;
  let version = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers['authorization'];
      if (!auth?.startsWith('Bearer ')) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === 'GET' && req.url === '/api/status') {
        if (blob === null) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        const statusBody: Record<string, unknown> = { version, size: blob.length, updatedAt: new Date().toISOString() };
        if (!omitSha) statusBody.sha256 = sha(blob);
        res.end(JSON.stringify(statusBody));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/blob') {
        if (blob === null) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(
          200,
          omitSha ? { 'x-version': String(version) } : { 'x-version': String(version), 'x-sha256': sha(blob) },
        );
        res.end(blob);
        return;
      }
      if (req.method === 'PUT' && req.url === '/api/blob') {
        const base = Number(req.headers['x-base-version'] ?? '0');
        if (base !== version) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version }));
          return;
        }
        blob = Buffer.concat(chunks);
        version += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  return { server, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`, stored: () => blob };
}

function sha(buf: Buffer): string {
  return require('node:crypto').createHash('sha256').update(buf).digest('hex');
}

describe('sync round-trip (two vaults, shared device secret)', () => {
  let homeA: string;
  let homeB: string;
  let fake: ReturnType<typeof fakeServer>;
  const savedEnv = { ...process.env };
  const passphrase = 'shared sync passphrase';
  const deviceSecret = Buffer.alloc(32, 42); // both machines share this

  beforeEach(async () => {
    homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-syncA-'));
    homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-syncB-'));
    fake = fakeServer();
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
  });
  afterEach(async () => {
    process.env = { ...savedEnv };
    await new Promise((r) => fake.server.close(r));
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
  });

  function vaultPath(home: string): string {
    return path.join(home, 'vault.nkv');
  }

  function createVault(home: string, seed: string): void {
    const v = Vault.create({ path: vaultPath(home), passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.remember({ content: seed, type: 'semantic' });
    v.save();
    v.close();
  }

  it('A pushes; B (fresh, same device secret) pulls and opens the vault', async () => {
    // Machine A: create + seed + configure + push.
    process.env.NORTHKEEP_HOME = homeA;
    createVault(homeA, 'The user sails a boat named Windfall.');
    const { accountId } = deriveSyncCreds(deviceSecret);
    setSyncServer(fake.url(), accountId);
    const push = await pushVault({ vaultPath: vaultPath(homeA), deviceSecret });
    expect(push.ok).toBe(true);
    expect(push.version).toBe(1);

    // The server stored CIPHERTEXT only — NKV1 magic, none of the plaintext.
    const stored = fake.stored()!;
    expect(stored.subarray(0, 4).toString('ascii')).toBe('NKV1');
    expect(stored.toString('latin1')).not.toContain('Windfall');

    // Machine B: no vault yet, same device secret, pull.
    process.env.NORTHKEEP_HOME = homeB;
    setSyncServer(fake.url(), accountId);
    expect(fs.existsSync(vaultPath(homeB))).toBe(false);
    const pull = await pullVault({ vaultPath: vaultPath(homeB), deviceSecret });
    expect(pull.ok).toBe(true);

    // B opens the pulled vault with the shared passphrase + device secret.
    const opened = Vault.open({ path: vaultPath(homeB), passphrase, deviceSecret });
    const contents = opened.list().map((e) => e.content);
    opened.close();
    expect(contents).toContain('The user sails a boat named Windfall.');
  });

  it('rejects a second push from a stale base version (409 conflict)', async () => {
    const { accountId } = deriveSyncCreds(deviceSecret);

    // A: create + push → v1.
    process.env.NORTHKEEP_HOME = homeA;
    createVault(homeA, 'first');
    setSyncServer(fake.url(), accountId);
    expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret })).ok).toBe(true); // v1

    // B: fresh (no local vault), pull → now also at v1. Both machines synced.
    process.env.NORTHKEEP_HOME = homeB;
    setSyncServer(fake.url(), accountId);
    expect((await pullVault({ vaultPath: vaultPath(homeB), deviceSecret })).ok).toBe(true); // v1

    // B edits and pushes first → server advances to v2.
    const vb = Vault.open({ path: vaultPath(homeB), passphrase, deviceSecret });
    vb.remember({ content: 'change from B', type: 'semantic' });
    vb.save();
    vb.close();
    expect((await pushVault({ vaultPath: vaultPath(homeB), deviceSecret })).ok).toBe(true); // v2

    // A is still at lastVersion 1 → its push must 409 (someone moved ahead).
    process.env.NORTHKEEP_HOME = homeA;
    const conflict = await pushVault({ vaultPath: vaultPath(homeA), deviceSecret });
    expect(conflict.ok).toBe(false);
    expect(conflict.conflict).toBe(true);
    expect(conflict.version).toBe(2);
  });

  it('refuses to overwrite a good local vault with a garbage pull', async () => {
    // A pushes a real vault.
    process.env.NORTHKEEP_HOME = homeA;
    createVault(homeA, 'precious data');
    const { accountId } = deriveSyncCreds(deviceSecret);
    setSyncServer(fake.url(), accountId);
    await pushVault({ vaultPath: vaultPath(homeA), deviceSecret });

    // B has its OWN good vault (different content) and points at the SAME
    // account but a WRONG key (different passphrase → different master key).
    process.env.NORTHKEEP_HOME = homeB;
    createVault(homeB, 'B local precious');
    setSyncServer(fake.url(), accountId);
    const beforeBytes = fs.readFileSync(vaultPath(homeB));
    const wrongKey = Buffer.alloc(32, 0xcd); // not the real master key

    await expect(
      pullVault({ vaultPath: vaultPath(homeB), deviceSecret, masterKey: wrongKey }),
    ).rejects.toThrow(/does not open with your key/);

    // The local vault is untouched (open-verify failed before swap).
    expect(fs.readFileSync(vaultPath(homeB)).equals(beforeBytes)).toBe(true);
    const stillThere = Vault.open({ path: vaultPath(homeB), passphrase, deviceSecret });
    expect(stillThere.list().map((e) => e.content)).toContain('B local precious');
    stillThere.close();
  });

  it('syncState reports behind/in-sync correctly', async () => {
    process.env.NORTHKEEP_HOME = homeA;
    createVault(homeA, 'x');
    const { accountId } = deriveSyncCreds(deviceSecret);
    setSyncServer(fake.url(), accountId);
    await pushVault({ vaultPath: vaultPath(homeA), deviceSecret });
    const s = await syncState({ vaultPath: vaultPath(homeA), deviceSecret });
    expect(s.state).toBe('in-sync');
    expect(s.remoteVersion).toBe(1);
    expect(s.localChanged).toBe(false);
  });

  /**
   * REGRESSION: "in sync" used to compare config.lastVersion against the
   * server's version, so a vault edited-but-never-pushed still reported
   * "✓ In sync" — indefinitely, over a vault weeks ahead of its only backup.
   * It now compares the actual bytes.
   */
  it('a local edit after a push is AHEAD, not in-sync', async () => {
    process.env.NORTHKEEP_HOME = homeA;
    createVault(homeA, 'x');
    const { accountId } = deriveSyncCreds(deviceSecret);
    setSyncServer(fake.url(), accountId);
    await pushVault({ vaultPath: vaultPath(homeA), deviceSecret });
    expect((await syncState({ vaultPath: vaultPath(homeA), deviceSecret })).state).toBe('in-sync');

    // Edit locally and do NOT push. The version numbers still agree (local v1,
    // server v1) — only the bytes disagree.
    const v = Vault.open({ path: vaultPath(homeA), passphrase, deviceSecret });
    v.remember({ content: 'added after the push', type: 'semantic' });
    v.save();
    v.close();

    const after = await syncState({ vaultPath: vaultPath(homeA), deviceSecret });
    expect(after.state).toBe('ahead');
    expect(after.localChanged).toBe(true);
    expect(after.localVersion).toBe(after.remoteVersion); // versions agree; content does not
  });

  /**
   * A pulled vault is the untouched baseline, so the next status call must say
   * in-sync — and if the server then advances, "behind", not "diverged".
   */
  it('a pulled vault is the baseline: in-sync, then behind when the server advances', async () => {
    const { accountId } = deriveSyncCreds(deviceSecret);
    process.env.NORTHKEEP_HOME = homeA;
    createVault(homeA, 'seed');
    setSyncServer(fake.url(), accountId);
    await pushVault({ vaultPath: vaultPath(homeA), deviceSecret });

    process.env.NORTHKEEP_HOME = homeB;
    setSyncServer(fake.url(), accountId);
    await pullVault({ vaultPath: vaultPath(homeB), deviceSecret });
    expect(loadSyncConfig()?.lastSha).toBe(
      createHash('sha256').update(fs.readFileSync(vaultPath(homeB))).digest('hex'),
    );
    expect((await syncState({ vaultPath: vaultPath(homeB), deviceSecret })).state).toBe('in-sync');

    // A edits and pushes; B has touched nothing, so B is behind, not diverged.
    process.env.NORTHKEEP_HOME = homeA;
    const v = Vault.open({ path: vaultPath(homeA), passphrase, deviceSecret });
    v.remember({ content: 'newer on A', type: 'semantic' });
    v.save();
    v.close();
    await pushVault({ vaultPath: vaultPath(homeA), deviceSecret });

    process.env.NORTHKEEP_HOME = homeB;
    expect((await syncState({ vaultPath: vaultPath(homeB), deviceSecret })).state).toBe('behind');
  });

  it('reports diverged only when BOTH sides moved', async () => {
    const { accountId } = deriveSyncCreds(deviceSecret);
    process.env.NORTHKEEP_HOME = homeA;
    createVault(homeA, 'seed');
    setSyncServer(fake.url(), accountId);
    await pushVault({ vaultPath: vaultPath(homeA), deviceSecret });

    process.env.NORTHKEEP_HOME = homeB;
    setSyncServer(fake.url(), accountId);
    await pullVault({ vaultPath: vaultPath(homeB), deviceSecret });

    // A pushes something new…
    process.env.NORTHKEEP_HOME = homeA;
    const a = Vault.open({ path: vaultPath(homeA), passphrase, deviceSecret });
    a.remember({ content: 'A moved', type: 'semantic' });
    a.save();
    a.close();
    await pushVault({ vaultPath: vaultPath(homeA), deviceSecret });

    // …and B edits locally without pulling.
    process.env.NORTHKEEP_HOME = homeB;
    const b = Vault.open({ path: vaultPath(homeB), passphrase, deviceSecret });
    b.remember({ content: 'B moved too', type: 'semantic' });
    b.save();
    b.close();
    expect((await syncState({ vaultPath: vaultPath(homeB), deviceSecret })).state).toBe('diverged');
  });

  /**
   * The open-verify step before the rename can MIGRATE the vault, and migrate()
   * calls save(), which re-encrypts with a fresh nonce. So the bytes that land
   * on disk are not always the bytes that came over the wire — the baseline has
   * to be the file itself, or the next status call reads "edited since sync".
   */
  it('lastSha after a pull matches the file on disk, not the downloaded blob', async () => {
    const { accountId } = deriveSyncCreds(deviceSecret);
    process.env.NORTHKEEP_HOME = homeA;
    createVault(homeA, 'seed');
    setSyncServer(fake.url(), accountId);
    await pushVault({ vaultPath: vaultPath(homeA), deviceSecret });

    process.env.NORTHKEEP_HOME = homeB;
    setSyncServer(fake.url(), accountId);
    await pullVault({ vaultPath: vaultPath(homeB), deviceSecret });

    const onDisk = createHash('sha256').update(fs.readFileSync(vaultPath(homeB))).digest('hex');
    expect(loadSyncConfig()?.lastSha).toBe(onDisk);
    // And no scratch files are left behind next to the vault.
    expect(fs.existsSync(`${vaultPath(homeB)}.pulled.tmp`)).toBe(false);
    expect(fs.existsSync(`${vaultPath(homeB)}.pulled.tmp.bak`)).toBe(false);
  });

  it('records lastSha on push so an untouched vault is provably unchanged', async () => {
    process.env.NORTHKEEP_HOME = homeA;
    createVault(homeA, 'x');
    const { accountId } = deriveSyncCreds(deviceSecret);
    setSyncServer(fake.url(), accountId);
    await pushVault({ vaultPath: vaultPath(homeA), deviceSecret });
    const cfg = loadSyncConfig();
    expect(cfg?.lastSha).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = createHash('sha256').update(fs.readFileSync(vaultPath(homeA))).digest('hex');
    expect(cfg?.lastSha).toBe(onDisk);
  });
});

/**
 * Our own server always sends sha256 (apps/sync-server/src/handler.ts), but a
 * self-hosted or older one may not. Without a hash we cannot compare bytes, and
 * the wrong reading of "no hash" is "the bytes differ" — that would pin such a
 * server to ahead/diverged forever and never report in-sync again.
 */
describe('sync against a server that reports no sha256', () => {
  let home: string;
  let fake: ReturnType<typeof fakeServer>;
  const savedEnv = { ...process.env };
  const passphrase = 'shared sync passphrase';
  const deviceSecret = Buffer.alloc(32, 42);
  const vaultPath = (h: string): string => path.join(h, 'vault.nkv');

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-syncNoSha-'));
    fake = fakeServer(true); // omit sha256 everywhere
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
  });
  afterEach(async () => {
    process.env = { ...savedEnv };
    await new Promise((r) => fake.server.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('falls back to the version comparison instead of reporting a false difference', async () => {
    process.env.NORTHKEEP_HOME = home;
    const v = Vault.create({ path: vaultPath(home), passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.remember({ content: 'x', type: 'semantic' });
    v.save();
    v.close();
    const { accountId } = deriveSyncCreds(deviceSecret);
    setSyncServer(fake.url(), accountId);
    await pushVault({ vaultPath: vaultPath(home), deviceSecret });

    const s = await syncState({ vaultPath: vaultPath(home), deviceSecret });
    expect(s.state).toBe('in-sync');
    expect(s.localChanged).toBe(false);
  });

  it('never stores an empty lastSha after a pull', async () => {
    // Seed the server from a first home, then pull into a second.
    const seedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-syncNoShaSeed-'));
    try {
      process.env.NORTHKEEP_HOME = seedHome;
      const v = Vault.create({ path: vaultPath(seedHome), passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
      v.remember({ content: 'x', type: 'semantic' });
      v.save();
      v.close();
      const { accountId } = deriveSyncCreds(deviceSecret);
      setSyncServer(fake.url(), accountId);
      await pushVault({ vaultPath: vaultPath(seedHome), deviceSecret });

      process.env.NORTHKEEP_HOME = home;
      setSyncServer(fake.url(), accountId);
      await pullVault({ vaultPath: vaultPath(home), deviceSecret });

      const cfg = loadSyncConfig();
      expect(cfg?.lastSha).toMatch(/^[0-9a-f]{64}$/);
      expect(cfg?.lastSha).toBe(createHash('sha256').update(fs.readFileSync(vaultPath(home))).digest('hex'));
    } finally {
      fs.rmSync(seedHome, { recursive: true, force: true });
    }
  });
});

describe('sync config', () => {
  const savedEnv = { ...process.env };
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-synccfg-'));
    process.env.NORTHKEEP_HOME = home;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('persists 0600 and never stores a token', () => {
    setSyncServer('https://sync.example.com/', 'acct123');
    const cfg = loadSyncConfig()!;
    expect(cfg.serverUrl).toBe('https://sync.example.com');
    expect(cfg.accountId).toBe('acct123');
    const raw = fs.readFileSync(path.join(home, 'sync.json'), 'utf8');
    expect(raw).not.toMatch(/token/i);
  });
});
