import { describe, expect, it } from 'vitest';
import { OlderConnectorError, type AcceptedLine, type AnswerOutcome, type AppliedPending, type NeedsYesItem, type YesOutcome, type YesRecord } from '@northkeep/sync';
import {
  EMPTY_REVIEW_STATE,
  REVIEW_CHANGED,
  REVIEW_NOT_IN_SYNC,
  REVIEW_OLDER_CONNECTOR,
  REVIEW_SAVED_NOT_LISTED,
  REVIEW_SAVED_NOT_SENT,
  REVIEW_SETTLED,
  REVIEW_SHOW_ALL_FIRST,
  chatSince,
  nextMidnight,
  noReview,
  notNowReview,
  parseReviewState,
  refreshReview,
  reviewAnswerRefused,
  reviewCount,
  undoReview,
  yesReview,
  type ReviewPorts,
  type ReviewState,
  type VaultPushOutcome,
} from '../src/lib/review-flow';

/**
 * ADR 0095 on the phone: the Review tab's decisions, with every port faked.
 * Fictional data only.
 */

const item = (id: string, text = 'The harbor office is at Pier 4.'): NeedsYesItem => ({
  id,
  kind: 'forget',
  scope: 'harbor',
  app: null,
  arrived: null,
  boxes: [{ label: 'Memory', memory_id: id.replace('forget:', ''), text }],
  not_shared_now: false,
  request: { kind: 'forget', entry_id: id.replace('forget:', '') },
  hash: `hash of ${id}`,
});

const applied = (over: Partial<AppliedPending> = {}): AppliedPending => ({
  result: { added: 0, replaced: 0, forgotten: 0, deduped: 0, discarded: 0, held: 0, held_scopes: [], skipped: 0, deferred: 0, conflicts: [], cloud_replaced: 0, cloud_answers: 0, needs_review: { replacements: [], forgets: [], cloud_replaces: [] } },
  discards: [],
  acked: [],
  forgets: [],
  applied_forgets: [],
  replaces: [],
  applied_replaces: [],
  answers: [],
  ...over,
});

const replaceRecord: YesRecord = { id: 'replace:r1', kind: 'replace', at: '2026-11-26T15:00:00.000Z', old_id: 'old', new_id: 'new' };
const replaceYes: YesOutcome = {
  status: 'applied',
  record: replaceRecord,
  applied: applied({ acked: [{ server_id: 'conn_1', local_entry_id: 'new' }], replaces: ['r1', 'r-settled'], applied_replaces: [{ replace_id: 'r1', old_id: 'old', new_id: 'new' }], forgets: ['f-settled'] }),
};

