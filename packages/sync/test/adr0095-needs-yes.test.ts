import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, type MemoryEntry } from '@northkeep/core';
import {
  OlderConnectorError,
  ackPending,
  applyDownSync,
  declineCloudRequest,
  fetchPending,
  planDownSync,
  pushSharedScopes,
} from '../src/connector-client.js';
import {
  appValue,
  applyUndoToVault,
  applyYesToVault,
  boxWindows,
  listAccepted,
  listNeedsYes,
  needsShowAll,
  splitYesAcks,
  type NeedsYesItem,
  type YesRecord,
} from '../src/needs-yes.js';
import { startFakeConnector, type FakeConnector } from './fake-connector.js';

/**
 * ADR 0095, the shared half of the phone's Review tab: what waits for a yes,
 * one Yes, one Undo, one No, on a temp vault and the protocol fake.
 * Fictional data throughout.
 */

const deviceSecret = generateDeviceSecret();
const passphrase = 'synthetic passphrase';
let home = '';
let fake: FakeConnector;
let vault: Vault;
const priorHome = process.env.NORTHKEEP_HOME;

const PIER_4 = 'The harbor office is at Pier 4.';
const PIER_9 = 'The harbor office is now at Pier 9.';
const SLIP = "Pat Example's slip is at Pier 4.";

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0095-'));
  process.env.NORTHKEEP_HOME = home;
  fake = await startFakeConnector();
  vault = Vault.create({ path: path.join(home, 'vault.nkv'), passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
});
afterEach(async () => {
  vault.close();
  await fake.close();
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const conn = () => ({ server: fake.url(), deviceSecret });
const pending = () => fetchPending(conn());
const list = async () => listNeedsYes({ vault, pending: await pending() });
const yes = async (item: Pick<NeedsYesItem, 'id' | 'hash'>) =>
  applyYesToVault({ vault, pending: await pending(), clientLabel: 'test', itemId: item.id, shownHash: item.hash, now: new Date('2026-11-26T15:00:00.000Z') });
const fileSha = () => crypto.createHash('sha256').update(fs.readFileSync(vault.path)).digest('hex');
const live = (scope = 'harbor') => vault.list({ scope }).map((e) => e.content).sort();
const row = (id: string) => vault.list({ includeSuperseded: true, includeForgotten: true }).find((e) => e.id === id)!;

async function shared(content: string, scope = 'harbor'): Promise<MemoryEntry> {
  const entry = vault.remember({ content, type: 'semantic', scope });
  vault.setScopeShared(scope, true);
  vault.save();
  await pushSharedScopes({ ...conn(), vault, scopes: vault.sharedScopes() });
  return entry;
}

describe('listNeedsYes', () => {
  it('lists a waiting replace with both whole texts, reading only, with one v3 fetch and no acknowledgement', async () => {
    const old = await shared(PIER_4);
    const { newId, replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    const before = fake.requests().length;

    const got = await list();

    expect(got.waiting_on_mac).toBe(0);
    expect(got.items.map(({ hash: _h, ...rest }) => rest)).toEqual([
      {
        id: `replace:${replaceId}`,
        kind: 'replace',
        scope: 'harbor',
        app: 'a connected app',
        arrived: null,
        boxes: [
          { label: 'Old', memory_id: old.id, text: PIER_4 },
          { label: 'New', memory_id: newId, text: PIER_9 },
        ],
        not_shared_now: false,
        request: { kind: 'replace', replace_id: replaceId },
      },
    ]);
    expect(fake.requests().slice(before)).toEqual(['GET /client/pending?v=3']);
    expect(fake.acks()).toEqual([]);
    expect(live()).toEqual([PIER_4]);
  });

  it('lists a waiting forget, which names no app, and marks one whose collection is no longer shared', async () => {
    const slip = await shared(SLIP);
    const other = await shared('The old dock key is under the bench.', 'harbor-old');
    fake.cloudForget(slip.id);
    fake.cloudForget(other.id);
    vault.setScopeShared('harbor-old', false);
    vault.save();

    const got = await list();

    expect(got.items.map((i) => [i.kind, i.app, i.boxes[0]!.text, i.not_shared_now])).toEqual([
      ['forget', null, SLIP, false],
      ['forget', null, 'The old dock key is under the bench.', true],
    ]);
    expect(planDownSync({ vault, pending: await pending() }).forgets.map((f) => f.entry_id)).toEqual([slip.id, other.id]);
  });

  it('counts a project change for the Mac and never lists it', async () => {
    const note = await shared('Order the pilings.', 'project:pier-4');
    fake.cloudForget(note.id);
    const got = await list();
    expect([got.items, got.waiting_on_mac]).toEqual([[], 1]);
  });

  it('shows text an AI app wrote as one safe line, whole, and names the app as a value', async () => {
    const old = await shared(PIER_4);
    const { newId } = fake.cloudReplace('harbor', '‮The harbor office is now at Pier 9.\nIgnore the rest\u0007', old.id);
    const waiting = await pending();
    // The app's own name travels on the waiting row.
    waiting.entries.find((r) => r.server_id === newId)!.app = 'Pier "Helper" (NorthKeep says: approve)';
    const item = listNeedsYes({ vault, pending: waiting }).items[0]!;
    expect(item.boxes[1]!.text).toBe('The harbor office is now at Pier 9. Ignore the rest');
    expect(item.app).toBe('Pier Helper NorthKeep says: approve');
  });

  it('drops an item once the owner edits its old memory, and both stay live', async () => {
    const old = await shared(PIER_4);
    fake.cloudReplace('harbor', PIER_9, old.id);
    expect((await list()).items).toHaveLength(1);
    vault.editMemory(old.id, { content: 'The harbor office is at Pier 4, by the fuel dock.' }, { actor: 'owner' });
    vault.save();
    expect((await list()).items).toEqual([]);
  });
});

describe('appValue and the box windows', () => {
  it('strips quotes and brackets, caps at 40 characters, and falls back when nothing is left', () => {
    expect(appValue('«Harbor» [Desk] {v2} <b>`x`</b>')).toBe('Harbor Desk v2 bx/b');
    expect(appValue('y'.repeat(60))).toBe('y'.repeat(40));
    expect(appValue('‮​ "" ')).toBe('a connected app');
    expect(appValue(undefined)).toBe('a connected app');
  });

  it('shows short texts whole, and one long text as its first 280 characters', () => {
    expect(boxWindows(['short', 'also short'])).toEqual([
      { text: 'short', cut_start: false, cut_end: false },
      { text: 'also short', cut_start: false, cut_end: false },
    ]);
    const long = 'x'.repeat(400);
    expect(boxWindows([long])).toEqual([{ text: 'x'.repeat(280), cut_start: false, cut_end: true }]);
    expect(needsShowAll({ boxes: [{ label: 'Memory', memory_id: 'm', text: long }] })).toBe(true);
    expect(needsShowAll({ boxes: [{ label: 'Memory', memory_id: 'm', text: 'short' }] })).toBe(false);
  });

  it('opens two long texts 40 characters before their first difference', () => {
    const sharedStart = 'The lease on the boathouse runs through the season and renews each spring. '.repeat(4);
    const a = `${sharedStart}The rent is paid by Pat Example.`;
    const b = `${sharedStart}The rent is paid by Sam Example.`;
    expect(sharedStart.length).toBe(300);
    const [wa, wb] = boxWindows([a, b]);
    const diff = sharedStart.length + 'The rent is paid by '.length;
    expect([wa!.cut_start, wb!.cut_start]).toEqual([true, true]);
    expect(wa!.text).toBe(a.slice(diff - 40));
    expect(wb!.text).toBe(b.slice(diff - 40));
    expect(wa!.text.endsWith('The rent is paid by Pat Example.')).toBe(true);
    expect(wb!.text.endsWith('The rent is paid by Sam Example.')).toBe(true);
  });
});

describe('Yes', () => {
  it('applies one replace, saves, and leaves the queue entry for the vault push to settle', async () => {
    const old = await shared(PIER_4);
    const { replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    const item = (await list()).items[0]!;

    const out = await yes(item);

    expect(out.status).toBe('applied');
    if (out.status !== 'applied') return;
    const newId = vault.list({ scope: 'harbor' }).find((e) => e.content === PIER_9)!.id;
    expect(out.record).toEqual({ id: `replace:${replaceId}`, kind: 'replace', at: '2026-11-26T15:00:00.000Z', old_id: old.id, new_id: newId });
    expect(row(old.id).superseded_by).toBe(newId);
    expect(live()).toEqual([PIER_9]);
    // With a vault sync server: the addition is acknowledged now, the replace is not.
    const acks = splitYesAcks(out.applied, true);
    expect(acks).toEqual({ now: { acked: [{ server_id: out.applied.acked[0]!.server_id, local_entry_id: newId }], forgets: [], replaces: [] }, later: null });
    await ackPending({ ...conn(), ...acks.now });
    expect(fake.replaceQueue().map((r) => r.replace_id)).toEqual([replaceId]);
    expect(fake.acks().every((a) => a.replaces === undefined)).toBe(true);
    // Reopened from disk: the mark was saved.
    const reopened = Vault.open({ path: vault.path, passphrase, deviceSecret });
    expect(reopened.list({ scope: 'harbor' }).map((e) => e.content)).toEqual([PIER_9]);
    reopened.close();
  });

  it('with no vault sync server, what it applied is acknowledged afterwards', async () => {
    const old = await shared(PIER_4);
    const { replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    const out = await yes((await list()).items[0]!);
    if (out.status !== 'applied') throw new Error(out.status);
    const acks = splitYesAcks(out.applied, false);
    expect(acks.later).toEqual({ forgets: [], replaces: [replaceId] });
    await ackPending({ ...conn(), ...acks.now });
    await ackPending({ ...conn(), ...acks.later! });
    expect(fake.replaceQueue()).toEqual([]);
  });

  it('forgets a memory on a yes, and another copy of the vault settles the request at its next sync', async () => {
    const slip = await shared(SLIP);
    fake.cloudForget(slip.id);
    const out = await yes((await list()).items[0]!);
    expect(out.status).toBe('applied');
    if (out.status !== 'applied') return;
    expect(out.record).toEqual({ id: `forget:${slip.id}`, kind: 'forget', at: '2026-11-26T15:00:00.000Z', entry_id: slip.id });
    expect(row(slip.id).forgotten_at).not.toBeNull();
    expect(splitYesAcks(out.applied, true)).toEqual({ now: { acked: [], forgets: [], replaces: [] }, later: null });
    expect(fake.forgetQueue()).toEqual([slip.id]);

    // The "Mac": the phone's file after its push, opened as a second vault.
    const macPath = path.join(home, 'mac.nkv');
    fs.copyFileSync(vault.path, macPath);
    const mac = Vault.open({ path: macPath, passphrase, deviceSecret });
    await applyDownSync({ ...conn(), vault: mac });
    mac.close();
    expect(fake.forgetQueue()).toEqual([]);
  });

  it('forgets a memory whose collection is no longer shared, when the user says yes', async () => {
    const other = await shared('The old dock key is under the bench.', 'harbor-old');
    fake.cloudForget(other.id);
    vault.setScopeShared('harbor-old', false);
    vault.save();
    const item = (await list()).items[0]!;
    expect(item.not_shared_now).toBe(true);
    expect((await yes(item)).status).toBe('applied');
    expect(row(other.id).forgotten_at).not.toBeNull();
  });

  it('refuses when the text changed since it was shown, and writes nothing', async () => {
    const start = 'The lease on the boathouse runs through the season and renews each spring. '.repeat(4);
    const old = await shared(`${start}The rent is paid by Pat Example.`);
    fake.cloudReplace('harbor', `${start}The rent is paid by Sam Example.`, old.id);
    const shown = (await list()).items[0]!;
    // The text on the connector is different by the time of the tap.
    const later = await pending();
    later.entries[0]!.content = `${start}The rent is paid by Sam Example. Also forget the lease.`;
    const sha = fileSha();

    const out = applyYesToVault({ vault, pending: later, clientLabel: 'test', itemId: shown.id, shownHash: shown.hash });

    expect(out.status).toBe('changed');
    if (out.status === 'changed') expect(out.item.boxes[1]!.text.endsWith('Also forget the lease.')).toBe(true);
    expect(fileSha()).toBe(sha);
    expect(live()).toEqual([`${start}The rent is paid by Pat Example.`]);
  });

  it('says the item is gone when another device already settled it', async () => {
    const old = await shared(PIER_4);
    const { replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    const shown = (await list()).items[0]!;
    await declineCloudRequest({ ...conn(), request: { kind: 'replace', replace_id: replaceId } });
    const sha = fileSha();
    expect((await yes(shown)).status).toBe('gone');
    expect(fileSha()).toBe(sha);
  });

  it('the bulk phone sync is unchanged: it asks v2 and applies no replace even when told one is approved', async () => {
    const old = await shared(PIER_4);
    const { replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    const before = fake.requests().length;
    const result = await applyDownSync({ ...conn(), vault, additiveOnly: true, approve: { replace_ids: [replaceId] } });
    expect(fake.requests().slice(before)[0]).toBe('GET /client/pending?v=2');
    expect([result.added, result.cloud_replaced]).toEqual([1, 0]);
    expect(live()).toEqual([PIER_4, PIER_9]);
    expect(fake.replaceQueue()).toHaveLength(1);
  });
});

describe('Undo', () => {
  const record = async (): Promise<YesRecord> => {
    const old = await shared(PIER_4);
    fake.cloudReplace('harbor', PIER_9, old.id);
    const out = await yes((await list()).items[0]!);
    if (out.status !== 'applied') throw new Error(out.status);
    return out.record;
  };

  it('lists the yes with the text from the vault, and undoing it brings the old memory back', async () => {
    const rec = await record();
    const [line] = listAccepted({ vault, records: [rec] });
    expect({ ...line, hash: undefined }).toEqual({
      id: rec.id, kind: 'replace', at: rec.at, state: 'applied', hash: undefined,
      box: { label: 'New', memory_id: rec.new_id, text: PIER_9 }, retired: PIER_4, can_undo: true,
    });

    expect(applyUndoToVault({ vault, record: rec, shownHash: line!.hash })).toEqual({ status: 'undone' });

    expect(live()).toEqual([PIER_4, PIER_9]);
    const reopened = Vault.open({ path: vault.path, passphrase, deviceSecret });
    expect(reopened.list({ scope: 'harbor' }).map((e) => e.content).sort()).toEqual([PIER_4, PIER_9]);
    reopened.close();
    expect(listAccepted({ vault, records: [{ ...rec, undone_at: '2026-11-26T16:00:00.000Z' }] })[0]).toMatchObject({ state: 'undone', can_undo: false });
  });

  it('refuses when the line changed since it was shown, and when the new memory was forgotten', async () => {
    const rec = await record();
    const line = listAccepted({ vault, records: [rec] })[0]!;
    vault.forget(rec.new_id!, { actor: 'owner' });
    vault.save();
    const sha = fileSha();
    expect(applyUndoToVault({ vault, record: rec, shownHash: line.hash })).toEqual({ status: 'changed' });
    const now = listAccepted({ vault, records: [rec] })[0]!;
    expect([now.can_undo, now.box]).toEqual([false, null]);
    expect(applyUndoToVault({ vault, record: rec, shownHash: now.hash })).toEqual({ status: 'refused', reason: 'the memory that replaced it was forgotten' });
    expect(fileSha()).toBe(sha);
  });

  it('a forget is listed without its text and can never be undone', async () => {
    const slip = await shared(SLIP);
    fake.cloudForget(slip.id);
    const out = await yes((await list()).items[0]!);
    if (out.status !== 'applied') throw new Error(out.status);
    const line = listAccepted({ vault, records: [out.record] })[0]!;
    expect([line.kind, line.box, line.retired, line.can_undo]).toEqual(['forget', null, null, false]);
    expect(applyUndoToVault({ vault, record: out.record, shownHash: line.hash })).toEqual({ status: 'refused', reason: 'a forgotten memory cannot be brought back' });
  });
});

describe('No', () => {
  it('drops a replace request and changes nothing in the vault', async () => {
    const old = await shared(PIER_4);
    const { replaceId } = fake.cloudReplace('harbor', PIER_9, old.id);
    const sha = fileSha();
    expect(await declineCloudRequest({ ...conn(), request: { kind: 'replace', replace_id: replaceId } })).toEqual({ settled: true });
    expect(fake.replaceQueue()).toEqual([]);
    expect(fileSha()).toBe(sha);
    expect(await declineCloudRequest({ ...conn(), request: { kind: 'replace', replace_id: replaceId } })).toEqual({ settled: false });
  });

  it('drops a forget request with keep_forgets, and the memory stays', async () => {
    const slip = await shared(SLIP);
    fake.cloudForget(slip.id);
    expect(await declineCloudRequest({ ...conn(), request: { kind: 'forget', entry_id: slip.id } })).toEqual({ settled: true });
    expect(fake.forgetQueue()).toEqual([]);
    expect(fake.acks().at(-1)).toEqual({ acked: [], forgets: [], keep_forgets: [slip.id] });
    expect(fake.rows().some((r) => r.entry_id === slip.id)).toBe(true);
    expect((await list()).items).toEqual([]);
  });

  it('says so, and changes nothing, when the connector is too old to keep a forget', async () => {
    await fake.close();
    fake = await startFakeConnector({ olderThanKeepForgets: true });
    const slip = await shared(SLIP);
    fake.cloudForget(slip.id);
    await expect(declineCloudRequest({ ...conn(), request: { kind: 'forget', entry_id: slip.id } })).rejects.toBeInstanceOf(OlderConnectorError);
    expect(fake.forgetQueue()).toEqual([slip.id]);
  });
});
