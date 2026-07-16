import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deriveConnectorToken, tokenHash } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';

/**
 * ADR 0020 crypto-review CRITICAL fixes:
 *   1. Production pepper guard: a real (Neon) database with no CONNECTOR_KEK_PEPPER
 *      refuses to start; InMemory runs on the DEV pepper.
 *   2. Delete-on-consume: a pairing row (and its stored KEK wrap) is GONE once
 *      consumed, and expired codes are refused and GC'd, so a consumed/expired
 *      code is no longer an offline brute-force oracle.
 *   3. Legacy plaintext passthrough is self-host-only: the hosted deploy drops a
 *      non-nkc1 row (never serves/syncs it); the opt-in env still serves it.
 */

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

// ---- Fix 1: production pepper guard ------------------------------------

describe('ADR 0020 fix 1: production pepper guard', () => {
  const saved = process.env.CONNECTOR_KEK_PEPPER;
  afterEach(() => {
    if (saved === undefined) delete process.env.CONNECTOR_KEK_PEPPER;
    else process.env.CONNECTOR_KEK_PEPPER = saved;
  });

  it('a Neon-backed connector with no pepper THROWS at construction (fail closed)', () => {
    delete process.env.CONNECTOR_KEK_PEPPER;
    const neonStorage = new NeonConnectorStorage('postgres://u:p@localhost/db');
    expect(() => createConnectorServer(neonStorage)).toThrow(/CONNECTOR_KEK_PEPPER is required/);
  });

  it('a Neon-backed connector WITH a valid pepper constructs', () => {
    process.env.CONNECTOR_KEK_PEPPER = Buffer.alloc(32, 9).toString('base64');
    const neonStorage = new NeonConnectorStorage('postgres://u:p@localhost/db');
    expect(() => createConnectorServer(neonStorage)).not.toThrow();
  });

  it('a Neon-backed connector with a TOO-SHORT pepper throws', () => {
    process.env.CONNECTOR_KEK_PEPPER = Buffer.alloc(16, 9).toString('base64');
    const neonStorage = new NeonConnectorStorage('postgres://u:p@localhost/db');
    expect(() => createConnectorServer(neonStorage)).toThrow();
  });

  it('InMemory storage runs with no pepper (dev/test fallback)', () => {
    delete process.env.CONNECTOR_KEK_PEPPER;
    expect(() => createConnectorServer(new InMemoryConnectorStorage())).not.toThrow();
  });
});

// ---- Fix 2: delete-on-consume + expired refusal ------------------------

describe('ADR 0020 fix 2: pairing codes deleted on consume + expiry', () => {
  it('a consumed pairing code is DELETED, not just flagged (no lingering oracle)', async () => {
    const storage = new InMemoryConnectorStorage();
    await storage.upsertAccount('acct');
    await storage.putPairingCode('codehash', 'acct', Date.now() + 60_000, 'nkw1:wrap');
    const first = await storage.consumePairingCode('codehash');
    expect(first).toEqual({ accountHash: 'acct', dekWrap: 'nkw1:wrap' });
    // Second consume finds nothing: the row (and its wrap) is gone.
    expect(await storage.consumePairingCode('codehash')).toBeNull();
    // The dump no longer contains the wrap that a consumed code would have left.
    expect(storage.dumpState()).not.toContain('nkw1:wrap');
  });

  it('an expired pairing code is refused and GC-deleted', async () => {
    const storage = new InMemoryConnectorStorage();
    await storage.upsertAccount('acct');
    await storage.putPairingCode('expired', 'acct', Date.now() - 1000, 'nkw1:stale');
    expect(await storage.consumePairingCode('expired')).toBeNull();
    // GC removed the stale row + its wrap.
    expect(storage.dumpState()).not.toContain('nkw1:stale');
    // A second, unrelated consume also does not resurrect it.
    expect(await storage.consumePairingCode('expired')).toBeNull();
  });
});

// ---- Fix 3: legacy plaintext passthrough is self-host-only -------------

describe('ADR 0020 fix 3: legacy plaintext gated to an explicit opt-in', () => {
  const storage = new InMemoryConnectorStorage();
  const deviceSecret = crypto.randomBytes(32);
  const connToken = deriveConnectorToken(deviceSecret);
  const account = tokenHash(connToken);
  const LEGACY = 'INJECTED legacy plaintext memory that was never encrypted';

  let hostedServer: Server;
  let legacyServer: Server;
  let hostedBase = '';
  let legacyBase = '';
  const savedEnv = process.env.NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT;
  const savedPublic = process.env.PUBLIC_URL;

  beforeAll(async () => {
    // A legacy row: connector-born, pending, content NOT nkc1-encrypted — the
    // shape a hostile DB-writer would inject to push a chosen memory into a vault.
    await storage.upsertAccount(account);
    await storage.putEntry(account, {
      entryId: 'legacy-1',
      scope: 'work',
      type: 'semantic',
      content: LEGACY,
      entryHash: '',
      origin: 'connector',
      pending: true,
      createdAt: new Date().toISOString(),
    });

    // Hosted server: env unset → legacy passthrough OFF.
    delete process.env.NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT;
    const hp = await freePort();
    process.env.PUBLIC_URL = `http://127.0.0.1:${hp}`;
    hostedServer = await new Promise<Server>((resolve) => {
      const s = createConnectorServer(storage).listen(hp, '127.0.0.1', () => resolve(s));
    });
    hostedBase = `http://127.0.0.1:${hp}`;

    // Self-host server: opt-in env → legacy passthrough ON.
    process.env.NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT = '1';
    const lp = await freePort();
    process.env.PUBLIC_URL = `http://127.0.0.1:${lp}`;
    legacyServer = await new Promise<Server>((resolve) => {
      const s = createConnectorServer(storage).listen(lp, '127.0.0.1', () => resolve(s));
    });
    legacyBase = `http://127.0.0.1:${lp}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => hostedServer.close(() => r()));
    await new Promise<void>((r) => legacyServer.close(() => r()));
    if (savedEnv === undefined) delete process.env.NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT;
    else process.env.NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT = savedEnv;
    if (savedPublic === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = savedPublic;
  });

  async function pending(base: string): Promise<any> {
    const res = await fetch(`${base}/client/pending`, { headers: { authorization: `Bearer ${connToken}` } });
    expect(res.status).toBe(200);
    return res.json();
  }

  it('the HOSTED deploy never serves a non-nkc1 row on /client/pending', async () => {
    const body = await pending(hostedBase);
    expect(body.entries).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain(LEGACY);
  });

  it('the opt-in self-host path DOES serve the legacy row', async () => {
    const body = await pending(legacyBase);
    expect(body.entries.some((e: any) => e.content === LEGACY)).toBe(true);
  });
});
