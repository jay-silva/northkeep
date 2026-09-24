import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault, deriveMasterKey, onVaultSave, KDF_INTERACTIVE } from '@northkeep/core';
import { AutoSync, DIVERGED_MESSAGE, syncAge, type AutoSyncClock, type AutoSyncEvent } from '../src/auto.js';
import { deriveSyncCreds } from '../src/creds.js';
import { loadSyncConfig, setSyncServer } from '../src/config.js';
import { pullVault, pushVault } from '../src/client.js';

/**
 * ADR 0044 engine tests. A fake ciphertext-only server (same wire contract as
 * apps/sync-server) plus real vaults on disk. "Another device" is a second
 * NORTHKEEP_HOME that pushes straight through pushVault.
 *
 * Time is a ManualClock: the engine's debounce, backoff and pause windows
 * move only when a test advances it, and every operation a timer starts has
 * finished before the test looks. A slow server response is a parked request
 * the test releases. No test sleeps, so machine load cannot reorder anything.
 */

type Mode = 'ok' | 'subscription' | 'crash' | 'slow-blob' | 'garbage-blob' | 'slow-put' | 'slow-fail-put';

function fakeServer(): {
  server: Server;
  url: () => string;
  version: () => number;
  mode: (m: Mode) => void;
  omitSha: (v: boolean) => void;
  conflictOnce: () => void;
  parked: () => Promise<void>;
  release: () => void;
} {
  let blob: Buffer | null = null;
  let version = 0;
  let mode: Mode = 'ok';
  let noSha = false;
  /** Answer exactly one PUT with a 409 at the current version, then behave. */
  let conflictNext = false;
  /** Responses a slow mode is holding back, and waiters for the next one to be held. */
  const held: (() => void)[] = [];
  const parkWaiters: (() => void)[] = [];
  const park = (respond: () => void) => {
    held.push(respond);
    for (const w of parkWaiters.splice(0)) w();
  };
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
        if (mode === 'slow-blob') park(send);
        else send();
        return;
      }
      if (req.method === 'PUT' && req.url === '/api/blob') {
        // A PUT that is parked and then fails: status and blob keep working,
        // so a write can land while a manual push is in flight and losing.
        if (mode === 'slow-fail-put') {
          park(() => res.writeHead(500).end());
          return;
        }
        const base = Number(req.headers['x-base-version'] ?? '0');
        if (conflictNext) {
          conflictNext = false;
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version }));
          return;
        }
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
        if (mode === 'slow-put') park(accept);
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
    conflictOnce: () => {
      conflictNext = true;
    },
    /** Resolves once a slow mode is holding a request. */
    parked: () => (held.length > 0 ? Promise.resolve() : new Promise<void>((r) => parkWaiters.push(r))),
    /** Sends every held response. */
    release: () => {
      for (const respond of held.splice(0)) respond();
    },
  };
}

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * The engine's clock. Nothing fires until advance(), which fires each timer
 * that falls due in time order and waits for the engine to finish the work
 * that timer queued (real disk and HTTP) before firing the next.
 */
