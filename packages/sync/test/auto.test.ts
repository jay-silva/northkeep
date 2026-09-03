import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault, deriveMasterKey, onVaultSave, KDF_INTERACTIVE } from '@northkeep/core';
import { AutoSync, DIVERGED_MESSAGE, syncAge, type AutoSyncEvent } from '../src/auto.js';
import { deriveSyncCreds } from '../src/creds.js';
import { loadSyncConfig, setSyncServer } from '../src/config.js';
import { pullVault, pushVault } from '../src/client.js';

/**
 * ADR 0044 engine tests. A fake ciphertext-only server (same wire contract as
 * apps/sync-server) plus real vaults on disk. "Another device" is a second
 * NORTHKEEP_HOME that pushes straight through pushVault.
 */

type Mode = 'ok' | 'subscription' | 'crash' | 'slow-blob' | 'garbage-blob' | 'slow-put';

function fakeServer(): {
  server: Server;
  url: () => string;
  version: () => number;
  mode: (m: Mode) => void;
  omitSha: (v: boolean) => void;
} {
  let blob: Buffer | null = null;
  let version = 0;
  let mode: Mode = 'ok';
  let noSha = false;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (mode === 'crash') {
        res.writeHead(500).end();
        return;
      }
      if (mode === 'subscription') {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'subscribe', subscribe: true }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/status') {
        if (blob === null) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        const junkStatus = mode === 'garbage-blob';
        const junk = Buffer.concat([Buffer.from('NKV1'), Buffer.alloc(200, 9)]);
        const statusBody: Record<string, unknown> = {
          version: junkStatus ? version + 5 : version,
          size: blob.length,
          updatedAt: new Date().toISOString(),
        };
        if (!noSha) statusBody.sha256 = junkStatus ? sha(junk) : sha(blob);
        res.end(JSON.stringify(statusBody));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/blob') {
        if (blob === null) {
          res.writeHead(404).end();
          return;
        }
        if (mode === 'garbage-blob') {
          const junk = Buffer.concat([Buffer.from('NKV1'), Buffer.alloc(200, 9)]);
          res.writeHead(200, { 'x-version': String(version + 5), 'x-sha256': sha(junk) });
          res.end(junk);
          return;
        }
        const send = () => {
          res.writeHead(200, noSha ? { 'x-version': String(version) } : { 'x-version': String(version), 'x-sha256': sha(blob!) });
          res.end(blob);
        };
        if (mode === 'slow-blob') setTimeout(send, 400);
        else send();
        return;
      }
      if (req.method === 'PUT' && req.url === '/api/blob') {
        const base = Number(req.headers['x-base-version'] ?? '0');
        if (base !== version) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version }));
          return;
        }
        const accept = () => {
          blob = Buffer.concat(chunks);
          version += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version }));
        };
        if (mode === 'slow-put') setTimeout(accept, 400);
        else accept();
        return;
      }
      res.writeHead(404).end();
    });
  });
  return {
    server,
    url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    version: () => version,
    mode: (m) => {
      mode = m;
    },
    omitSha: (v) => {
      noSha = v;
    },
  };
}

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('AutoSync (ADR 0044)', () => {
  const passphrase = 'auto sync passphrase';
  const deviceSecret = Buffer.alloc(32, 7);
  const savedEnv = { ...process.env };
  let homeA: string;
  let homeB: string;
  let fake: ReturnType<typeof fakeServer>;
  let engines: AutoSync[] = [];
  let unsubscribe: (() => void) | null = null;

  beforeEach(async () => {
    homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-autoA-'));
    homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-autoB-'));
    fake = fakeServer();
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
    process.env.NORTHKEEP_HOME = homeA;
  });
  afterEach(async () => {
    for (const e of engines) e.stop();
    engines = [];
    unsubscribe?.();
    unsubscribe = null;
    process.env = { ...savedEnv };
    await new Promise((r) => fake.server.close(r));
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
  });

  const vaultPath = (home: string) => path.join(home, 'vault.nkv');
  const keyFor = (home: string): Buffer => {
    const header = Vault.readHeader(vaultPath(home));
    return deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf);
  };
  function createVault(home: string, seed: string): void {
    const v = Vault.create({ path: vaultPath(home), passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.remember({ content: seed, type: 'semantic' });
    v.save();
    v.close();
  }
  function write(home: string, content: string): void {
    const v = Vault.openWithKey(vaultPath(home), keyFor(home));
    v.remember({ content, type: 'semantic' });
    v.save();
    v.close();
  }
  function contents(home: string): string[] {
    const v = Vault.openWithKey(vaultPath(home), keyFor(home));
    const out = v.list().map((e) => e.content);
    v.close();
    return out;
  }
  function configure(home: string): void {
    const { accountId } = deriveSyncCreds(deviceSecret);
    const prev = process.env.NORTHKEEP_HOME;
    process.env.NORTHKEEP_HOME = home;
    setSyncServer(fake.url(), accountId);
    process.env.NORTHKEEP_HOME = prev;
  }
  /** "Another device": home B pulls the current vault, edits it, pushes; A's env is restored after. */
  async function otherDevicePushes(content: string): Promise<void> {
    process.env.NORTHKEEP_HOME = homeB;
    try {
      if (!fs.existsSync(vaultPath(homeB))) {
        expect((await pullVault({ vaultPath: vaultPath(homeB), deviceSecret })).ok).toBe(true);
      }
      write(homeB, content);
      const r = await pushVault({ vaultPath: vaultPath(homeB), deviceSecret, masterKey: keyFor(homeB) });
      expect(r.ok).toBe(true);
    } finally {
      process.env.NORTHKEEP_HOME = homeA;
    }
  }
  function engine(opts: { locked?: () => boolean; debounceMs?: number; backoffMs?: number[] } = {}): {
    auto: AutoSync;
    events: AutoSyncEvent[];
  } {
    const events: AutoSyncEvent[] = [];
    const auto = new AutoSync({
      vaultPath: vaultPath(homeA),
      getMasterKey: () => (opts.locked?.() ? null : keyFor(homeA)),
      loadDeviceSecret: () => Buffer.from(deviceSecret),
      onEvent: (e) => events.push(e),
      debounceMs: opts.debounceMs ?? 30,
      backoffMs: opts.backoffMs ?? [40, 40],
    });
    // Wire it the way the hosts do: core's save hook feeds notifyWrite.
    unsubscribe = onVaultSave((p) => auto.notifyWrite(p));
    engines.push(auto);
    return { auto, events };
  }

  it('a write becomes one debounced push, and the push does not re-trigger itself', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    const { auto, events } = engine();
    write(homeA, 'one');
    write(homeA, 'two'); // second write inside the debounce window
    expect(auto.status().phase).toBe('pending');
    await sleep(80);
    await auto.flush();
    expect(fake.version()).toBe(1); // one upload for two writes
    expect(events.filter((e) => e.type === 'pushed')).toHaveLength(1);
    expect(auto.status().phase).toBe('synced');
    // pushVault saved the vault (generation bump); that save must not queue another push.
    await sleep(80);
    expect(fake.version()).toBe(1);
    expect(auto.status().phase).toBe('synced');
    expect(loadSyncConfig()?.lastSyncedAt).toBeTruthy();
  });

  it('wake fast-forwards when the server is ahead and this vault is untouched', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    configure(homeB);
    const { auto, events } = engine({ debounceMs: 10_000 });
    // A pushes v1 by hand (engine off the critical path), then B moves the server to v2.
    const manual = await auto.runManual(() =>
      pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }),
    );
    expect(manual.ok).toBe(true);
    expect(auto.status().phase).toBe('synced'); // a manual push is not a pending write
    await otherDevicePushes('written on the phone');
    expect(fake.version()).toBe(2);

    await auto.wake();
    expect(events.some((e) => e.type === 'pulled' && e.version === 2)).toBe(true);
    expect(contents(homeA)).toContain('written on the phone');
    expect(fs.existsSync(`${vaultPath(homeA)}.bak`)).toBe(true); // the displaced copy is kept
    expect(auto.status().phase).toBe('synced');
    expect(auto.status().state).toBe('in-sync');
  });

  it('wake refuses to pull over local edits: diverged is reported, the local vault is intact', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    configure(homeB);
    const { auto, events } = engine({ debounceMs: 60_000 }); // the local write is never pushed
    await auto.runManual(() => pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }));
    write(homeA, 'local edit that must survive');
    await otherDevicePushes('remote edit');

    await auto.wake();
    expect(events.some((e) => e.type === 'pulled')).toBe(false);
    expect(events.some((e) => e.type === 'diverged')).toBe(true);
    expect(auto.status().message).toBe(DIVERGED_MESSAGE);
    expect(contents(homeA)).toContain('local edit that must survive');
    expect(contents(homeA)).not.toContain('remote edit');
    expect(fake.version()).toBe(2); // nothing was pushed either
  });

  it('wake with no recorded baseline is treated as edited: no automatic pull', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    configure(homeB);
    const { auto, events } = engine({ debounceMs: 60_000 });
    await auto.runManual(() => pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }));
    // Simulate a config written before lastSha existed.
    const cfgPath = path.join(homeA, 'sync.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    delete cfg.lastSha;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    await otherDevicePushes('remote edit');

    await auto.wake();
    expect(events.some((e) => e.type === 'pulled')).toBe(false);
    expect(contents(homeA)).not.toContain('remote edit');
  });

  it('wake pushes when this vault is ahead (edits made while the engine was not running)', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);
    write(homeA, 'offline edit'); // no engine yet, so no push
    const { auto, events } = engine({ debounceMs: 60_000 });
    await auto.wake();
    expect(events.some((e) => e.type === 'pushed' && e.version === 2)).toBe(true);
    expect(fake.version()).toBe(2);
  });

  it('a first wake on an empty server pushes the vault', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    const { auto } = engine({ debounceMs: 60_000 });
    await auto.wake();
    expect(fake.version()).toBe(1);
  });

  it('nothing runs while locked; the write stays pending and the next unlock drains it', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    let locked = true;
    const { auto } = engine({ locked: () => locked });
    write(homeA, 'written while locked');
    await sleep(80);
    await auto.flush();
    expect(fake.version()).toBe(0);
    expect(auto.status().phase).toBe('pending');
    locked = false;
    await auto.wake(); // unlock → wake: ahead of an empty server → push
    expect(fake.version()).toBe(1);
    expect(auto.status().phase).toBe('synced');
  });

  it('402 pauses the engine (no retry timer) and resume() lifts it', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    fake.mode('subscription');
    const { auto, events } = engine();
    write(homeA, 'edit');
    await sleep(80);
    await auto.flush();
    expect(auto.status().phase).toBe('paused');
    expect(auto.status().pausedReason).toBe('subscription');
    expect(auto.status().nextRetryAt).toBeNull();
    expect(events.some((e) => e.type === 'paused')).toBe(true);
    await sleep(120); // longer than the backoff: still nothing, because paused
    expect(fake.version()).toBe(0);

    fake.mode('ok');
    auto.resume();
    await sleep(80);
    await auto.flush();
    expect(fake.version()).toBe(1);
    expect(auto.status().phase).toBe('synced');
  });

  it('a server failure backs off and retries; a write during backoff waits; stop() clears the retry', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    fake.mode('crash');
    const { auto } = engine({ debounceMs: 20, backoffMs: [600, 600] });
    write(homeA, 'edit');
    await sleep(300); // the debounced attempt fails (open + save + upload takes tens of ms, more under load)
    expect(auto.status().phase).toBe('error');
    expect(auto.status().failures).toBe(1);
    expect(auto.status().nextRetryAt).not.toBeNull();
    write(homeA, 'another edit inside the backoff window');
    await sleep(100);
    expect(auto.status().failures).toBe(1); // no second attempt before the retry is due
    fake.mode('ok');
    await sleep(700); // the scheduled retry fires and succeeds
    expect(fake.version()).toBe(1);
    expect(auto.status().failures).toBe(0);
    expect(auto.status().phase).toBe('synced');

    fake.mode('crash');
    write(homeA, 'third');
    await sleep(300);
    expect(auto.status().nextRetryAt).not.toBeNull();
    auto.stop();
    expect(auto.status().nextRetryAt).toBeNull();
    await sleep(100); // let any in-flight attempt finish failing before the server recovers
    fake.mode('ok');
    await sleep(800);
    expect(fake.version()).toBe(1); // stopped engines do not retry
  });

  it('a fast-forward pull keeps its own copy that a later save does not overwrite', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    configure(homeB);
    const { auto, events } = engine({ debounceMs: 60_000 });
    await auto.runManual(() => pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }));
    const before = fs.readFileSync(vaultPath(homeA));
    await otherDevicePushes('remote edit');
    await auto.wake();
    const pulled = events.find((e) => e.type === 'pulled');
    expect(pulled && pulled.type === 'pulled' ? pulled.backupPath : null).toBe(`${vaultPath(homeA)}.auto-pull.bak`);
    expect(fs.readFileSync(`${vaultPath(homeA)}.auto-pull.bak`).equals(before)).toBe(true);
    expect(auto.status().lastPull?.version).toBe(2);
    write(homeA, 'a later local save'); // rolls vault.nkv.bak, must not touch the auto-pull copy
    expect(fs.readFileSync(`${vaultPath(homeA)}.auto-pull.bak`).equals(before)).toBe(true);
  });

  it('a write stream faster than the debounce still pushes within the maximum wait', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    const auto = new AutoSync({
      vaultPath: vaultPath(homeA),
      getMasterKey: () => keyFor(homeA),
      loadDeviceSecret: () => Buffer.from(deviceSecret),
      debounceMs: 80,
      maxWaitMs: 250,
    });
    engines.push(auto);
    unsubscribe = onVaultSave((p) => auto.notifyWrite(p));
    const started = Date.now();
    while (Date.now() - started < 600) {
      write(homeA, `burst ${Date.now()}`);
      await sleep(30);
    }
    expect(fake.version()).toBeGreaterThanOrEqual(1); // pushed mid-stream, not only after it stopped
  });

  it('with no remote hash, an edited vault is never fast-forwarded (no-sha server)', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    configure(homeB);
    const { auto, events } = engine({ debounceMs: 60_000 });
    await auto.runManual(() => pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }));
    write(homeA, 'local edit that must survive');
    await otherDevicePushes('remote edit');
    fake.omitSha(true);
    await auto.wake();
    expect(events.some((e) => e.type === 'pulled')).toBe(false);
    expect(events.some((e) => e.type === 'diverged')).toBe(true);
    expect(contents(homeA)).toContain('local edit that must survive');
  });

  it('a write that lands during the download is never buried: the pull is refused and the edit is pushed', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    configure(homeB);
    const { auto, events } = engine({ debounceMs: 60_000 });
    await auto.runManual(() => pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }));
    await otherDevicePushes('remote edit');
    fake.mode('slow-blob');
    const wake = auto.wake();
    await sleep(150); // the download is in flight; the vault lock is NOT held, so this write goes through
    write(homeA, 'written during the download');
    await wake;
    expect(events.some((e) => e.type === 'pulled')).toBe(false);
    expect(contents(homeA)).toContain('written during the download');
    expect(fs.existsSync(`${vaultPath(homeA)}.auto-pull.bak`)).toBe(false); // nothing was displaced, so no copy
    // Both sides changed now (the server has the remote edit, we have ours): reported, not resolved.
    expect(auto.status().state).toBe('diverged');
  });

  it('a rejected download never clobbers the auto-pull copy of an earlier pull', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    configure(homeB);
    const { auto } = engine({ debounceMs: 60_000, backoffMs: [60_000] });
    await auto.runManual(() => pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }));
    const before = fs.readFileSync(vaultPath(homeA));
    await otherDevicePushes('remote edit');
    await auto.wake(); // a real fast-forward: the copy holds the pre-pull bytes
    const backup = `${vaultPath(homeA)}.auto-pull.bak`;
    expect(fs.readFileSync(backup).equals(before)).toBe(true);
    fake.mode('garbage-blob'); // status still says the server is ahead (version + 5), the blob is junk
    await auto.wake();
    expect(auto.status().phase).toBe('error');
    expect(fs.readFileSync(backup).equals(before)).toBe(true); // untouched by the failed attempt
    expect(contents(homeA)).toContain('remote edit'); // and the live vault is intact
  });

  it('a write that lands during the upload is pushed next, not dropped', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    fake.mode('slow-put');
    const { auto, events } = engine({ debounceMs: 20 });
    write(homeA, 'first');
    await sleep(120); // the first upload is in flight (400 ms), no vault lock held
    write(homeA, 'second, during the upload');
    await sleep(1400); // first push lands, the engine sees the bytes moved on, re-arms, second push lands
    expect(fake.version()).toBe(2);
    expect(events.filter((e) => e.type === 'pushed')).toHaveLength(2);
    expect(auto.status().phase).toBe('synced');
    expect(auto.status().state).toBe('in-sync');
  });

  it('does nothing for a vault other than the account default', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    const other = path.join(homeA, 'other.nkv');
    const v = Vault.create({ path: other, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.save();
    v.close();
    const auto = new AutoSync({
      vaultPath: other,
      getMasterKey: () => keyFor(homeA),
      loadDeviceSecret: () => Buffer.from(deviceSecret),
      debounceMs: 10,
    });
    engines.push(auto);
    auto.notifyWrite(other);
    await sleep(60);
    await auto.flush();
    await auto.wake();
    expect(auto.status().phase).toBe('off');
    expect(fake.version()).toBe(0);
  });

  it('ignores saves of other vault files', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    const { auto } = engine();
    const other = path.join(homeA, 'other.nkv');
    const v = Vault.create({ path: other, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.save();
    v.close();
    expect(auto.status().phase).toBe('idle');
  });

  it('reports off when sync is not configured and never touches the network', async () => {
    createVault(homeA, 'seed');
    const { auto } = engine();
    write(homeA, 'edit');
    await sleep(80);
    await auto.flush();
    await auto.wake();
    expect(auto.status().phase).toBe('off');
    expect(fake.version()).toBe(0);
  });
});

describe('syncAge', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  it('words the age the way the GUI, CLI and phone show it', () => {
    expect(syncAge(null, now)).toBeNull();
    expect(syncAge('not a date', now)).toBeNull();
    expect(syncAge('2026-09-03T11:59:50Z', now)).toBe('just now');
    expect(syncAge('2026-09-03T11:58:00Z', now)).toBe('2 min ago');
    expect(syncAge('2026-09-03T09:00:00Z', now)).toBe('3 hours ago');
    expect(syncAge('2026-09-02T11:00:00Z', now)).toBe('1 day ago');
    expect(syncAge('2026-08-28T12:00:00Z', now)).toBe('6 days ago');
  });
});
