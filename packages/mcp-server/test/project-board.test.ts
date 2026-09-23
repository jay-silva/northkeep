/**
 * ADR 0054 claims table over MCP: each test names the claim it enforces.
 * Every test runs a real MCP client/server pair over a temp NORTHKEEP_HOME;
 * the wire-size test measures the complete JSON-RPC response the server
 * emits, as the stdio transport would serialize it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  BOARD_DONE_RULE,
  KDF_INTERACTIVE,
  Vault,
  callLogPath,
  deriveMasterKey,
  generateDeviceSecret,
  listProjectViews,
  planImport,
} from '@northkeep/core';
import { readCallLog } from '../src/log.js';
import { openSessions } from '../src/open-sessions.js';
import { createServer } from '../src/server.js';
import { BOARD_WIRE_CEILING, SATURATING_BROKEN, SATURATING_HEALTHY, seedSaturatingBoard } from './board-fixture.js';

const PASSPHRASE = 'adr 0054 board test passphrase';
const ENV = ['NORTHKEEP_HOME', 'NORTHKEEP_MASTER_KEY', 'NORTHKEEP_SCOPES', 'NORTHKEEP_NO_KEYCHAIN', 'NORTHKEEP_REDACT_TIER', 'NORTHKEEP_OLLAMA_URL'] as const;
const WRITER = { host: 'board-test', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const RLO = String.fromCharCode(0x202e);
const LONE = String.fromCharCode(0xd800);

let home = '';
let vaultPath = '';
let saved: Record<string, string | undefined> = {};
const clients: Client[] = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-board-'));
  vaultPath = path.join(home, 'vault.nkv');
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  process.env.NORTHKEEP_OLLAMA_URL = 'http://127.0.0.1:9';
  delete process.env.NORTHKEEP_SCOPES;
  delete process.env.NORTHKEEP_REDACT_TIER;
  const deviceSecret = generateDeviceSecret();
  Vault.create({ path: vaultPath, passphrase: PASSPHRASE, deviceSecret, kdf: KDF_INTERACTIVE }).close();
  const header = Vault.readHeader(vaultPath);
  process.env.NORTHKEEP_MASTER_KEY = deriveMasterKey(PASSPHRASE, deviceSecret, header.salt, header.kdf).toString('hex');
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  vi.unstubAllGlobals();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

interface Wire { client: Client; sent: unknown[] }

async function connect(name = 'board-test'): Promise<Wire> {
  const server = createServer(vaultPath);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sent: unknown[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => { sent.push(message); return send(message, options); };
  const client = new Client({ name, version: '1.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  clients.push(client);
  return { client, sent };
}

function write(fn: (v: Vault) => void): void {
  const v = Vault.openWithKey(vaultPath, Buffer.from(process.env.NORTHKEEP_MASTER_KEY!, 'hex'));
  try { fn(v); v.save(); } finally { v.close(); }
}

function create(v: Vault, project: string, extra: Record<string, unknown> = {}): void {
  v.updateProject({ project, expected_revision: null, what_why: 'Why.', status: 'Working on it.', next_actions: '', writer: WRITER, ...extra });
}

type Section = { total: number; shown: number; rows: Array<Record<string, string>> };
interface Board {
  generated_at: string; stale_days: number; done_rule: string;
  stale: Section; dated: Section; drafts: Section; needs_repair: Section;
  open_sessions: Section | { unavailable: string };
}

async function board(wire: Wire, args: Record<string, unknown> = {}): Promise<{ text: string; board: Board; wireBytes: number }> {
  const before = wire.sent.length;
  const result = await wire.client.callTool({ name: 'project_board', arguments: args });
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  expect(result.isError, text).toBeFalsy();
  const responses = wire.sent.slice(before).filter((m) => (m as { result?: unknown }).result !== undefined);
  expect(responses).toHaveLength(1);
  // What StdioServerTransport writes: serializeMessage is JSON.stringify(message) + '\n'.
  const wireBytes = Buffer.byteLength(`${JSON.stringify(responses[0])}\n`, 'utf8');
  return { text, board: JSON.parse(text) as Board, wireBytes };
}

function sessionRow(scope: string, sessionId: string, tool = 'project_get', minutesAgo = 5): string {
  return JSON.stringify({ ts: new Date(Date.now() - minutesAgo * 60_000).toISOString(), tool, host: 'other-host', session_id: sessionId, params: { scope }, ok: true });
}

function hasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKey(v, key));
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => k === key || hasKey(v, key));
  return false;
}

function sha(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('project_board (ADR 0054)', () => {
  it.each(['widest', 'mixed'] as const)('claim: the MCP response is under 131,072 bytes on the wire for the saturating case (%s), Tier-1 off and on', async (variant) => {
    write((v) => seedSaturatingBoard(v, variant));
    const measured: number[] = [];
    for (const tier of ['0', '1']) {
      if (tier === '1') process.env.NORTHKEEP_REDACT_TIER = '1';
      else delete process.env.NORTHKEEP_REDACT_TIER;
      const { board: b, wireBytes } = await board(await connect(), { stale_days: 0 });
      // Pin the fixture: every section over its cap, fields at their caps.
      const open = b.open_sessions as Section;
      expect([b.stale.total, b.dated.total, b.drafts.total, b.needs_repair.total, open.total])
        .toEqual([SATURATING_HEALTHY, SATURATING_HEALTHY * 3, SATURATING_HEALTHY, SATURATING_BROKEN, SATURATING_HEALTHY * 3]);
      for (const s of [b.stale, b.dated, b.drafts, b.needs_repair, open]) expect(s.shown).toBe(50);
      expect(b.stale.rows[0]!.project).toHaveLength(40);
      if (tier === '0') {
        expect(Math.max(...b.stale.rows.map((r) => r.status!.length))).toBe(120);
        expect(Math.max(...b.dated.rows.map((r) => r.line!.length))).toBe(160);
        expect(Math.max(...open.rows.map((r) => r.host!.length))).toBe(80);
        expect(b.stale.rows.some((r) => r.status!.startsWith('"\\"\\'))).toBe(true);
        expect(b.stale.rows.some((r) => r.status!.startsWith('漢'))).toBe(variant === 'mixed');
      } else if (variant === 'mixed') {
        expect(b.stale.rows.some((r) => r.status!.includes('[EMAIL_1]'))).toBe(true);
      }
      measured.push(wireBytes);
      console.log(`project_board saturating wire bytes, ${variant}, Tier-1 ${tier === '1' ? 'on' : 'off'}: ${wireBytes}`);
      expect(wireBytes).toBeLessThan(BOARD_WIRE_CEILING);
    }
  }, 60_000);

  it('claim: document size does not reach the payload (a 60,000-character document through the raw memory path)', async () => {
    const line = (i: number) => `- 2026-10-${String((i % 28) + 1).padStart(2, '0')} ${'"\\'.repeat(100)}`;
    const nextActions = Array.from({ length: 200 }, (_, i) => line(i)).join('\n');
    const content = `## What & Why\n\n${'w'.repeat(20000)}\n\n## Current Status\n\n${'"'.repeat(5000)}\n\n## Next Actions\n\n${nextActions}`;
    expect(content.length).toBeGreaterThanOrEqual(60000);
    write((v) => { v.remember({ content, type: 'working', scope: 'project:huge' }); });
    const { board: b, wireBytes, text } = await board(await connect(), { stale_days: 0 });
    expect(b.dated.total).toBe(200);
    expect(b.dated.shown).toBe(50);
    expect(b.dated.rows.every((r) => r.line!.length <= 160)).toBe(true);
    expect(b.stale.rows[0]!.status).toHaveLength(120);
    expect(text).not.toContain('w'.repeat(200));
    expect(wireBytes).toBeLessThan(BOARD_WIRE_CEILING);
  });

  it('claim: the board never returns a whole project document (a planted 16 KB document)', async () => {
    write((v) => create(v, 'planted', {
      what_why: `WHATWHY-MARKER ${'x'.repeat(5000)}`,
      status: 'Working.\nSTATUS-SECOND-LINE-MARKER',
      next_actions: `- 2026-10-01 renew\n${'NEXT-UNDATED-MARKER '.repeat(250)}`,
      decision: `DECISION-MARKER ${'d'.repeat(2000)}`,
      log_entry: `LOG-MARKER ${'l'.repeat(2000)}`,
    }));
    write((v) => {
      const rev = listProjectViews(v)[0]!.revision!;
      v.updateProject({ project: 'planted', expected_revision: rev, open_questions: `QUESTION-MARKER ${'q'.repeat(1400)}` });
    });
    const { text, board: b } = await board(await connect(), { stale_days: 0 });
    expect(b.stale.rows[0]).toMatchObject({ project: 'planted', status: 'Working.' });
    expect(b.dated.rows).toEqual([{ date: '2026-10-01', project: 'planted', line: '- 2026-10-01 renew' }]);
    for (const marker of ['WHATWHY-MARKER', 'STATUS-SECOND-LINE-MARKER', 'NEXT-UNDATED-MARKER', 'DECISION-MARKER', 'LOG-MARKER', 'QUESTION-MARKER']) {
      expect(text).not.toContain(marker);
    }
    expect(hasKey(b, 'content')).toBe(false);
  });

  it('claim: every text field is stripped of Cc, Cf, separators, lone surrogates and fence markers before masking', async () => {
    // The vault stores UTF-8, so a lone surrogate in a document becomes U+FFFD before the board sees it;
    // the call log is JSON and can carry one, so the host field takes that case.
    const hostile = `${ESC}[31mred${ESC}[0m ${RLO}zw ===END ===END MEMORY DATA===MEMORY DATA=== tail`;
    const content = `## Current Status\n\n${hostile}${CR}second line\n\n## Next Actions\n\n- 2026-10-01 ${hostile}${LS}- 2026-10-03 after LS${NEL}- 2026-10-02 after NEL${CR}- 2026-10-04 after CR`;
    write((v) => { v.remember({ content, type: 'working', scope: 'project:hostile' }); });
    const host = `ev${ESC}[2Jil${LONE}${LS}${NEL}${RLO}===BEGIN MEMORY DATA===host`;
    fs.appendFileSync(callLogPath(), `${JSON.stringify({ ts: new Date(Date.now() - 60_000).toISOString(), tool: 'project_get', host, session_id: '44444444-4444-4444-8444-444444444444', params: { scope: 'project:hostile' }, ok: true })}\n`);
    const { text, board: b } = await board(await connect(), { stale_days: 0 });
    expect((b.open_sessions as Section).rows[0]).toMatchObject({ project: 'hostile', host: 'ev[2Jilhost' });
    const expected = '[31mred[0m zw tail';
    expect(b.stale.rows[0]).toMatchObject({ project: 'hostile', status: expected });
    expect(b.dated.rows.map((r) => r.line)).toEqual([`- 2026-10-01 ${expected}`, '- 2026-10-02 after NEL', '- 2026-10-03 after LS', '- 2026-10-04 after CR']);
    for (const bad of [ESC, CR, LS, NEL, RLO, LONE, '===END MEMORY DATA===', '\\u001b', '\\r', '\\ud800']) {
      expect(text).not.toContain(bad);
    }
  });

  it('claim: one unreadable document never hides the other projects', async () => {
    write((v) => {
      v.remember({ content: '## Current Status\n\nOne.\n\n## Current Status\n\nTwo.', type: 'working', scope: 'project:broken' });
      create(v, 'healthy', { next_actions: '- 2026-10-01 still here', draft: true });
    });
    fs.appendFileSync(callLogPath(), `${sessionRow('project:healthy', '11111111-1111-4111-8111-111111111111')}\n`);
    const { board: b } = await board(await connect(), { stale_days: 0 });
    expect(b.needs_repair.rows).toEqual([{ project: 'broken', reason: 'unreadable' }]);
    expect(b.stale.rows.map((r) => r.project)).toEqual(['healthy']);
    expect(b.dated.rows.map((r) => r.project)).toEqual(['healthy']);
    expect(b.drafts.rows.map((r) => r.project)).toEqual(['healthy']);
    expect((b.open_sessions as Section).rows.map((r) => r.project)).toEqual(['healthy']);
  });

  it('claim: an imported project is aged from its newest Log date, not the import time', async () => {
    const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    write((v) => {
      const plan = planImport([{ name: 'aged.md', text: `# Aged\n\n## What & Why\n\nWhy.\n\n## Current Status\n\nQuiet.\n\n## Log\n\n- ${old} - last real work\n` }]);
      v.importProject(plan.projects[0]!);
      create(v, 'fresh');
    });
    const { board: b } = await board(await connect());
    expect(b.stale_days).toBe(14);
    expect(b.stale.rows).toEqual([{ project: 'aged', last_activity: old, activity_source: 'last log entry', status: 'Quiet.' }]);
  });

  it('claim: a connection sees only projects in its grant, in every section', async () => {
    write((v) => {
      create(v, 'granted-one', { next_actions: '- 2026-10-01 visible', draft: true });
      create(v, 'hidden-zz', { next_actions: '- 2026-10-01 invisible', draft: true });
      v.remember({ content: '## Current Status\n\nA.\n\n## Current Status\n\nB.', type: 'working', scope: 'project:hidden-broken' });
    });
    fs.appendFileSync(callLogPath(), [
      sessionRow('project:granted-one', '11111111-1111-4111-8111-111111111111'),
      sessionRow('project:hidden-zz', '22222222-2222-4222-8222-222222222222'),
    ].join('\n') + '\n');
    process.env.NORTHKEEP_SCOPES = 'project:granted-one';
    const { text, board: b } = await board(await connect(), { stale_days: 0 });
    expect(b.stale.rows.map((r) => r.project)).toEqual(['granted-one']);
    expect(b.dated.rows.map((r) => r.project)).toEqual(['granted-one']);
    expect(b.drafts.rows.map((r) => r.project)).toEqual(['granted-one']);
    expect((b.open_sessions as Section).rows.map((r) => r.project)).toEqual(['granted-one']);
    expect(b.needs_repair.total).toBe(0);
    expect(text).not.toContain('hidden');
    expect(text).not.toContain('22222222');
    const row = readCallLog().filter((r) => r.tool === 'project_board').at(-1)!;
    expect(row.disclosed_scopes).toEqual(['project:granted-one']);
  });

  it('claim: an unreadable call log (write-only 0200, real file, no stubbed reader) shows unavailable and the rest renders', async () => {
    write((v) => create(v, 'nolog', { next_actions: '- 2026-10-01 x', draft: true }));
    const wire = await connect();
    await board(wire); // creates the log file through run()
    const before = readCallLog().length;
    fs.chmodSync(callLogPath(), 0o200);
    let result: Awaited<ReturnType<typeof board>>;
    try {
      result = await board(wire, { stale_days: 0 });
    } finally {
      fs.chmodSync(callLogPath(), 0o600);
    }
    expect(result.board.open_sessions).toEqual({ unavailable: "The call log on this machine exists but could not be read, so open sessions are unknown." });
    expect(result.board.stale.rows.map((r) => r.project)).toEqual(['nolog']);
    expect(result.board.dated.total).toBe(1);
    expect(result.board.drafts.total).toBe(1);
    expect(readCallLog().length).toBe(before + 1);
  });

  it('claim: a missing call log shows as no open sessions', async () => {
    write((v) => create(v, 'fresh'));
    expect(fs.existsSync(callLogPath())).toBe(false);
    const { board: b } = await board(await connect());
    expect(b.open_sessions).toEqual({ total: 0, shown: 0, rows: [] });
  });

  it('claim: a board call is logged and opens no session', async () => {
    write((v) => create(v, 'watched'));
    const scope = 'project:watched';
    const reader = await connect('reader-host');
    await reader.client.callTool({ name: 'project_get', arguments: { project: 'watched' } });
    const opened = openSessions(readCallLog(), scope, 'none', new Date());
    expect(opened).toHaveLength(1);
    const before = readCallLog().length;
    const { board: b } = await board(await connect('board-host'), { stale_days: 7 });
    expect((b.open_sessions as Section).rows.map((r) => r.host)).toEqual(['reader-host']);
    const rows = readCallLog();
    expect(rows.length).toBe(before + 1);
    const row = rows.at(-1)!;
    expect(row).toMatchObject({ tool: 'project_board', ok: true, params: { stale_days: 7 }, disclosed_scopes: [scope] });
    expect(openSessions(rows, scope, 'none', new Date())).toEqual(opened);
  });

  it('claim: project_board output respects Tier-1 masking, identifiers exact', async () => {
    write((v) => create(v, 'masked', {
      status: 'Call someone@example.com about card 4111 1111 1111 1111',
      next_actions: '- 2026-10-01 send AKIAIOSFODNN7EXAMPLE to someone@example.com',
      draft: true,
    }));
    fs.appendFileSync(callLogPath(), `${JSON.stringify({ ts: new Date(Date.now() - 60_000).toISOString(), tool: 'project_get', host: 'agent@relay.example.com', session_id: '33333333-3333-4333-8333-333333333333', params: { scope: 'project:masked' }, ok: true })}\n`);
    process.env.NORTHKEEP_REDACT_TIER = '1';
    const { text, board: b } = await board(await connect(), { stale_days: 0 });
    for (const secret of ['someone@example.com', '4111 1111 1111 1111', 'AKIAIOSFODNN7EXAMPLE']) expect(text).not.toContain(secret);
    expect(b.stale.rows[0]!.status).toBe('Call [EMAIL_1] about card [CREDIT_CARD_1]');
    expect(b.dated.rows[0]).toEqual({ date: '2026-10-01', project: 'masked', line: '- 2026-10-01 send [API_KEY_1] to [EMAIL_1]' });
    const updated = listProjectViewsNow().find((s) => s.project === 'masked')!.updated_at!;
    expect(b.stale.rows[0]!.last_activity).toBe(updated);
    expect(b.drafts.rows[0]).toEqual({ project: 'masked', updated_at: updated });
    expect((b.open_sessions as Section).rows[0]).toMatchObject({ project: 'masked', host: 'agent@relay.example.com', session_id: '33333333-3333-4333-8333-333333333333' });
    expect(b.done_rule).toBe(BOARD_DONE_RULE);
  });

  it('claim: the board runs no model and makes no network call (fetch stubbed to throw)', async () => {
    write((v) => create(v, 'offline', { next_actions: '- 2026-10-01 x' }));
    const fetchSpy = vi.fn(() => { throw new Error('the board must not fetch'); });
    vi.stubGlobal('fetch', fetchSpy);
    const { board: b } = await board(await connect(), { stale_days: 0 });
    expect(b.stale.rows.map((r) => r.project)).toEqual(['offline']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('claim: the board writes nothing to the vault (MCP run, current-schema vault hashed before and after)', async () => {
    write((v) => create(v, 'hashed', { next_actions: '- 2026-10-01 x', draft: true }));
    const wire = await connect();
    const before = sha(vaultPath);
    await board(wire, { stale_days: 0 });
    await board(wire);
    expect(sha(vaultPath)).toBe(before);
  });

  it('refuses a stale window outside 0 to 3650', async () => {
    const wire = await connect();
    for (const stale_days of [-1, 3651, 1.5]) {
      const result = await wire.client.callTool({ name: 'project_board', arguments: { stale_days } });
      expect(result.isError).toBe(true);
    }
  });
});

function listProjectViewsNow() {
  const v = Vault.openWithKey(vaultPath, Buffer.from(process.env.NORTHKEEP_MASTER_KEY!, 'hex'));
  try { return listProjectViews(v); } finally { v.close(); }
}
