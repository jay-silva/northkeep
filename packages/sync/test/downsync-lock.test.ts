import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, onVaultSave, withFileLock } from '@northkeep/core';
import { planDownSync, pullDownSync, pushSharedScopes, type PendingRow } from '../src/connector-client.js';
import { startFakeConnector, type FakeConnector } from './fake-connector.js';

/**
 * The pull's connector calls all run inside the caller's vault section, each
 * capped (defect B, two merge reviews), and the per-scope lookup plans exactly
 * as the per-row search did. Temp home and fictional data only.
 */

const deviceSecret = generateDeviceSecret();
let home = '';
let fake: FakeConnector;
let vault: Vault;
const priorHome = process.env.NORTHKEEP_HOME;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-downsync-lock-'));
  process.env.NORTHKEEP_HOME = home;
  fake = await startFakeConnector();
  vault = Vault.create({ path: path.join(home, 'vault.nkv'), passphrase: 'synthetic passphrase', deviceSecret, kdf: KDF_INTERACTIVE });
});
afterEach(async () => {
  fake.observe(null);
  vault.close();
  await fake.close();
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** A vault section that records when it starts, saves and ends, in the same log as the connector's requests. */
function loggedSection(log: string[]) {
  return async <T>(fn: (v: Vault) => T | Promise<T>): Promise<T> => {
    log.push('vault section starts');
    const stop = onVaultSave(() => log.push('vault saved'));
    try {
      return await fn(vault);
    } finally {
      stop();
      log.push('vault section ends');
    }
  };
}

/** The real file lock around the open test vault, as the Mac app and the command line take it. */
const lockedSection = <T>(fn: (v: Vault) => T | Promise<T>): Promise<T> => withFileLock(vault.path, () => fn(vault));
const lockHeld = () => fs.existsSync(`${vault.path}.lock`);

describe('pullDownSync', () => {
  it('fetches inside the vault section and sends the discard and acknowledgement there too, after the save', async () => {
    vault.setScopeShared('work', true);
    const pushed = vault.remember({ content: 'Pushed memory', type: 'semantic', scope: 'work' });
    vault.save();
    await pushSharedScopes({ server: fake.url(), deviceSecret, scopes: ['work'], vault });
    const fromApp = fake.cloudRemember('work', 'From the app');
    const forgottenHere = fake.cloudRemember('work', 'Forgotten here');
    fake.cloudForget(pushed.id);
    // This vault already took that row in and the user forgot it, so it is discarded.
    vault.forget(vault.remember({ content: 'Forgotten here', type: 'semantic', scope: 'work', metadata: { connector: { server_id: forgottenHere } } }).id, { actor: 'owner' });
    vault.save();
    const log: string[] = [];
    fake.observe((request) => log.push(request));

    const result = await pullDownSync({ server: fake.url(), deviceSecret, withVault: loggedSection(log), approve: { forget_ids: [pushed.id] } });

    expect(log).toEqual(['vault section starts', 'GET /client/pending?v=3', 'vault saved', 'POST /client/discard', 'POST /client/ack', 'vault section ends']);
    expect([result.added, result.forgotten, result.discarded, result.deduped]).toEqual([1, 1, 1, 0]);
    expect(vault.list({ scope: 'work' }).map((e) => e.content)).toEqual(['From the app']);
    expect(fake.rows().filter((r) => r.pending)).toEqual([]);
    expect(fake.rows().map((r) => r.entry_id)).not.toContain(fromApp);
  });

  it('the phone asks with ?v=2 inside the vault section and sends its acknowledgement there, after the save', async () => {
    vault.setScopeShared('work', true);
    fake.cloudRemember('work', 'From the app');
    const log: string[] = [];
    fake.observe((request) => log.push(request));
    const result = await pullDownSync({ server: fake.url(), deviceSecret, withVault: loggedSection(log), additiveOnly: true });
    expect(log).toEqual(['vault section starts', 'GET /client/pending?v=2', 'vault saved', 'POST /client/ack', 'vault section ends']);
    expect(result.added).toBe(1);
  });

  it('sends nothing at all when the vault section is refused, and the rows stay waiting', async () => {
    vault.setScopeShared('work', true);
    const fromApp = fake.cloudRemember('work', 'From the app');
    const log: string[] = [];
    fake.observe((request) => log.push(request));
    const refused = async (): Promise<never> => {
      throw new Error('Vault is locked by another NorthKeep process.');
    };
    await expect(pullDownSync({ server: fake.url(), deviceSecret, withVault: refused })).rejects.toThrow('Vault is locked by another NorthKeep process.');
    expect(log).toEqual([]);
    expect(fake.rows().filter((r) => r.pending).map((r) => r.entry_id)).toEqual([fromApp]);
  });

  it('gives up on a hanging acknowledgement at settleTimeoutMs, frees the lock, and the next pull settles it with no second copy', async () => {
    vault.setScopeShared('work', true);
    vault.save();
    const fromApp = fake.cloudRemember('work', 'From the app');
    fake.hold('/client/ack'); // never released: this acknowledgement hangs
    const seen: Array<[string, boolean]> = [];
    fake.observe((request) => seen.push([request, lockHeld()]));

    const failure = await pullDownSync({ server: fake.url(), deviceSecret, withVault: lockedSection, settleTimeoutMs: 200 }).then(
      () => 'finished',
      (err: Error) => err.name,
    );
    const heldAfter = lockHeld();

    expect([failure, heldAfter]).toEqual(['TimeoutError', false]);
    expect(seen).toEqual([['GET /client/pending?v=3', true], ['POST /client/ack', true]]);
    const onDisk = Vault.open({ path: vault.path, passphrase: 'synthetic passphrase', deviceSecret });
    expect(onDisk.list({ scope: 'work' }).map((e) => e.content)).toEqual(['From the app']);
    onDisk.close();
    expect(fake.rows().filter((r) => r.pending).map((r) => r.entry_id)).toEqual([fromApp]);

    const next = await pullDownSync({ server: fake.url(), deviceSecret, withVault: lockedSection });
    expect([next.added, next.deduped]).toEqual([0, 1]);
    expect(fake.rows().filter((r) => r.pending)).toEqual([]);
    expect(vault.list({ scope: 'work' }).map((e) => e.content)).toEqual(['From the app']);
  });

  it('gives up on a hanging fetch at settleTimeoutMs, frees the lock, saves nothing, and the rows stay waiting', async () => {
    vault.setScopeShared('work', true);
    vault.save();
    const fromApp = fake.cloudRemember('work', 'From the app');
    fake.hold('/client/pending'); // never released: this fetch hangs
    const seen: Array<[string, boolean]> = [];
    fake.observe((request) => seen.push([request, lockHeld()]));

    const failure = await pullDownSync({ server: fake.url(), deviceSecret, withVault: lockedSection, settleTimeoutMs: 200 }).then(
      () => 'finished',
      (err: Error) => err.name,
    );

    expect([failure, lockHeld()]).toEqual(['TimeoutError', false]);
    expect(seen).toEqual([['GET /client/pending?v=3', true]]);
    expect(vault.list({ scope: 'work' }).map((e) => e.content)).toEqual([]);
    expect(fake.rows().filter((r) => r.pending).map((r) => r.entry_id)).toEqual([fromApp]);
  });

  it('plans against the vault as it is when the rows arrive, not as it was when the fetch started', async () => {
    vault.setScopeShared('work', true);
    fake.cloudRemember('work', 'Written in both places');
    const parked = fake.hold('/client/pending');
    const pull = pullDownSync({ server: fake.url(), deviceSecret, withVault: async (fn) => fn(vault) });
    await parked.arrived;
    const local = vault.remember({ content: 'Written in both places', type: 'semantic', scope: 'work' });
    vault.save();
    parked.release();
    const result = await pull;
    expect([result.added, result.deduped]).toEqual([0, 1]);
    expect(vault.list({ scope: 'work' }).map((e) => e.id)).toEqual([local.id]);
    expect(fake.rows().find((r) => r.entry_id === local.id)?.pending).toBe(false);
  });
});

describe('planDownSync text lookup gives the same answers as a search per row', () => {
  const row = (server_id: string, scope: string, content: string): PendingRow => ({ server_id, scope, type: 'semantic', content, base_revision: null, stale: false });

  it('dedupes to the earliest live copy in the same scope only, and never to a replaced memory', () => {
    const first = vault.remember({ content: 'Same text', type: 'semantic', scope: 'work' });
    vault.remember({ content: 'Same text', type: 'semantic', scope: 'work' });
    const home = vault.remember({ content: 'Home text', type: 'semantic', scope: 'home' });
    const old = vault.remember({ content: 'Old wording', type: 'semantic', scope: 'work' });
    const newer = vault.remember({ content: 'New wording', type: 'semantic', scope: 'work' });
    vault.markReplaced(old.id, newer.id);

    const plan = planDownSync({
      vault,
      pending: {
        entries: [row('c1', 'work', 'Same text'), row('c2', 'work', 'Home text'), row('c3', 'work', 'Old wording'), row('c4', 'work', 'Same text'), row('c5', 'home', 'Home text')],
        forgets: [],
        replaces: [],
      },
    });

    expect(plan.dedupes).toEqual([
      { server_id: 'c1', local_entry_id: first.id },
      { server_id: 'c4', local_entry_id: first.id },
      { server_id: 'c5', local_entry_id: home.id },
    ]);
    expect(plan.additions.map((a) => [a.server_id, a.scope, a.content])).toEqual([
      ['c2', 'work', 'Home text'],
      ['c3', 'work', 'Old wording'],
    ]);
  });

  it('two waiting rows with the same new text are both additions, as before', () => {
    const plan = planDownSync({ vault, pending: { entries: [row('c1', 'work', 'Twice'), row('c2', 'work', 'Twice')], forgets: [], replaces: [] } });
    expect(plan.additions.map((a) => a.server_id)).toEqual(['c1', 'c2']);
    expect(plan.dedupes).toEqual([]);
  });
});