function world(over: Partial<{ sync: 'in-sync' | 'behind' | 'no-server'; push: VaultPushOutcome; yes: YesOutcome; answer: AnswerOutcome; items: NeedsYesItem[]; lines: AcceptedLine[]; now: Date; state: ReviewState; cloudFails: boolean }> = {}) {
  const calls: string[] = [];
  let state: ReviewState = over.state ?? EMPTY_REVIEW_STATE;
  let now = over.now ?? new Date(2026, 10, 26, 15, 0, 0);
  const badge: number[] = [];
  const ports: ReviewPorts = {
    now: () => now,
    loadState: async () => state,
    saveState: async (s) => {
      state = s;
    },
    syncCheck: async () => over.sync ?? 'in-sync',
    fetchPending: async () => {
      calls.push('fetch');
      return { entries: [], forgets: [], replaces: [] };
    },
    list: async () => ({ items: over.items ?? [], waiting_on_mac: 2 }),
    accepted: async (records) => [
      ...records.map((r): AcceptedLine => ({ id: r.id, kind: r.kind, at: r.at, state: r.undone_at ? 'undone' : 'applied', box: null, retired: null, can_undo: r.kind === 'replace' && !r.undone_at, hash: `line ${r.id}` })),
      ...(over.lines ?? []),
    ],
    applyYes: async (_p, id, hash) => {
      calls.push(`applyYes ${id} ${hash}`);
      return over.yes ?? replaceYes;
    },
    applyUndo: async (record, hash) => {
      calls.push(`applyUndo ${record.id} ${hash}`);
      return hash === 'stale' ? { status: 'changed' } : hash === 'refuse' ? { status: 'refused', reason: 'the memory that replaced it was forgotten' } : { status: 'undone' };
    },
    applyAnswer: async (id, hash, decision) => {
      calls.push(`applyAnswer ${id} ${hash} ${decision}`);
      return over.answer ?? { status: 'done' };
    },
    undoAnswer: async (id, hash) => {
      calls.push(`undoAnswer ${id} ${hash}`);
      return hash === 'stale' ? { status: 'changed' } : hash === 'refuse' ? { status: 'refused', reason: 'the memory it kept was changed since' } : { status: 'undone' };
    },
    ack: async (body) => {
      calls.push(`ack ${JSON.stringify(body)}`);
    },
    decline: async (request) => {
      calls.push(`decline ${request.kind}`);
      if (request.kind === 'forget' && request.entry_id === 'old-server') throw new OlderConnectorError();
      return { settled: !(request.kind === 'replace' && request.replace_id === 'settled') };
    },
    pushVault: async () => {
      calls.push('pushVault');
      return over.push ?? { kind: 'clean', version: 7 };
    },
    pushCloud: async (version) => {
      calls.push(`pushCloud ${version}`);
      if (over.cloudFails) throw new Error('Cloud Connect is unreachable');
    },
    setBadge: async (n) => {
      badge.push(n);
    },
  };
  return { ports, calls, badge, state: () => state, setNow: (d: Date) => (now = d) };
}

describe('Yes', () => {
  it('is refused, with nothing fetched or applied, when the phone is not in sync', async () => {
    const w = world({ sync: 'behind' });
    expect(await yesReview(w.ports, item('forget:a'), false)).toEqual({ kind: 'refused', message: REVIEW_NOT_IN_SYNC });
    expect(w.calls).toEqual([]);
  });

  it('stays disabled on a text longer than one box until "Show all" has been opened', async () => {
    const w = world();
    const long = item('forget:a', 'x'.repeat(400));
    expect(await yesReview(w.ports, long, false)).toEqual({ kind: 'refused', message: REVIEW_SHOW_ALL_FIRST });
    expect(w.calls).toEqual([]);
    expect((await yesReview(w.ports, long, true)).kind).toBe('done');
  });

  it('with a sync server: saves, acknowledges only what it did not apply, pushes the vault, then Cloud Connect with that version', async () => {
    const w = world();
    expect(await yesReview(w.ports, item('replace:r1'), false)).toEqual({ kind: 'done' });
    expect(w.calls).toEqual([
      'fetch',
      'applyYes replace:r1 hash of replace:r1',
      'ack {"acked":[{"server_id":"conn_1","local_entry_id":"new"}],"forgets":["f-settled"],"replaces":[]}',
      'pushVault',
      'pushCloud 7',
    ]);
    expect(w.state().records).toEqual([replaceRecord]);
  });

  it('does not tell Cloud Connect after a vault push it had to recover from, or one that failed', async () => {
    for (const push of [{ kind: 'recovered' }, { kind: 'failed' }] as VaultPushOutcome[]) {
      const w = world({ push });
      expect(await yesReview(w.ports, item('replace:r1'), false)).toEqual({ kind: 'done', note: REVIEW_SAVED_NOT_SENT });
      expect(w.calls.filter((c) => c.startsWith('pushCloud'))).toEqual([]);
      expect(w.state().records).toEqual([replaceRecord]);
    }
  });

  it('with no sync server: pushes Cloud Connect unstamped, then acknowledges what it applied', async () => {
    const w = world({ sync: 'no-server', push: { kind: 'no-server' } });
    expect(await yesReview(w.ports, item('replace:r1'), false)).toEqual({ kind: 'done' });
    expect(w.calls.slice(2)).toEqual([
      'ack {"acked":[{"server_id":"conn_1","local_entry_id":"new"}],"forgets":["f-settled"],"replaces":["r-settled"]}',
      'pushVault',
      'pushCloud null',
      'ack {"acked":[],"forgets":[],"replaces":["r1"]}',
    ]);
  });

  it('keeps the yes when Cloud Connect cannot be reached, and says it was saved here', async () => {
    const w = world({ cloudFails: true });
    expect(await yesReview(w.ports, item('replace:r1'), false)).toEqual({ kind: 'done', note: REVIEW_SAVED_NOT_SENT });
    expect(w.state().records).toEqual([replaceRecord]);
  });

  it('reports a changed item with its new version, and a settled one, without recording a yes', async () => {
    const fresh = item('forget:a', 'New words.');
    const changed = world({ yes: { status: 'changed', item: fresh } });
    expect(await yesReview(changed.ports, item('forget:a'), false)).toEqual({ kind: 'changed', message: REVIEW_CHANGED, item: fresh });
    const gone = world({ yes: { status: 'gone' } });
    expect(await yesReview(gone.ports, item('forget:a'), false)).toEqual({ kind: 'refused', message: REVIEW_SETTLED });
    for (const w of [changed, gone]) {
      expect(w.state().records).toEqual([]);
      expect(w.calls.filter((c) => c.startsWith('ack') || c.startsWith('push'))).toEqual([]);
    }
  });

  it('acknowledges and pushes additions a settled yes still saved', async () => {
    const w = world({ yes: { status: 'gone', applied: applied({ acked: [{ server_id: 'conn_2', local_entry_id: 'm2' }] }) } });
    expect(await yesReview(w.ports, item('replace:r1'), false)).toEqual({ kind: 'refused', message: REVIEW_SETTLED });
    expect(w.calls.slice(2)).toEqual(['ack {"acked":[{"server_id":"conn_2","local_entry_id":"m2"}],"forgets":[],"replaces":[]}', 'pushVault']);
  });
});

