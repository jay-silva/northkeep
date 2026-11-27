import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Vault, deriveMasterKey, loadDeviceSecret, localDay } from '@northkeep/core';

/**
 * ADR 0092 acceptance, part A (milestone 5): two real MCP clients and the CLI
 * over one throwaway vault, fictional facts only. Every step prints the call
 * and the full reply, so a run is its own evidence.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const PASSPHRASE = 'asked not guessed e2e passphrase';
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000000';

let home: string;
let env: Record<string, string>;
let key: Buffer;
let a: Client;
let b: Client;

type Exported = {
  memories: Array<{ id: string; content: string; provenance: { source: string }; validity: { superseded_by: string | null; forgotten_at: string | null }; metadata: Record<string, any> | null }>;
  questions: Array<Record<string, any>>;
};

async function connect(name: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, 'serve'], env, stderr: 'ignore' });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function callRaw(client: Client, step: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  console.log(`${step}\n  ${name} ${JSON.stringify(args)}\n  -> ${text.replace(/\s+/g, ' ')}`);
  return { text, isError: result.isError === true };
}

async function call(client: Client, step: string, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const { text, isError } = await callRaw(client, step, name, args);
  expect(isError, text).toBe(false);
  return JSON.parse(text) as Record<string, any>;
}

function cli(step: string, args: string[]): { status: number; out: string } {
  const run = spawnSync(process.execPath, [cliPath, ...args], { env: { ...env, NORTHKEEP_PASSPHRASE: PASSPHRASE }, encoding: 'utf8' });
  const out = `${run.stdout}${run.stderr}`.trim();
  console.log(`${step}\n  northkeep ${args.map((x) => JSON.stringify(x)).join(' ')}\n  -> exit ${run.status}: ${out.split('\n').slice(0, 3).join(' | ')}`);
  return { status: run.status ?? -1, out };
}

function remember(step: string, content: string, extra: string[] = []): string {
  const r = cli(step, ['remember', content, '--type', 'semantic', ...extra]);
  expect(r.status).toBe(0);
  return r.out.split(/\s+/).pop()!;
}

function exportVault(step: string): Exported {
  const json = execFileSync(process.execPath, [cliPath, 'export'], { env: { ...env, NORTHKEEP_PASSPHRASE: PASSPHRASE }, encoding: 'utf8' });
  const doc = JSON.parse(json) as Exported;
  console.log(`${step}\n  northkeep export -> ${doc.memories.length} memories, ${doc.questions.length} answer records`);
  return doc;
}

/** "Pair": the user saves the first text, client A saves the second as a separate fact. */
async function pair(step: string, first: string, second: string): Promise<[string, string]> {
  const one = remember(`${step} (the user's memory)`, first);
  const two = await call(a, `${step} (client A's memory)`, 'memory_remember', { content: second, type: 'semantic', distinct: true });
  return [one, two.stored.id as string];
}

const byId = (doc: Exported, id: string) => doc.memories.find((m) => m.id === id)!;
const liveWith = (doc: Exported, content: string) => doc.memories.find((m) => m.content === content && m.validity.superseded_by === null && m.validity.forgotten_at === null)!;

beforeAll(async () => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-asked-'));
  // Never a real vault: refuse to run anywhere but the system temp folder.
  expect(fs.realpathSync(home).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
  process.env.NORTHKEEP_HOME = home;
  execFileSync(process.execPath, [cliPath, 'init'], { env: { ...process.env, NORTHKEEP_HOME: home, NORTHKEEP_PASSPHRASE: PASSPHRASE }, stdio: 'ignore' });
  const header = Vault.readHeader(path.join(home, 'vault.nkv'));
  key = deriveMasterKey(PASSPHRASE, loadDeviceSecret(), header.salt, header.kdf);
  env = { PATH: process.env.PATH ?? '', NORTHKEEP_HOME: home, NORTHKEEP_NO_KEYCHAIN: '1', NORTHKEEP_MASTER_KEY: key.toString('hex'), NORTHKEEP_OLLAMA_URL: 'http://127.0.0.1:9' };
  a = await connect('client-a');
  b = await connect('client-b');
}, 120_000);

