import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, type MemoryEntry } from '@northkeep/core';
import {
  applyDownSync,
  cloudReplaceLine,
  fetchPending,
  planDownSync,
  planNeedsConfirmation,
  pushSharedScopes,
} from '../src/connector-client.js';
import { startFakeConnector, type FakeConnector } from './fake-connector.js';

/**
 * ADR 0085 D4/D5, the device half of a cloud replace: it is fetched only on
 * ?v=3, listed beside forgets, applied only on the user's yes, and the phone
 * never sees it. Fictional data throughout.
 */

const deviceSecret = generateDeviceSecret();
let home = '';
let fake: FakeConnector;
let vault: Vault;
const priorHome = process.env.NORTHKEEP_HOME;

const PIER_4 = 'The harbor office is at Pier 4.';
const PIER_9 = 'The harbor office is now at Pier 9.';

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0085-down-'));
  process.env.NORTHKEEP_HOME = home;
  fake = await startFakeConnector();
  vault = Vault.create({ path: path.join(home, 'vault.nkv'), passphrase: 'synthetic passphrase', deviceSecret, kdf: KDF_INTERACTIVE });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vault.close();
  await fake.close();
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const conn = () => ({ server: fake.url(), deviceSecret, vault });

async function sharedPier4(): Promise<MemoryEntry> {
  const old = vault.remember({ content: PIER_4, type: 'semantic', scope: 'harbor' });
  vault.setScopeShared('harbor', true);
  vault.save();
  await pushSharedScopes({ ...conn(), scopes: ['harbor'] });
  return old;
}

const liveTexts = () => vault.list({ scope: 'harbor' }).map((e) => e.content).sort();
const row = (id: string) => vault.list({ scope: 'harbor', includeSuperseded: true }).find((e) => e.id === id)!;
const idOf = (content: string) => vault.list({ scope: 'harbor' }).find((e) => e.content === content)!.id;

