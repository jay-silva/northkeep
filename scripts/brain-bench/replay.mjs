// Replays the searches agents really made in a finished run against ranking
// rules, and counts how often the answer comes back. It costs no model usage
// and gives the same number every time, so ranking ideas can be compared
// before any is built into the product.
//
//   node scripts/brain-bench/replay.mjs scripts/brain-bench/out/<run>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUESTIONS } from './world.mjs';
import { PASSPHRASE, seedHome } from './seed.mjs';
import { has } from './grade.mjs';

const DAY = 86_400_000;
const TYPE_PRIORITY = { identity: 0.15, semantic: 0.1, procedural: 0.05 };
/** Designs whose agents searched the untouched pile of memories. */
const PILE_ARMS = ['search', 'brief', 'nudge', 'pages', 'pages-index'];
/** Kinds of question whose answer is a memory, so a search can be scored on it. */
const SCORED = new Set(['core', 'direct', 'paraphrase', 'stale', 'changed', 'split', 'own_stale', 'same_name']);

/** The share of rows holding each query word. */
function shares(queryTerms, rows) {
  return new Map([...queryTerms].map((term) => [term, rows.filter((row) => row.terms.has(term)).length / Math.max(1, rows.length)]));
}

/**
 * One ranking rule: given the rows and a query, the rows it would return.
 * `core` is NorthKeep's own search-rules module, so the shipped pieces are
 * the real ones and only the idea under test is written here.
 */
export function makeRules(core) {
  const base = (row, matched, size, now) => {
    const overlap = Math.max(0, matched / size - core.lengthPenalty(row.terms.size));
    const recency = 0.3 * Math.exp(-Math.max(0, now - Date.parse(row.entry.created_at)) / DAY / 30);
    return { overlap, bonus: recency + (TYPE_PRIORITY[row.entry.type] ?? 0), confirmed: core.isConfirmed(row.entry.metadata) };
  };
  const order = (scored, now) => scored.sort((a, b) =>
    Number(a.weak === true) - Number(b.weak === true)
    || Number(core.isOldAgentNote(a.row.entry, now)) - Number(core.isOldAgentNote(b.row.entry, now))
    || b.score - a.score);
  const matches = (row, terms) => [...terms].filter((term) => row.terms.has(term));
  const commonOver = (share, queryTerms, rows) => (rows.length < 20 ? new Set() : new Set([...shares(queryTerms, rows)].filter(([, s]) => s > share).map(([term]) => term)));

  return {
    'As shipped (0.29.0)': (rows, q, now) => order(rows.flatMap((row) => {
      const m = matches(row, q).length;
      if (m === 0) return [];
      const b = base(row, m, q.size, now);
      return [{ row, score: b.overlap + b.bonus + (b.confirmed ? core.CONFIRMED_BOOST : 0) }];
    }), now),

    'Fix 1: drop common words': (rows, q, now) => {
      const common = commonOver(0.25, q, rows);
      let counted = new Set([...q].filter((term) => !common.has(term)));
      if (counted.size === 0 || !rows.some((row) => matches(row, counted).length > 0)) counted = q;
      return order(rows.flatMap((row) => {
        const m = matches(row, counted).length;
        if (m === 0) return [];
        const b = base(row, m, counted.size, now);
        return [{ row, score: b.overlap + b.bonus + (b.confirmed ? core.CONFIRMED_BOOST : 0) }];
      }), now);
    },

    'Fix 2: common-only matches last': (rows, q, now) => {
      const common = commonOver(0.1, q, rows);
      return order(rows.flatMap((row) => {
        const hit = matches(row, q);
        if (hit.length === 0) return [];
        const b = base(row, hit.length, q.size, now);
        return [{ row, score: b.overlap + b.bonus + (b.confirmed ? core.CONFIRMED_BOOST : 0), weak: hit.every((term) => common.has(term)) }];
      }), now);
    },

    'Fix 3: confirmed common-only matches last': (rows, q, now) => {
      const common = commonOver(0.1, q, rows);
      return order(rows.flatMap((row) => {
        const hit = matches(row, q);
        if (hit.length === 0) return [];
        const b = base(row, hit.length, q.size, now);
        return [{ row, score: b.overlap + b.bonus + (b.confirmed ? core.CONFIRMED_BOOST : 0), weak: b.confirmed && hit.every((term) => common.has(term)) }];
      }), now);
    },

    // Every word counts by how rare it is, and the bonuses scale with the match instead of adding to it.
    'Fix 4: weigh words by rarity': (rows, q, now) => {
      const share = shares(q, rows);
      const weight = (term) => Math.log(1 + (1 - share.get(term) + 0.5 / rows.length) / (share.get(term) + 0.5 / rows.length));
      const total = [...q].reduce((sum, term) => sum + weight(term), 0);
      return order(rows.flatMap((row) => {
        const hit = matches(row, q);
        if (hit.length === 0) return [];
        const b = base(row, hit.length, q.size, now);
        const overlap = Math.max(0, hit.reduce((sum, term) => sum + weight(term), 0) / total - core.lengthPenalty(row.terms.size));
        return [{ row, score: overlap * (1 + b.bonus + (b.confirmed ? core.CONFIRMED_BOOST : 0)) }];
      }), now);
    },
  };
}