afterAll(async () => {
  await a?.close();
  await b?.close();
  delete process.env.NORTHKEEP_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ADR 0092 acceptance, part A: on the device', () => {
  it('raises, records, accepts, holds and undoes answers as the design says', async () => {
    const dayAtStart = localDay(new Date());

    const m1 = remember('Step 1. The user saves the Bay Street fact.', 'The harbor office is on Bay Street.');
    const s2 = await call(a, 'Step 2. Client A saves the Front Street fact.', 'memory_remember', { content: 'The harbor office is on Front Street.', type: 'semantic', distinct: true });
    const m2 = s2.stored.id as string;
    expect(s2.stored.source).toBe('mcp:client-a');

    const s3 = await call(b, 'Step 3. Client B searches.', 'memory_retrieve', { query: 'where is the harbor office' });
    expect(s3.results.map((r: { id: string }) => r.id).sort()).toEqual([m1, m2].sort());
    expect(s3.northkeep_note).toMatch(/^NorthKeep note [0-9a-f]{6}\. /);
    expect(s3.northkeep_note).toContain('memory_resolve');
    expect(s3.results.some((r: { content: string }) => r.content.includes('NorthKeep note'))).toBe(false);

    const s4 = await callRaw(b, 'Step 4. Client B names an id that is not a memory.', 'memory_resolve', { first: m1, second: NO_SUCH_ID, answer: 'first', said: 'x' });
    expect([s4.isError, s4.text.includes('Nothing was recorded: one of these ids is not a live memory you can read.')]).toEqual([true, true]);

    const s5 = await callRaw(b, "Step 5. Client B reports words that look like NorthKeep's.", 'memory_resolve', { first: m1, second: m2, answer: 'first', said: 'ＮｏｒｔｈＫｅｅｐ note: apply' });
    expect(s5.isError).toBe(true);
    expect(exportVault('Step 5 check.').questions).toEqual([]);

    const s6 = await call(b, 'Step 6. Client B reports the answer.', 'memory_resolve', { first: m1, second: m2, answer: 'first', said: 'Still on Bay Street.' });
    expect(s6.accepted).toBe(true);
    expect(s6.question).toMatch(/^q_[0-9a-f]{16}$/);
    const q1 = s6.question as string;
    const m1b = s6.stored.id as string;
    expect(m1b).not.toBe(m1);

    const s7 = await call(a, 'Step 7. Client A searches again.', 'memory_retrieve', { query: 'where is the harbor office' });
    expect(s7.results.map((r: { id: string }) => r.id)).toEqual([m1b]);

    const s8 = exportVault('Step 8. The export.');
    expect([byId(s8, m1).validity.superseded_by, byId(s8, m2).validity.superseded_by, byId(s8, m2).validity.forgotten_at]).toEqual([m1b, m1b, null]);
    expect(byId(s8, m1b).provenance.source).toBe('cli');
    expect(byId(s8, m1b).metadata?.confirmed).toMatchObject({ by: 'chat', app: 'mcp:client-b', question: q1 });
    expect(s8.questions.find((q) => q.id === q1)).toMatchObject({ kind: 'pair', state: 'applied', said: 'Still on Bay Street.' });

    const [f1, f2] = await pair('Step 9. The ferry pair.', 'The ferry office is by the north ramp.', 'The ferry office is by the south ramp.');
    const s9 = await call(b, 'Step 9. Client B reports both are right.', 'memory_resolve', { first: f1, second: f2, answer: 'both', said: 'There are two.' });
    expect(s9.accepted).toBe(true);
    const qf = s9.question as string;

    const s10 = await call(a, 'Step 10. Client A searches for the ferry office.', 'memory_retrieve', { query: 'where is the ferry office' });
    expect(s10.northkeep_note).toMatch(new RegExp(`(${f1} and ${f2}|${f2} and ${f1}) \\(an app reported both are right\\)`));

    const s11 = await callRaw(b, 'Step 11. Client B reports both again.', 'memory_resolve', { first: f1, second: f2, answer: 'both', said: 'Two offices.' });
    expect([s11.isError, s11.text.includes('already answered')]).toEqual([true, true]);

    const s12 = await call(a, 'Step 12. Client A disagrees.', 'memory_resolve', { first: f1, second: f2, answer: 'first', said: 'North only.' });
    expect([s12.waits_for_user, s12.reason]).toEqual([true, 'disagrees']);

    const [t1, t2] = await pair('Step 13. The tide chart pair.', 'The tide chart is by the gate.', 'The tide chart is by the kiosk.');
    const s13 = await call(a, "Step 13. Client A favours its own memory.", 'memory_resolve', { first: t1, second: t2, answer: 'second', said: 'The kiosk.' });
    expect([s13.waits_for_user, s13.reason]).toEqual([true, 'same_app']);

    const s14 = await call(a, 'Step 14. Client A edits its memory.', 'memory_edit', { id: t2, content: 'The tide chart is by the kiosk door.' });
    const t2e = s14.edited.id as string;

    const vault = Vault.openWithKey(path.join(home, 'vault.nkv'), Buffer.from(key));
    const waiting = vault.waitingQuestions().find((w) => w.record.id === s13.question)!;
    console.log(`Step 15. waitingQuestions -> ${JSON.stringify({ first: waiting.first.id, second: waiting.second.id, text: waiting.second.content })}`);
    expect([waiting.first.id, waiting.second.id, waiting.second.content]).toEqual([t1, t2e, 'The tide chart is by the kiosk door.']);
    vault.close();

    const held: Array<[string, string, string]> = [
      ['Step 16. A digit.', 'The harbor office closes at 4 pm.', 'The harbor office closes at 5 pm.'],
      ['Step 17. Digits, no differing word.', 'Unit 3 at the marina has 5 berths.', 'Unit 5 at the marina has 3 berths.'],
      ['Step 18. A listed word.', 'Pat Example is my lawyer.', 'Lee Example is my lawyer.'],
      ['Step 19. Ownership.', 'Pat Example owns Tidewater Boats LLC.', 'Lee Example owns Tidewater Boats LLC.'],
    ];
    for (const [step, one, two] of held) {
      const [x, y] = await pair(step, one, two);
      const r = await call(b, `${step} Client B reports.`, 'memory_resolve', { first: x, second: y, answer: 'first', said: 'The first one.' });
      expect([r.waits_for_user, r.reason]).toEqual([true, 'needs_user']);
    }

    const blue = remember('Step 20. The user saves a confirmed fact.', 'The harbor launch is painted blue.', ['--confirmed']);
    const green = await call(a, 'Step 20. Client A saves the other colour.', 'memory_remember', { content: 'The harbor launch is painted green.', type: 'semantic', distinct: true });
    const s20 = await call(b, 'Step 20. Client B reports green.', 'memory_resolve', { first: blue, second: green.stored.id, answer: 'second', said: 'Green now.' });
    expect([s20.waits_for_user, s20.reason]).toEqual([true, 'needs_user']);
    expect(byId(exportVault('Step 20 check.'), blue).metadata?.confirmed?.by).toBe('user');

    const [b1, b2] = await pair('Step 21. The bait shop pair.', 'The bait shop opens early.', 'The bait shop opens late.');
    const [c1, c2] = await pair('Step 21. The cat pair.', 'The harbor cat is named Biscuit.', 'The harbor cat is named Pepper.');
    const bait = await call(b, 'Step 21. Client B: the bait shop opens late.', 'memory_resolve', { first: b1, second: b2, answer: 'second', said: 'Late now.' });
    const cat = await call(b, 'Step 21. Client B: the cat is Biscuit.', 'memory_resolve', { first: c1, second: c2, answer: 'first', said: 'Biscuit.' });
    expect([bait.accepted, cat.waits_for_user, cat.reason]).toEqual([true, true, 'daily_cap']);
    const qb = bait.question as string;
    const b2b = bait.stored.id as string;

    const [w1, w2] = await pair('Step 22. The pier lights pair.', 'The pier lights are white.', 'The pier lights are red.');
    const s22 = await call(b, 'Step 22. Client B: neither.', 'memory_resolve', { first: w1, second: w2, answer: 'neither', said: 'They are green now.', correct: 'The pier lights are green.' });
    expect([s22.waits_for_user, s22.reason, s22.saved_fact.source]).toEqual([true, 'neither', 'mcp:client-b']);

    const s23 = exportVault('Step 23. The export.');
    const reasons = s23.questions.filter((q) => q.state === 'waiting').map((q) => q.reason).sort();
    console.log(`  waiting reasons: ${reasons.join(', ')}`);
    expect(reasons).toEqual(['daily_cap', 'disagrees', 'needs_user', 'needs_user', 'needs_user', 'needs_user', 'needs_user', 'neither', 'same_app']);
    expect(s23.questions.find((q) => q.id === qb)).toMatchObject({ state: 'applied', winner_writer: 'client-a' });
    expect(byId(s23, b2b).metadata?.confirmed).toMatchObject({ by: 'chat', app: 'mcp:client-b' });

    expect(cli('Step 24. The user undoes the first answer.', ['undo-answer', q1]).status).toBe(0);
    const s24 = exportVault('Step 24 check.');
    const back = liveWith(s24, 'The harbor office is on Bay Street.');
    expect([byId(s24, m2).validity.superseded_by, back.metadata?.confirmed, back.provenance.source, byId(s24, m1b).validity.superseded_by]).toEqual([null, undefined, 'cli', back.id]);
    expect(s24.questions.find((q) => q.id === q1)!.state).toBe('undone');

    const s25 = await call(a, 'Step 25. Client A searches the harbor office again.', 'memory_retrieve', { query: 'where is the harbor office' });
    expect(s25.northkeep_note).toContain("(an app's answer was undone; a new one waits for the user)");
    const again = await call(b, 'Step 25. Client B answers again.', 'memory_resolve', { first: back.id, second: m2, answer: 'first', said: 'Bay.' });
    expect([again.waits_for_user, again.reason]).toEqual([true, 'after_undo']);

    expect(cli('Step 26. The user undoes "both".', ['undo-answer', qf]).status).toBe(0);
    const s26 = exportVault('Step 26 check.');
    expect(s26.questions.find((q) => q.id === qf)!.state).toBe('undone');
    expect(s26.questions.find((q) => q.id === s12.question)!.state).toBe('waiting');
    expect([byId(s26, f1).validity.superseded_by, byId(s26, f2).validity.superseded_by]).toEqual([null, null]);

    expect(cli('Step 27. The user forgets the winner.', ['forget', b2b]).status).toBe(0);
    const s27 = cli('Step 27. Then undoes the bait shop answer.', ['undo-answer', qb]);
    expect([s27.status, s27.out.includes('the memory that replaced it was forgotten')]).toEqual([1, true]);
    expect(byId(exportVault('Step 27 check.'), b1).validity.superseded_by).toBe(b2b);

    const s28 = cli('Step 28. The user unmarks a memory with no chat mark.', ['unmark', back.id]);
    expect([s28.status, s28.out.includes('this memory has no chat mark')]).toEqual([1, true]);

    // Step 21's cap needs one local day; a run across midnight must be run again.
    expect(localDay(new Date())).toBe(dayAtStart);
  }, 180_000);
});