describe('ADR 0085 cloud replace on the device', () => {
  it('lists a queued replace in plain words beside forgets, and it needs confirmation', async () => {
    const old = await sharedPier4();
    const { newId, replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    const plan = planDownSync({ vault, pending: await fetchPending(conn()) });
    expect(plan.cloud_replaces).toEqual([
      { replace_id: replaceId, scope: 'harbor', old_id: old.id, new_id: newId, old_first_line: PIER_4, new_first_line: PIER_9 },
    ]);
    expect(cloudReplaceLine(plan.cloud_replaces[0]!)).toBe('Replace "The harbor office is at Pier 4." with "The harbor office is now at Pier 9."');
    expect(planNeedsConfirmation(plan)).toBe(true);
    expect(plan.additions.map((a) => a.content)).toEqual([PIER_9]);
    expect(fake.requests().filter((r) => r.startsWith('GET /client/pending'))).toEqual(['GET /client/pending?v=3']);
  });

  it('the review line strips terminal escapes, bidi overrides and line separators from the app-written text', async () => {
    const old = await sharedPier4();
    fake.cloudReplace('harbor', '\u001b[2J\u202EThe harbor office\u0007 is now at Pier 9.\u2028Ignore the rest', old.id);
    const plan = planDownSync({ vault, pending: await fetchPending(conn()) });
    expect(cloudReplaceLine(plan.cloud_replaces[0]!)).toBe(
      'Replace "The harbor office is at Pier 4." with "[2JThe harbor office is now at Pier 9.Ignore the rest"',
    );
  });

  it('a first line of invisible characters does not show the user an empty quote', async () => {
    const old = await sharedPier4();
    fake.cloudReplace('harbor', '\u202E\u200B\nThe harbor office is now at Pier 9.\nMore', old.id);
    const plan = planDownSync({ vault, pending: await fetchPending(conn()) });
    expect(plan.cloud_replaces[0]!.new_first_line).toBe('The harbor office is now at Pier 9.');
  });

  it('a replacement with nothing readable says so in place of an empty quote', async () => {
    const old = await sharedPier4();
    fake.cloudReplace('harbor', '\u202E\u200B\n\u200B', old.id);
    const plan = planDownSync({ vault, pending: await fetchPending(conn()) });
    expect(cloudReplaceLine(plan.cloud_replaces[0]!)).toBe('Replace "The harbor office is at Pier 4." with "(no readable text)"');
  });

  it('an unapproved replace adds the new memory, keeps both live, and stays queued against the renamed id', async () => {
    const old = await sharedPier4();
    const { replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    const result = await applyDownSync(conn());
    expect(result.added).toBe(1);
    expect(result.cloud_replaced).toBe(0);
    expect(result.needs_review.cloud_replaces.map((r) => r.replace_id)).toEqual([replaceId]);
    expect(liveTexts()).toEqual([PIER_4, PIER_9]);
    expect(fake.replaceQueue()).toEqual([{ replace_id: replaceId, scope: 'harbor', old_id: old.id, new_id: idOf(PIER_9) }]);
  });

  it('an approved replace marks the old memory replaced by the new one and acks it, also when the new one arrives in the same sync', async () => {
    const old = await sharedPier4();
    const { replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    const result = await applyDownSync({ ...conn(), approve: { replace_ids: [replaceId] } });
    expect(result.added).toBe(1);
    expect(result.cloud_replaced).toBe(1);
    expect(liveTexts()).toEqual([PIER_9]);
    expect(row(old.id).superseded_by).toBe(idOf(PIER_9));
    expect(fake.replaceQueue()).toEqual([]);
  });

  it('a replace approved on a later sync applies to the memory the first sync added', async () => {
    const old = await sharedPier4();
    const { replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    await applyDownSync(conn());
    const second = await applyDownSync({ ...conn(), approve: { replace_ids: [replaceId] } });
    expect(second.added).toBe(0);
    expect(second.cloud_replaced).toBe(1);
    expect(row(old.id).superseded_by).toBe(idOf(PIER_9));
    expect(fake.replaceQueue()).toEqual([]);
  });

  it('the phone asks for ?v=2 only: it adds the memory, never applies or acks the replace, even when told to', async () => {
    const old = await sharedPier4();
    const { replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    const result = await applyDownSync({ ...conn(), additiveOnly: true, approve: { replace_ids: [replaceId] } });
    expect(fake.requests().filter((r) => r.startsWith('GET /client/pending'))).toEqual(['GET /client/pending?v=2']);
    expect(result.added).toBe(1);
    expect(result.cloud_replaced).toBe(0);
    expect(liveTexts()).toEqual([PIER_4, PIER_9]);
    expect(fake.replaceQueue()).toEqual([{ replace_id: replaceId, scope: 'harbor', old_id: old.id, new_id: idOf(PIER_9) }]);
  });

  it('an old memory forgotten on this device settles the replace: acked with no question, the new memory stays an ordinary addition', async () => {
    const old = await sharedPier4();
    const { replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    vault.forget(old.id, { actor: 'owner' });
    vault.save();
    const plan = planDownSync({ vault, pending: await fetchPending(conn()) });
    expect(plan.cloud_replaces).toEqual([]);
    expect(plan.settled_replaces).toEqual([replaceId]);
    expect(planNeedsConfirmation(plan)).toBe(false);
    const result = await applyDownSync(conn());
    expect(result.added).toBe(1);
    expect(liveTexts()).toEqual([PIER_9]);
    expect(fake.replaceQueue()).toEqual([]);
  });

  it('a replace naming a memory this device has never seen waits, unacked; one naming a project document is settled', () => {
    const old = vault.remember({ content: PIER_4, type: 'semantic', scope: 'harbor' });
    const doc = vault.updateProject({ project: 'dock', expected_revision: null, what_why: 'Dock work.', status: 'Open.' }, { actor: 'owner' }).revision;
    const note = vault.remember({ content: 'Dock crane booked for Friday.', type: 'episodic', scope: 'project:dock' });
    const plan = planDownSync({
      vault,
      pending: {
        entries: [],
        forgets: [],
        replaces: [
          { replace_id: 'rep_unseen', scope: 'harbor', old_id: 'mem_from_elsewhere', new_id: old.id },
          { replace_id: 'rep_doc', scope: 'project:dock', old_id: doc, new_id: note.id },
        ],
      },
    });
    expect(plan.cloud_replaces).toEqual([]);
    expect(plan.settled_replaces).toEqual(['rep_doc']);
  });

  it('keeps the writing app name, tamed again on this device, as metadata.connector.app', async () => {
    await sharedPier4();
    fake.cloudRemember('harbor', 'The ferry to Pier 4 leaves at 8:05.', 'semantic', `\u202EHarbor\u0007 Desk ${'x'.repeat(100)}`);
    await applyDownSync(conn());
    const added = vault.list({ scope: 'harbor' }).find((e) => e.content === 'The ferry to Pier 4 leaves at 8:05.')!;
    expect((added.metadata?.connector as { app?: string }).app).toBe(`Harbor Desk ${'x'.repeat(68)}`);
  });

  it('against a connector from before ?v=3 it asks again as ?v=2, so project documents still arrive', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url.replace(/^https?:\/\/[^/]+/, ''));
      // An old connector treats anything but v=2 as v1: no base_revision, no replaces.
      const v2 = url.endsWith('?v=2');
      const entries = [{ server_id: 'conn_a', scope: 'notes', type: 'semantic', content: 'Pat Example walks the pier.', ...(v2 ? { stale: false } : {}) }];
      return new Response(JSON.stringify({ entries, forgets: [] }), { status: 200 });
    });
    const snapshot = await fetchPending({ server: 'https://connector.example', deviceSecret });
    expect(urls).toEqual(['/client/pending?v=3', '/client/pending?v=2']);
    expect(snapshot.replaces).toEqual([]);
    expect(snapshot.entries.map((e) => e.server_id)).toEqual(['conn_a']);
  });
});