/** True when the rows returned, taken together, hold the whole answer. */
export function holdsAnswer(question, contents) {
  const text = contents.join('\n');
  return question.must.every((group) => group.some((phrase) => has(text, phrase)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = path.resolve(process.argv[2] ?? '');
  if (!fs.existsSync(run)) throw new Error('Give the folder of a finished run, for example scripts/brain-bench/out/<run>.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bench-replay-'));
  await seedHome(path.join(work, 'home'));
  const core = await import('../../packages/core/dist/index.js');
  const vault = core.Vault.open({ path: path.join(work, 'home', 'vault.nkv'), passphrase: PASSPHRASE, deviceSecret: core.loadDeviceSecret() });
  const now = Date.now();
  const all = vault.list().filter((entry) => entry.superseded_at === null && !core.isProjectPaperwork(entry)).map((entry) => ({ entry, terms: core.searchTerms(entry.content) }));
  vault.close();
  fs.rmSync(work, { recursive: true, force: true });

  const byId = new Map(QUESTIONS.map((question) => [question.id, question]));
  const searches = [];
  for (const arm of PILE_ARMS) {
    const dir = path.join(run, arm);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      const row = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const question = byId.get(row.id);
      if (row.error || !question || !SCORED.has(question.cat)) continue;
      const calls = row.tool_calls.filter((call) => call.name.endsWith('__memory_retrieve') && typeof call.input?.query === 'string');
      if (calls.length > 0) searches.push({ question, session: `${arm}/${row.id}`, calls: calls.map((call) => call.input) });
    }
  }

  const rules = makeRules(core);
  const results = Object.fromEntries(Object.keys(rules).map((name) => [name, { calls: 0, callHits: 0, sessions: 0, sessionHits: 0, lost: [], gained: [] }]));
  const shipped = Object.keys(rules)[0];
  for (const { question, session, calls } of searches) {
    const hitBy = {};
    for (const [name, rank] of Object.entries(rules)) {
      let any = false;
      for (const input of calls) {
        const rows = all.filter((row) => (!input.type || row.entry.type === input.type) && (!input.scope || row.entry.scope === input.scope));
        const queryTerms = core.searchTerms(input.query);
        const top = queryTerms.size === 0 ? [] : rank(rows, queryTerms, now).slice(0, input.limit ?? 8).map((s) => s.row.entry.content);
        const hit = holdsAnswer(question, top);
        results[name].calls += 1;
        if (hit) results[name].callHits += 1;
        any ||= hit;
      }
      results[name].sessions += 1;
      if (any) results[name].sessionHits += 1;
      hitBy[name] = any;
    }
    for (const name of Object.keys(rules)) {
      if (hitBy[shipped] && !hitBy[name]) results[name].lost.push(`${session}: ${calls.map((c) => `"${c.query}"`).join(', ')}`);
      if (!hitBy[shipped] && hitBy[name]) results[name].gained.push(`${session}: ${calls.map((c) => `"${c.query}"`).join(', ')}`);
    }
  }

  console.log(`Replayed ${results[shipped].calls} recorded searches from ${results[shipped].sessions} sessions in ${run}\n`);
  console.log('| Rule | Searches that returned the answer | Sessions where some search did | Answers gained | Answers lost |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const [name, r] of Object.entries(results)) console.log(`| ${name} | ${r.callHits} of ${r.calls} | ${r.sessionHits} of ${r.sessions} | ${r.gained.length} | ${r.lost.length} |`);
  for (const [name, r] of Object.entries(results)) {
    if (name === shipped) continue;
    console.log(`\n${name}`);
    for (const line of r.gained) console.log(`  gained  ${line}`);
    for (const line of r.lost) console.log(`  LOST    ${line}`);
  }
}