describe('Undo', () => {
  const withYes = (over: Parameters<typeof world>[0] = {}) => world({ ...over, state: { ...EMPTY_REVIEW_STATE, records: [replaceRecord] } });

  it('is refused when the phone is not in sync, and applies nothing', async () => {
    const w = withYes({ sync: 'behind' });
    expect(await undoReview(w.ports, { id: 'replace:r1', hash: 'line replace:r1' })).toEqual({ kind: 'refused', message: REVIEW_NOT_IN_SYNC });
    expect(w.calls).toEqual([]);
  });

  it('undoes, marks the record, pushes the vault and then Cloud Connect, and acknowledges nothing', async () => {
    const w = withYes();
    expect(await undoReview(w.ports, { id: 'replace:r1', hash: 'line replace:r1' })).toEqual({ kind: 'done' });
    expect(w.calls).toEqual(['applyUndo replace:r1 line replace:r1', 'pushVault', 'pushCloud 7']);
    expect(w.state().records).toEqual([{ ...replaceRecord, undone_at: new Date(2026, 10, 26, 15, 0, 0).toISOString() }]);
  });

  it('passes on a changed line and a refusal with its reason, and leaves the record alone', async () => {
    const w = withYes();
    expect(await undoReview(w.ports, { id: 'replace:r1', hash: 'stale' })).toEqual({ kind: 'changed', message: REVIEW_CHANGED });
    expect(await undoReview(w.ports, { id: 'replace:r1', hash: 'refuse' })).toEqual({ kind: 'refused', message: "This can't be undone here: the memory that replaced it was forgotten." });
    expect(w.state().records).toEqual([replaceRecord]);
    expect(w.calls.filter((c) => c.startsWith('push'))).toEqual([]);
  });

  it('has nothing to undo for a record this phone does not hold, or one already undone', async () => {
    const w = world({ state: { ...EMPTY_REVIEW_STATE, records: [{ ...replaceRecord, undone_at: '2026-11-26T16:00:00.000Z' }] } });
    expect(await undoReview(w.ports, { id: 'replace:r1', hash: 'x' })).toEqual({ kind: 'changed', message: REVIEW_CHANGED });
    expect(await undoReview(w.ports, { id: 'replace:other', hash: 'x' })).toEqual({ kind: 'changed', message: REVIEW_CHANGED });
    expect(w.calls).toEqual([]);
  });
});