class ManualClock implements AutoSyncClock {
  private t = Date.now();
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** Timers still waiting to fire. */
  pending(): number {
    return this.timers.size;
  }
  /** Fires the timers due within ms without waiting for what they start (for a request the server holds). */
  fire(ms: number): void {
    const end = this.t + ms;
    for (let next = this.nextDue(end); next; next = this.nextDue(end)) this.run(next);
    this.t = end;
  }
  async advance(ms: number, auto: AutoSync): Promise<void> {
    const end = this.t + ms;
    await auto.whenIdle();
    for (let next = this.nextDue(end); next; next = this.nextDue(end)) {
      this.run(next);
      await auto.whenIdle();
    }
    this.t = end;
  }
  private nextDue(end: number): [number, { at: number; fn: () => void }] | undefined {
    return [...this.timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
  }
  private run([id, timer]: [number, { at: number; fn: () => void }]): void {
    this.timers.delete(id);
    this.t = Math.max(this.t, timer.at);
    timer.fn();
  }
}

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
  /** Argon2 per call made each write cost tens of ms of CPU; derive once per salt, hand out copies (the engine zeroes its copy). */
  const derived = new Map<string, Buffer>();
  const keyAt = (vp: string): Buffer => {
    const header = Vault.readHeader(vp);
    const id = `${Buffer.from(header.salt).toString('hex')} ${JSON.stringify(header.kdf)}`;
    let key = derived.get(id);
    if (!key) {
      key = deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf);
      derived.set(id, Buffer.from(key));
    }
    return Buffer.from(key);
  };
  const keyFor = (home: string): Buffer => keyAt(vaultPath(home));
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
  /** The sync generation sealed in a vault file (the live one, or a .bak beside it). */
  function generationAt(vp: string): number {
    const v = Vault.openWithKey(vp, keyAt(vp));
    try {
      return v.getSyncGeneration();
    } finally {
      v.close();
    }
  }
  function contentsAt(vp: string): string[] {
    const v = Vault.openWithKey(vp, keyAt(vp));
    try {
      return v.list().map((e) => e.content);
    } finally {
      v.close();
    }
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
  function engine(
    opts: { locked?: () => boolean; debounceMs?: number; backoffMs?: number[]; pauseRetryMs?: number } = {},
  ): {
    auto: AutoSync;
    events: AutoSyncEvent[];
    clock: ManualClock;
    tick: (ms: number) => Promise<void>;
  } {
    const events: AutoSyncEvent[] = [];
    const clock = new ManualClock();
    const auto = new AutoSync({
      vaultPath: vaultPath(homeA),
      getMasterKey: () => (opts.locked?.() ? null : keyFor(homeA)),
      loadDeviceSecret: () => Buffer.from(deviceSecret),
      onEvent: (e) => events.push(e),
      debounceMs: opts.debounceMs ?? 30,
      backoffMs: opts.backoffMs ?? [40, 40],
      // Ten minutes in production; tests that care set their own.
      pauseRetryMs: opts.pauseRetryMs ?? 600_000,
      clock,
    });
    // Wire it the way the hosts do: core's save hook feeds notifyWrite.
    unsubscribe = onVaultSave((p) => auto.notifyWrite(p));
    engines.push(auto);
    return { auto, events, clock, tick: (ms) => clock.advance(ms, auto) };
  }

  it('a write becomes one debounced push, and the push does not re-trigger itself', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    const { auto, events, clock, tick } = engine();
    write(homeA, 'one');
    await tick(20);
    write(homeA, 'two'); // second write inside the debounce window restarts it
    expect(auto.status().phase).toBe('pending');
    await tick(29);
    expect(fake.version()).toBe(0); // trailing edge: 30 ms after the LAST write, not the first
    await tick(1);
    expect(fake.version()).toBe(1); // one upload for two writes, from the timer alone
    expect(events.filter((e) => e.type === 'pushed')).toHaveLength(1);
    expect(auto.status().phase).toBe('synced');
    // pushVault saved the vault (generation bump); that save must not queue another push.
    expect(clock.pending()).toBe(0);
    await tick(1_000);
    expect(fake.version()).toBe(1);
    expect(auto.status().phase).toBe('synced');
    expect(loadSyncConfig()?.lastSyncedAt).toBeTruthy();
  });

  it('with the real clock (no clock option), a write still reaches the server through the debounce', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    let pushed!: () => void;
    const done = new Promise<void>((r) => (pushed = r));
    const auto = new AutoSync({
      vaultPath: vaultPath(homeA),
      getMasterKey: () => keyFor(homeA),
      loadDeviceSecret: () => Buffer.from(deviceSecret),
      onEvent: (e) => e.type === 'pushed' && pushed(),
      debounceMs: 10,
    });
    engines.push(auto);
    unsubscribe = onVaultSave((p) => auto.notifyWrite(p));
    write(homeA, 'one');
    await done; // no timing assertion: only that the real timer fires and pushes
    await auto.whenIdle();
    expect(fake.version()).toBe(1);
    expect(auto.status().phase).toBe('synced');
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
    const { auto, tick } = engine({ locked: () => locked });
    write(homeA, 'written while locked');
    await tick(30); // the debounced push runs, finds no key, and leaves the write pending
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
    const { auto, events, clock, tick } = engine();
    write(homeA, 'edit');
    await tick(30);
    expect(auto.status().phase).toBe('paused');
    expect(auto.status().pausedReason).toBe('subscription');
    expect(auto.status().nextRetryAt).toBeNull();
    expect(clock.pending()).toBe(0); // no retry timer at all
    expect(events.some((e) => e.type === 'paused')).toBe(true);
    await tick(120); // longer than the backoff: still nothing, because paused
    expect(fake.version()).toBe(0);

    fake.mode('ok');
    auto.resume();
    await tick(30); // resume re-armed the debounce; no flush needed
    expect(fake.version()).toBe(1);
    expect(auto.status().phase).toBe('synced');
  });

  /**
   * The sixth review's MCP kill shot. One 402 paused the engine and nothing on
   * a headless host ever called resume(), so the session could not push again
   * for its lifetime. A pause now expires: the next write or wake after
   * pauseRetryMs lifts it and tries once.
   */
  it('a pause expires: a write more than pauseRetryMs later lifts it and pushes', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    fake.mode('subscription');
    const { auto, tick } = engine({ debounceMs: 20, pauseRetryMs: 300 });
    write(homeA, 'edit');
    await tick(20);
    expect(auto.status().phase).toBe('paused');
    expect(auto.status().pausedReason).toBe('subscription');

    fake.mode('ok');
    // Inside the window: a write is recorded but must not retry the paywall.
    write(homeA, 'second, still inside the pause window');
    expect(auto.status().phase).toBe('paused');
    await tick(200);
    expect(fake.version()).toBe(0);
    await tick(99);
    write(homeA, 'at 299 ms, one short of the window');
    expect(auto.status().pausedReason).toBe('subscription');
    await tick(100);
    expect(fake.version()).toBe(0);

    // Past the window: the next write lifts the pause and the push goes.
    write(homeA, 'third, after the pause expired');
    expect(auto.status().pausedReason).toBeNull();
    await tick(20);
    expect(fake.version()).toBe(1);
    expect(auto.status().phase).toBe('synced');
  });

  it('an expired pause lets wake try once, and a fresh 402 pauses again with its own event', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    fake.mode('subscription');
    const { auto, events, tick } = engine({ debounceMs: 20, pauseRetryMs: 200 });
    write(homeA, 'edit');
    await tick(20);
    expect(auto.status().pausedReason).toBe('subscription');
    expect(events.filter((e) => e.type === 'paused')).toHaveLength(1);

    await tick(250); // past pauseRetryMs
    await auto.wake(); // lifts the pause, tries, and is refused again
    expect(auto.status().phase).toBe('paused');
    expect(auto.status().pausedReason).toBe('subscription');
    expect(events.filter((e) => e.type === 'paused')).toHaveLength(2);
    expect(auto.status().pushPending).toBe(true);
    expect(fake.version()).toBe(0);

    // And the re-pause starts a fresh window: an immediate wake does nothing.
    fake.mode('ok');
    await auto.wake();
    expect(fake.version()).toBe(0);
    expect(auto.status().phase).toBe('paused');
  });

  /**
   * The sixth review's desktop flesh wound. notifyWrite is ignored while the
   * engine runs its own operation, so a write that landed during a manual push
   * was only ever noticed by the success path's hash check. When the push
   * FAILED, nothing re-armed and the write sat there until something else
   * happened to push.
   */
  it('a write during a FAILING manual push is re-armed, not dropped', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    configure(homeB);
    const { auto, tick } = engine({ debounceMs: 20 });
    await auto.runManual(() => pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }));
    expect(fake.version()).toBe(1);

    fake.mode('slow-fail-put');
    const failing = auto.runManual(() =>
      pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }),
    );
    await fake.parked(); // the PUT is parked; the vault lock is free
    write(homeA, 'landed during the failing push');
    fake.mode('ok');
    fake.release(); // and now the parked PUT fails
    await expect(failing).rejects.toThrow();
    expect(auto.status().pushPending).toBe(true);
    expect(auto.status().phase).toBe('pending');

    await tick(20); // the re-armed debounce fires on its own: no flush, no wake
    expect(fake.version()).toBe(2);
    expect(auto.status().phase).toBe('synced');

    // The write really reached the server, not just the local file.
    process.env.NORTHKEEP_HOME = homeB;
    try {
      expect((await pullVault({ vaultPath: vaultPath(homeB), deviceSecret })).ok).toBe(true);
    } finally {
      process.env.NORTHKEEP_HOME = homeA;
    }
    expect(contents(homeB)).toContain('landed during the failing push');
  });

  it('a server failure backs off and retries; a write during backoff waits; stop() clears the retry', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    fake.mode('crash');
    const { auto, clock, tick } = engine({ debounceMs: 20, backoffMs: [600, 600] });
    write(homeA, 'edit');
    await tick(20); // the debounced attempt fails
    expect(auto.status().phase).toBe('error');
    expect(auto.status().failures).toBe(1);
    expect(auto.status().nextRetryAt).toBe(clock.now() + 600);
    write(homeA, 'another edit inside the backoff window');
    fake.mode('ok');
    await tick(100); // its debounce fires, and yields to the backoff
    expect(auto.status().failures).toBe(1); // no second attempt before the retry is due
    await tick(499);
    expect(fake.version()).toBe(0); // one short of the retry: still waiting
    await tick(1); // the scheduled retry fires and succeeds
    expect(fake.version()).toBe(1);
    expect(auto.status().failures).toBe(0);
    expect(auto.status().phase).toBe('synced');

    fake.mode('crash');
    write(homeA, 'third');
    await tick(20);
    expect(auto.status().nextRetryAt).not.toBeNull();
    auto.stop();
    expect(auto.status().nextRetryAt).toBeNull();
    expect(clock.pending()).toBe(0); // no timer left to fire
    fake.mode('ok');
    await tick(5_000);
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
    const clock = new ManualClock();
    const auto = new AutoSync({
      vaultPath: vaultPath(homeA),
      getMasterKey: () => keyFor(homeA),
      loadDeviceSecret: () => Buffer.from(deviceSecret),
      debounceMs: 80,
      maxWaitMs: 250,
      clock,
    });
    engines.push(auto);
    unsubscribe = onVaultSave((p) => auto.notifyWrite(p));
    // A write every 30 ms restarts the 80 ms debounce each time, so only the
    // 250 ms cap can push while the stream runs.
    const versionAt: Record<number, number> = {};
    for (let t = 0; t < 600; t += 30) {
      write(homeA, `burst ${t}`);
      await clock.advance(30, auto);
      versionAt[t + 30] = fake.version();
    }
    expect(versionAt[240]).toBe(0); // the debounce alone never fired
    expect(versionAt[270]).toBe(1); // the cap fired at 250 ms, mid-stream
    expect(versionAt[600]).toBe(2); // and again 250 ms after the next unpushed write
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
    await fake.parked(); // the download is in flight; the vault lock is NOT held, so this write goes through
    write(homeA, 'written during the download');
    fake.mode('ok');
    fake.release();
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
    const { auto, events, clock, tick } = engine({ debounceMs: 20 });
    write(homeA, 'first');
    clock.fire(20); // the debounced push starts; not awaited, since the server holds its PUT
    await fake.parked(); // the first upload is in flight, no vault lock held
    write(homeA, 'second, during the upload');
    fake.mode('ok');
    fake.release();
    await auto.whenIdle(); // the first push lands and sees the bytes moved on
    expect(fake.version()).toBe(1);
    expect(auto.status().pushPending).toBe(true);
    await tick(20); // the re-armed debounce pushes the second write
    expect(fake.version()).toBe(2);
    expect(events.filter((e) => e.type === 'pushed')).toHaveLength(2);
    expect(auto.status().phase).toBe('synced');
    expect(auto.status().state).toBe('in-sync');
  });

  /**
   * E10, the fourth review's desktop kill shot. An offline Mac with one
   * pending write used to gain a generation per backoff tick. Once any other
   * device pushed, the Mac was diverged with its manual pull refused as a
   * replay ("older than this one") and its push 409ing: no way out from the
   * UI or the CLI. One logical push must cost exactly one generation.
   */
  it('an offline retry loop costs exactly one generation, and the manual pull that follows still works', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    configure(homeB);
    const { auto, clock, tick } = engine({ debounceMs: 20, backoffMs: [40, 40] });
    await auto.runManual(() => pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }));
    const genBefore = generationAt(vaultPath(homeA));
    expect(loadSyncConfig()?.lastGeneration).toBe(genBefore);

    // The server goes away with one write unpushed; the engine retries.
    fake.mode('crash');
    write(homeA, 'the pending local edit');
    await tick(20 + 40 + 40 + 40); // the debounced attempt, then three retries
    expect(auto.status().failures).toBe(4);
    auto.stop();
    expect(clock.pending()).toBe(0);
    fake.mode('ok');

    expect(generationAt(vaultPath(homeA))).toBe(genBefore + 1);

    // Another device pushes: it bumps from the same base, so its generation
    // is no higher than ours.
    await otherDevicePushes('remote edit');

    const localBytes = fs.readFileSync(vaultPath(homeA));
    const pull = await pullVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) });
    expect(pull.ok).toBe(true);
    expect(contents(homeA)).toContain('remote edit');
    // The local edit is recoverable from the .bak the pull left behind.
    const bak = `${vaultPath(homeA)}.bak`;
    expect(fs.readFileSync(bak).equals(localBytes)).toBe(true);
    expect(contentsAt(bak)).toContain('the pending local edit');
  });

  /**
   * The 409 retry (another process on this machine refreshed the base) is one
   * logical push too: the second attempt reuses the stamp the first made.
   */
  it('the 409 retry pushes once more without a second generation bump', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    const { auto, events, tick } = engine({ debounceMs: 20 });
    await auto.runManual(() => pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }));
    const genBefore = generationAt(vaultPath(homeA));

    fake.conflictOnce();
    write(homeA, 'an edit whose first PUT is refused');
    await tick(20);

    expect(fake.version()).toBe(2); // the retry landed
    expect(events.filter((e) => e.type === 'pushed')).toHaveLength(1);
    expect(generationAt(vaultPath(homeA))).toBe(genBefore + 1);
    expect(loadSyncConfig()?.lastGeneration).toBe(genBefore + 1);
    expect(auto.status().phase).toBe('synced');
  });

  /**
   * A vault that is a symlink (into iCloud, onto an external disk) must stay a
   * symlink. Renaming the pulled copy over the link replaced it with a regular
   * file, and isAutoSyncVault's realpath check then read it as another vault
   * and switched automatic sync off in silence (sixth review, hosts).
   */
  it('a fast-forward pull writes through a symlinked vault instead of replacing it', async () => {
    const store = path.join(homeA, 'store');
    fs.mkdirSync(store);
    const real = path.join(store, 'real.nkv');
    const v = Vault.create({ path: real, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.remember({ content: 'seed', type: 'semantic' });
    v.save();
    v.close();
    fs.symlinkSync(real, vaultPath(homeA));
    configure(homeA);
    configure(homeB);

    const { auto, events } = engine({ debounceMs: 10_000 });
    // A push saves the vault (generation bump): the link survives that too.
    await auto.runManual(() => pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) }));
    expect(fs.lstatSync(vaultPath(homeA)).isSymbolicLink()).toBe(true);

    await otherDevicePushes('written on the phone');
    await auto.wake();

    expect(events.some((e) => e.type === 'pulled')).toBe(true);
    expect(fs.lstatSync(vaultPath(homeA)).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(vaultPath(homeA))).toBe(fs.realpathSync(real));
    expect(contents(homeA)).toContain('written on the phone');
    // The displaced copy and the rolling backup both sit beside the real file.
    expect(fs.existsSync(`${real}.auto-pull.bak`)).toBe(true);
    expect(fs.existsSync(`${real}.bak`)).toBe(true);
    expect(fs.existsSync(`${vaultPath(homeA)}.pulled.tmp`)).toBe(false);
  });

  it('does nothing for a vault other than the account default', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    const other = path.join(homeA, 'other.nkv');
    const v = Vault.create({ path: other, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.save();
    v.close();
    const clock = new ManualClock();
    const auto = new AutoSync({
      vaultPath: other,
      getMasterKey: () => keyFor(homeA),
      loadDeviceSecret: () => Buffer.from(deviceSecret),
      debounceMs: 10,
      clock,
    });
    engines.push(auto);
    auto.notifyWrite(other);
    expect(clock.pending()).toBe(0); // not even a debounce was armed
    await clock.advance(60, auto);
    await auto.flush();
    await auto.wake();
    expect(auto.status().phase).toBe('off');
    expect(fake.version()).toBe(0);
  });

  it('repairs a record whose push landed but was never recorded (exit mid-upload), on wake and on the 409 path', async () => {
    createVault(homeA, 'seed');
    configure(homeA);
    const { auto, tick } = engine({ debounceMs: 20 });
    write(homeA, 'first');
    await tick(20);
    expect(fake.version()).toBe(1);
    // Simulate the lost record step: the server has v1 with these bytes, sync.json still says v0.
    const cfgPath = path.join(homeA, 'sync.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, lastVersion: 0, lastSha: 'f'.repeat(64), lastGeneration: null }));
    await auto.wake();
    const repaired = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(repaired.lastVersion).toBe(1);
    expect(repaired.lastSha).toBe(cfg.lastSha);
    expect(repaired.lastGeneration).toBe(cfg.lastGeneration);
    // The next write pushes from the repaired base without a false diverged.
    write(homeA, 'second');
    await tick(20);
    expect(fake.version()).toBe(2);
    expect(auto.status().state).toBe('in-sync');

    // Same tear, but the next event is a write rather than a wake. After the
    // write the bytes no longer match the server, so the 409 reads as a real
    // two-sided change and is reported, never resolved (recorded residual: a
    // wake, which every host runs at start, is what repairs a torn record).
    fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), lastVersion: 1 }));
    write(homeA, 'third');
    await tick(20);
    expect(fake.version()).toBe(2);
    expect(auto.status().state).toBe('diverged');
    expect(contents(homeA)).toContain('third'); // the write is intact locally
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
    const { auto, tick } = engine();
    write(homeA, 'edit');
    await tick(30);
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
