import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, type Vault as VaultType } from '@northkeep/core';
import { emptyProjectDoc, mergeProjectDoc, serializeProjectDoc } from '@northkeep/core/project-doc';
import { holdMessage, markConnectorPaired, setConnectorServer } from '@northkeep/sync';
import { shareSyncCmd, type WithVault } from '../src/shareCmd.js';

/**
 * ADR 0050 Decision 5 on the CLI: a project created in a connected app arrives
 * only through the fold, so a paired device folds even with nothing shared, and
 * the push that follows carries the list as it stands after the fold.
 */

const deviceSecret = generateDeviceSecret();
const priorHome = process.env.NORTHKEEP_HOME;
let home = '';
let lines: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

const SERVER = 'http://127.0.0.1:9';

function projectMarkdown(status: string): string {
  return serializeProjectDoc(
    mergeProjectDoc(emptyProjectDoc(), { whatWhy: 'Made in a connected app.', status, logEntry: 'Seeded.' }),
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cli-sharesync-'));
  process.env.NORTHKEEP_HOME = home;
  fs.writeFileSync(path.join(home, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
  setConnectorServer(SERVER);
  lines = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  vi.unstubAllGlobals();
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function makeVault(): VaultType {
  return Vault.create({
    path: path.join(home, 'vault.nkv'),
    passphrase: 'cli share sync',
    deviceSecret,
    kdf: KDF_INTERACTIVE,
  });
}

/** One vault, opened once, handed to the command the way index.ts does. */
function withVaultOf(vault: VaultType): WithVault {
  return async (fn) => fn(vault);
}

/** Records every request and answers the three connector routes the sync touches. */
function stubConnector(entries: Array<{ server_id: string; scope: string; type: string; content: string }>): {
  calls: string[];
  puts: Array<{ scopes: string[]; entries: Array<{ scope: string }> }>;
} {
  const calls: string[] = [];
  const puts: Array<{ scopes: string[]; entries: Array<{ scope: string }> }> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/client/pending')) {
      return new Response(JSON.stringify({ entries, forgets: [] }), { status: 200 });
    }
    if (url.endsWith('/client/ack')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.endsWith('/client/entries')) {
      puts.push(JSON.parse(String(init?.body ?? '{}')) as { scopes: string[]; entries: Array<{ scope: string }> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return { calls, puts };
}

const failHard = (m: string): never => {
  throw new Error(m);
};

describe('shareSyncCmd (ADR 0050 Decision 5)', () => {
  it('makes no network call with nothing shared and no pairing on this device', async () => {
    const vault = makeVault();
    const { calls } = stubConnector([]);
    await shareSyncCmd(withVaultOf(vault), failHard);
    expect(calls).toEqual([]);
    expect(lines).toEqual(['No scopes are shared yet. Run: northkeep share add <scope>']);
    vault.close();
  });

  it('folds and pushes the newly marked scope in the same run once this device has paired', async () => {
    const vault = makeVault();
    markConnectorPaired();
    const { calls, puts } = stubConnector([
      {
        server_id: 'conn_create_1',
        scope: 'project:hosted-thing',
        type: 'working',
        content: projectMarkdown('Started in the app.'),
      },
    ]);
    await shareSyncCmd(withVaultOf(vault), failHard);
    expect(calls.some((u) => u.endsWith('/client/pending'))).toBe(true);
    // The fold marked the scope, and this same run pushed it: the old code read
    // the shared list once, before the fold, and pushed nothing.
    expect(vault.sharedScopes()).toContain('project:hosted-thing');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.scopes).toContain('project:hosted-thing');
    expect(puts[0]!.entries.some((e) => e.scope === 'project:hosted-thing')).toBe(true);
    expect(lines.some((l) => l.includes('1 added'))).toBe(true);
    vault.close();
  });

  it('treats a legacy pairing (connector.json with only the server, pre-0.22) as paired', async () => {
    fs.writeFileSync(path.join(process.env.NORTHKEEP_HOME!, 'connector.json'), `${JSON.stringify({ server: SERVER })}\n`, { mode: 0o600 });
    const vault = makeVault();
    const { puts } = stubConnector([
      { server_id: 'conn_create_legacy', scope: 'project:legacy-proj', type: 'working', content: projectMarkdown('From 0.21.') },
    ]);
    await shareSyncCmd(withVaultOf(vault), failHard);
    expect(vault.sharedScopes()).toContain('project:legacy-proj');
    expect(puts).toHaveLength(1);
    vault.close();
  });

  it('reports rows skipped for an unknown type instead of dropping them silently', async () => {
    const vault = makeVault();
    markConnectorPaired();
    vault.setScopeShared('work', true);
    vault.save();
    stubConnector([{ server_id: 'conn_bad', scope: 'work', type: 'Working', content: 'Not a stored type.' }]);
    await shareSyncCmd(withVaultOf(vault), failHard);
    expect(lines.some((l) => l.includes('1 skipped'))).toBe(true);
    expect(lines.some((l) => l.includes('Skipped memories had a type NorthKeep does not store'))).toBe(true);
    vault.close();
  });

  it('prints the hold message for a scope the fold would not mark', async () => {
    const vault = makeVault();
    markConnectorPaired();
    // A live local memory makes the scope non-empty, so the app's row is held.
    vault.remember({ content: 'Private note.', type: 'episodic', scope: 'project:held-one' });
    vault.save();
    stubConnector([
      {
        server_id: 'conn_create_2',
        scope: 'project:held-one',
        type: 'working',
        content: projectMarkdown('From the app.'),
      },
    ]);
    await shareSyncCmd(withVaultOf(vault), failHard);
    expect(vault.sharedScopes()).not.toContain('project:held-one');
    expect(lines.some((l) => l.includes('1 held'))).toBe(true);
    expect(lines.some((l) => l.includes(holdMessage('held-one')))).toBe(true);
    // The slug, not the scope: "project project:held-one" would be the bug.
    expect(lines.some((l) => l.includes('project:project:'))).toBe(false);
    vault.close();
  });
});