describe('No', () => {
  it('drops the request without a sync check or any vault call', async () => {
    const w = world({ sync: 'behind' });
    expect(await noReview(w.ports, item('forget:a'))).toEqual({ kind: 'done' });
    expect(w.calls).toEqual(['decline forget']);
  });

  it('says so when another device already answered, and when the connector is too old', async () => {
    const w = world();
    expect(await noReview(w.ports, { request: { kind: 'replace', replace_id: 'settled' } })).toEqual({ kind: 'refused', message: REVIEW_SETTLED });
    expect(await noReview(w.ports, { request: { kind: 'forget', entry_id: 'old-server' } })).toEqual({ kind: 'refused', message: REVIEW_OLDER_CONNECTOR });
  });
});

describe('Not now, the list and the count', () => {
  it('hides an item until local midnight, then shows it again', async () => {
    const items = [item('forget:a'), item('forget:b')];
    const w = world({ items, now: new Date(2026, 10, 26, 15, 0, 0) });
    expect((await refreshReview(w.ports)).items.map((i) => i.id)).toEqual(['forget:a', 'forget:b']);

    await notNowReview(w.ports, items[0]!);
    expect(w.state().notNow).toEqual({ 'forget:a': new Date(2026, 10, 27, 0, 0, 0).toISOString() });
    expect(w.calls.filter((c) => c !== 'fetch')).toEqual([]);

    w.setNow(new Date(2026, 10, 26, 23, 59, 0));
    const late = await refreshReview(w.ports);
    expect([late.items.map((i) => i.id), late.hidden]).toEqual([['forget:b'], 1]);

    w.setNow(new Date(2026, 10, 27, 0, 1, 0));
    const next = await refreshReview(w.ports);
    expect([next.items.map((i) => i.id), next.hidden]).toEqual([['forget:a', 'forget:b'], 0]);
    expect(w.state().notNow).toEqual({});
  });

  it('sets the badge to what needs a yes and is not hidden, and counts the same between refreshes', async () => {
    const items = [item('forget:a'), item('forget:b')];
    const w = world({ items });
    await refreshReview(w.ports);
    await notNowReview(w.ports, items[0]!);
    const view = await refreshReview(w.ports);
    expect(w.badge).toEqual([2, 1, 1]);
    expect(view.waiting_on_mac).toBe(2);
    expect(reviewCount(w.state(), new Date(2026, 10, 26, 16, 0, 0))).toBe(1);
    expect(reviewCount(w.state(), new Date(2026, 10, 27, 0, 1, 0))).toBe(2);
  });

  it('lists the yes records this phone kept, and reads kept state defensively', async () => {
    const w = world({ state: { ...EMPTY_REVIEW_STATE, records: [replaceRecord] } });
    expect((await refreshReview(w.ports)).accepted.map((l) => [l.id, l.state, l.can_undo])).toEqual([['replace:r1', 'applied', true]]);
    expect(parseReviewState(null)).toEqual(EMPTY_REVIEW_STATE);
    expect(parseReviewState('not json')).toEqual(EMPTY_REVIEW_STATE);
    expect(parseReviewState(JSON.stringify({ records: [replaceRecord, { id: 5 }, null], notNow: { a: 'x', b: 3 }, lastItemIds: ['a', 4] }))).toEqual({
      records: [replaceRecord],
      notNow: { a: 'x' },
      lastItemIds: ['a'],
    });
    expect(nextMidnight(new Date(2026, 10, 26, 15, 0, 0)).getTime()).toBe(new Date(2026, 10, 27, 0, 0, 0).getTime());
  });
});

