import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, getPlatform, type MemoryEntry } from '@northkeep/core';
import { ackHeldAfterPush, fetchPending } from '../src/connector-client.js';
import { snapshotSharedScopes } from '../src/connector-push.js';
import { applyAnswerToVault, listAccepted, listAnswerItems, listAnswerLines, listNeedsYes, undoAnswerInVault } from '../src/needs-yes.js';

/**
 * ADR 0092 on the shared half of the phone's Review tab: answer cards, a Yes,
 * a No and an Undo on a temp vault, and the pending route's versions against
 * a stub. Fictional data throughout.
 */

let dir = '';
let vault: Vault;
const NOW = new Date(2026, 10, 27, 10, 0, 0);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0092-review-'));
  vault = Vault.create({ path: path.join(dir, 'vault.nkv'), passphrase: 'synthetic passphrase', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE });
});
afterEach(() => {
  vault.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const add = (content: string, source = 'cli') => vault.remember({ content, type: 'semantic', scope: 'harbor', source });
const resolve = (first: MemoryEntry, second: MemoryEntry, answer: 'first' | 'second' | 'both' | 'neither', correct?: string) =>
  vault.resolveAnswer({ first: first.id, second: second.id, answer, said: 'They moved it last week.', correct, app: 'mcp:client-b', now: NOW });
const live = () => vault.list().map((e) => e.content).sort();

describe('answer cards on the phone', () => {
  it('shows a waiting answer as a report, refuses a stale Yes, applies a fresh one, and undoes it', () => {
    const m1 = add('The fuel dock opens at 6.');
    const m2 = add('The fuel dock opens at 7.', 'mcp:client-a');
    expect(resolve(m1, m2, 'second').reason).toBe('needs_user');

    const [item] = listAnswerItems(vault);
    expect(item).toMatchObject({
      kind: 'answer',
      scope: 'harbor',
      app: 'client-b',
      boxes: [
        { label: '1', memory_id: m1.id, text: 'The fuel dock opens at 6.' },
        { label: '2', memory_id: m2.id, text: 'The fuel dock opens at 7.' },
      ],
      report: { said: 'They moved it last week.', answer: 'second', fact: null },
    });
    expect(listNeedsYes({ vault, pending: { entries: [], forgets: [], replaces: [] } }).items.map((i) => i.id)).toEqual([item!.id]);

    expect(applyAnswerToVault({ vault, itemId: item!.id, shownHash: 'not what was shown', decision: 'yes' })).toMatchObject({ status: 'changed' });
    expect(live()).toEqual(['The fuel dock opens at 6.', 'The fuel dock opens at 7.']);
    expect(applyAnswerToVault({ vault, itemId: item!.id, shownHash: item!.hash, decision: 'yes' })).toEqual({ status: 'done' });
    expect(live()).toEqual(['The fuel dock opens at 7.']);
    expect(listAnswerItems(vault)).toEqual([]);
    expect(applyAnswerToVault({ vault, itemId: item!.id, shownHash: item!.hash, decision: 'yes' })).toEqual({ status: 'gone' });

    const [line] = listAnswerLines(vault, NOW);
    expect(line).toMatchObject({ id: item!.id, kind: 'answer', state: 'applied', by: 'phone', app: 'client-b', can_undo: true, box: { text: 'The fuel dock opens at 7.' } });
    expect(listAccepted({ vault, records: [], now: NOW }).map((l) => l.id)).toEqual([line!.id]);
    expect(undoAnswerInVault({ vault, lineId: line!.id, shownHash: 'stale', now: NOW })).toEqual({ status: 'changed' });
    expect(undoAnswerInVault({ vault, lineId: line!.id, shownHash: line!.hash, now: NOW })).toEqual({ status: 'undone' });
    expect(live()).toEqual(['The fuel dock opens at 6.', 'The fuel dock opens at 7.']);
    expect(listAnswerLines(vault, NOW)[0]).toMatchObject({ state: 'undone', can_undo: false });
  });

  it('a No declines in the vault and changes no memory', () => {
    const m1 = add('Slip 12 belongs to the yacht club.');
    const m2 = add('Slip 12 belongs to the town.', 'mcp:client-a');
    resolve(m1, m2, 'first');
    const [item] = listAnswerItems(vault);
    expect(applyAnswerToVault({ vault, itemId: item!.id, shownHash: item!.hash, decision: 'no' })).toEqual({ status: 'done' });
    expect(live()).toEqual(['Slip 12 belongs to the town.', 'Slip 12 belongs to the yacht club.']);
    expect(listAnswerLines(vault, NOW)[0]).toMatchObject({ state: 'declined', can_undo: false });
  });

  it('shows the reported fact for "neither" and applies it', () => {
    const m1 = add('The pier lights are white.');
    const m2 = add('The pier lights are red.', 'mcp:client-a');
    resolve(m1, m2, 'neither', 'The pier lights are green.');
    const [item] = listAnswerItems(vault);
    expect(item!.report).toMatchObject({ answer: 'neither', fact: { text: 'The pier lights are green.' } });
    expect(applyAnswerToVault({ vault, itemId: item!.id, shownHash: item!.hash, decision: 'yes' })).toEqual({ status: 'done' });
    expect(live()).toEqual(['The pier lights are green.']);
  });

  it('lists an everyday answer accepted in chat with an Undo, and a "both" as kept', () => {
    const a1 = add('The bait shop is by the gate.');
    const a2 = add('The bait shop is by the kiosk.', 'mcp:client-a');
    expect(resolve(a1, a2, 'second').accepted).toBe(true);
    const b1 = add('The ferry office is by the north ramp.');
    const b2 = add('The ferry office is by the south ramp.', 'mcp:client-a');
    expect(resolve(b1, b2, 'both').accepted).toBe(true);
    const lines = listAnswerLines(vault, NOW);
    expect(lines.map((l) => [l.state, l.by, l.can_undo])).toEqual(
      expect.arrayContaining([
        ['applied', 'chat', true],
        ['both', 'chat', true],
      ]),
    );
    const chat = lines.find((l) => l.state === 'applied')!;
    expect(undoAnswerInVault({ vault, lineId: chat.id, shownHash: chat.hash, now: NOW })).toEqual({ status: 'undone' });
    expect(live()).toContain('The bait shop is by the gate.');
  });

  it('lists nothing on a 0.4 vault the phone opened', () => {
    const phone = { ...getPlatform(), makeSchemaSteps: false };
    const old = Vault.create({ path: path.join(dir, 'phone.nkv'), passphrase: 'synthetic passphrase', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE, platform: phone });
    old.remember({ content: 'The harbor office is at Pier 4.', type: 'semantic', scope: 'harbor', source: 'cli' });
    expect([listAnswerItems(old), listAnswerLines(old, NOW)]).toEqual([[], []]);
    old.close();
  });
});

describe('the pending route, by connector version', () => {
  let server: http.Server;
  let base = '';
  let seen: string[] = [];
  let reply: (v: string) => unknown = () => ({});
  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      seen.push(`${req.method} ${url.pathname}${url.search}`);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method === 'POST') seen.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply(url.searchParams.get('v') ?? '')));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  const conn = () => ({ server: base, deviceSecret: Buffer.alloc(32, 7) });

  it('reads answers from a v4 connector, none from a v3 one, and asks again as v2 on an older one', async () => {
    reply = () => ({ entries: [], forgets: [], replaces: [], answers: [{ answer_id: 'ans_1', scope: 'harbor', first_id: 'conn_1', second_id: 'conn_2', answer: 'first', said: 'Yes.', app: 'Cloud\nTwo', at: '2026-11-27T15:00:00.000Z', pair_key: 'ab'.repeat(32), pick: 'a' }] });
    const v4 = await fetchPending({ ...conn(), answers: true });
    expect(v4.answers).toMatchObject([{ answer_id: 'ans_1', first_id: 'conn_1', app: 'CloudTwo', correct: null, pair_key: 'ab'.repeat(32), pick: 'a' }]);

    reply = () => ({ entries: [], forgets: [], replaces: [] });
    expect((await fetchPending({ ...conn(), answers: true })).answers).toEqual([]);

    reply = () => ({ entries: [], forgets: [] });
    expect(await fetchPending({ ...conn(), answers: true })).toEqual({ entries: [], forgets: [], replaces: [], answers: [] });
    expect(seen).toEqual(['GET /client/pending?v=4', 'GET /client/pending?v=4', 'GET /client/pending?v=4', 'GET /client/pending?v=2']);

    seen = [];
    reply = () => ({ entries: [], forgets: [], replaces: [] });
    expect((await fetchPending(conn())).answers).toBeUndefined();
    expect(seen).toEqual(['GET /client/pending?v=3']);
  });

  it('sends held answer acknowledgements after the push, and nothing when none are held', async () => {
    reply = () => ({ ok: true });
    await ackHeldAfterPush({ ...conn(), held: { held_replace_acks: [], held_answer_acks: [] } });
    expect(seen).toEqual([]);
    await ackHeldAfterPush({ ...conn(), held: { held_replace_acks: [], held_answer_acks: ['ans_1'] } });
    expect(seen[0]).toBe('POST /client/ack');
    expect(JSON.parse(seen[1]!)).toMatchObject({ answers: ['ans_1'] });
  });
});

describe('the shared snapshot', () => {
  it('changes its fingerprint when only an answer state changes, and leaves private collections out', () => {
    vault.setScopeShared('harbor', true);
    const m1 = add('The tide board is at berth 3.');
    const m2 = add('The tide board is at berth 4.', 'mcp:client-a');
    resolve(m1, m2, 'first');
    const waiting = snapshotSharedScopes(vault);
    expect(waiting.source.answerStatesForPush?.()).toEqual([expect.objectContaining({ state: 'waiting' })]);
    const [item] = listAnswerItems(vault);
    applyAnswerToVault({ vault, itemId: item!.id, shownHash: item!.hash, decision: 'no' });
    const declined = snapshotSharedScopes(vault);
    expect(declined.source.list({ scope: 'harbor' }).map((e) => e.entry_hash)).toEqual(waiting.source.list({ scope: 'harbor' }).map((e) => e.entry_hash));
    expect(declined.fingerprint).not.toBe(waiting.fingerprint);
    expect(declined.source.answerStatesForPush?.()).toEqual([expect.objectContaining({ state: 'declined' })]);
    vault.setScopeShared('harbor', false);
    expect(vault.answerStatesForPush(vault.sharedScopes())).toEqual([]);
  });
});