describe('after the vault is saved', () => {
  it('still pushes the vault, and reports the yes as saved, when the phone cannot write its list', async () => {
    const w = world();
    w.ports.saveState = async () => {
      throw new Error('disk full');
    };
    const out = await yesReview(w.ports, item('replace:r1'), true);
    expect(out).toEqual({ kind: 'done', note: REVIEW_SAVED_NOT_LISTED });
    expect(w.calls).toContain('pushVault');
  });

  it('still pushes the vault, and tells Cloud Connect nothing, when the acknowledgement fails', async () => {
    const w = world({ sync: 'no-server', push: { kind: 'no-server' } });
    w.ports.ack = async () => {
      throw new Error('Cloud Connect is unreachable');
    };
    const out = await yesReview(w.ports, item('replace:r1'), true);
    expect(out).toEqual({ kind: 'done', note: REVIEW_SAVED_NOT_SENT });
    expect(w.calls.filter((c) => c === 'pushVault' || c.startsWith('pushCloud'))).toEqual(['pushVault']);
    expect(w.state().records.map((r) => r.id)).toEqual(['replace:r1']);
  });

  it('keeps a Not now that was saved while an undo ran', async () => {
    const w = world({ state: { records: [replaceRecord], notNow: {}, lastItemIds: [] } });
    const undo = w.ports.applyUndo;
    w.ports.applyUndo = async (record, hash) => {
      await w.ports.saveState({ ...w.state(), notNow: { 'forget:m2': '2026-11-27T05:00:00.000Z' }, lastItemIds: ['forget:m2'] });
      return undo(record, hash);
    };
    expect(await undoReview(w.ports, { id: 'replace:r1', hash: 'line replace:r1' })).toEqual({ kind: 'done' });
    expect(w.state().notNow).toEqual({ 'forget:m2': '2026-11-27T05:00:00.000Z' });
    expect(w.state().lastItemIds).toEqual(['forget:m2']);
    expect(w.state().records[0]?.undone_at).toBeDefined();
  });
});

describe('a Yes the vault refused', () => {
  it('still pushes the vault when the run applied a deletion', async () => {
    const w = world({ yes: { status: 'gone', applied: applied({ applied_forgets: ['m9'] }) } });
    expect(await yesReview(w.ports, item('replace:r1'), true)).toEqual({ kind: 'refused', message: REVIEW_SETTLED });
    expect(w.calls.filter((c) => c === 'pushVault' || c.startsWith('ack'))).toEqual(['pushVault']);
  });

  it('pushes nothing when the run saved nothing', async () => {
    const w = world({ yes: { status: 'gone', applied: applied() } });
    await yesReview(w.ports, item('replace:r1'), true);
    expect(w.calls).not.toContain('pushVault');
  });
});

const answerItem: NeedsYesItem = {
  id: 'answer:q1',
  kind: 'answer',
  scope: 'harbor',
  app: 'Cloud Two',
  arrived: '2026-11-26T14:00:00.000Z',
  boxes: [
    { label: '1', memory_id: 'm1', text: 'The ferry leaves at 9.' },
    { label: '2', memory_id: 'm2', text: 'The ferry leaves at 10.' },
  ],
  not_shared_now: false,
  request: { kind: 'answer', record_id: 'q1' },
  report: { said: 'It is 10 now, they changed it.', answer: 'second', fact: null },
  hash: 'hash of q1',
};

const chatLine = (id: string, at: string, over: Partial<AcceptedLine> = {}): AcceptedLine => ({
  id,
  kind: 'answer',
  at,
  state: 'applied',
  by: 'chat',
  app: 'Cloud Two',
  box: { label: 'New', memory_id: 'm2', text: 'The ferry leaves at 10.' },
  retired: null,
  can_undo: true,
  hash: `line ${id}`,
  ...over,
});

describe('an answer an app reported (ADR 0092)', () => {
  it('Yes and No are refused when the phone is not in sync, and touch nothing', async () => {
    const w = world({ sync: 'behind' });
    expect(await yesReview(w.ports, answerItem, false)).toEqual({ kind: 'refused', message: REVIEW_NOT_IN_SYNC });
    expect(await noReview(w.ports, answerItem)).toEqual({ kind: 'refused', message: REVIEW_NOT_IN_SYNC });
    expect(w.calls).toEqual([]);
  });

  it('Yes writes the vault and pushes it, with no Cloud Connect read and no acknowledgement', async () => {
    const w = world();
    expect(await yesReview(w.ports, answerItem, false)).toEqual({ kind: 'done' });
    expect(w.calls).toEqual(['applyAnswer answer:q1 hash of q1 yes', 'pushVault', 'pushCloud 7']);
    expect(w.state().records).toEqual([]);
  });

  it('No is a vault write too, and never declines on the connector', async () => {
    const w = world();
    expect(await noReview(w.ports, answerItem)).toEqual({ kind: 'done' });
    expect(w.calls).toEqual(['applyAnswer answer:q1 hash of q1 no', 'pushVault', 'pushCloud 7']);
  });

  it('passes on a changed card, a settled one and a refusal, and pushes nothing', async () => {
    const fresh = { ...answerItem, hash: 'new hash' };
    const changed = world({ answer: { status: 'changed', item: fresh } });
    expect(await yesReview(changed.ports, answerItem, false)).toEqual({ kind: 'changed', message: REVIEW_CHANGED, item: fresh });
    const gone = world({ answer: { status: 'gone' } });
    expect(await yesReview(gone.ports, answerItem, false)).toEqual({ kind: 'refused', message: REVIEW_SETTLED });
    const refused = world({ answer: { status: 'refused', reason: 'it was changed since' } });
    expect(await noReview(refused.ports, answerItem)).toEqual({ kind: 'refused', message: 'Nothing changed: it was changed since.' });
    expect(reviewAnswerRefused('it was changed since')).toBe('Nothing changed: it was changed since.');
    for (const w of [changed, gone, refused]) expect(w.calls.filter((c) => c.startsWith('push') || c.startsWith('ack'))).toEqual([]);
  });

  it('Undo of an answer accepted in chat goes to the vault, not the kept records', async () => {
    const w = world({ state: { ...EMPTY_REVIEW_STATE, records: [replaceRecord] } });
    expect(await undoReview(w.ports, { id: 'answer:q1', hash: 'line answer:q1', kind: 'answer' })).toEqual({ kind: 'done' });
    expect(w.calls).toEqual(['undoAnswer answer:q1 line answer:q1', 'pushVault', 'pushCloud 7']);
    expect(w.state().records).toEqual([replaceRecord]);
    expect(await undoReview(w.ports, { id: 'answer:q1', hash: 'refuse', kind: 'answer' })).toEqual({ kind: 'refused', message: "This can't be undone here: the memory it kept was changed since." });
    expect(await undoReview(w.ports, { id: 'answer:q1', hash: 'stale', kind: 'answer' })).toEqual({ kind: 'changed', message: REVIEW_CHANGED });
  });

  it('counts answers accepted in chat since the Review screen last looked, and a background read never resets it', async () => {
    const lines = [
      chatLine('answer:a', '2026-11-26T15:30:00.000Z'),
      chatLine('answer:b', '2026-11-26T15:40:00.000Z', { state: 'both' }),
      chatLine('answer:c', '2026-11-26T15:45:00.000Z', { by: 'phone' }),
      chatLine('answer:d', '2026-11-26T15:50:00.000Z', { state: 'undone', can_undo: false }),
      chatLine('answer:e', '2026-11-26T14:00:00.000Z'),
    ];
    const w = world({ lines, now: new Date('2026-11-26T16:00:00.000Z') });
    expect((await refreshReview(w.ports)).chat_since).toBe(0);
    expect(w.state().lookedAt).toBeUndefined();
    expect((await refreshReview(w.ports, { looked: true })).chat_since).toBe(0);
    expect(w.state().lookedAt).toBe('2026-11-26T16:00:00.000Z');
    w.setNow(new Date('2026-11-26T17:00:00.000Z'));
    expect(chatSince(lines, '2026-11-26T15:00:00.000Z')).toBe(2);
    await refreshReview(w.ports);
    expect(w.state().lookedAt).toBe('2026-11-26T16:00:00.000Z');
    expect(parseReviewState(JSON.stringify({ ...EMPTY_REVIEW_STATE, lookedAt: 'not a time' }))).toEqual(EMPTY_REVIEW_STATE);
    expect(parseReviewState(JSON.stringify({ ...EMPTY_REVIEW_STATE, lookedAt: '2026-11-26T16:00:00.000Z' })).lookedAt).toBe('2026-11-26T16:00:00.000Z');
  });
});
