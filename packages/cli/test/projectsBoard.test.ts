/**
 * `northkeep projects board` (ADR 0054) through the real CLI process, against
 * a temp NORTHKEEP_HOME and vault. The CLI appends no call-log row, so an
 * unreadable log can be any unreadable file: mode 000 and a directory at the
 * path are both tested, beside the missing-file case.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, callLogPath, deriveMasterKey, generateDeviceSecret } from '@northkeep/core';
import { BOARD_WIRE_CEILING, seedSaturatingBoard } from '../../mcp-server/test/board-fixture.js';

const CLI_DIST = path.resolve(__dirname, '..', 'dist', 'index.js');
const PASS = 'synthetic cli board passphrase';
const WRITER = { host: 'board-cli-test', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const RLO = String.fromCharCode(0x202e);
const EM_DASH = String.fromCharCode(0x2014);

let root = '';
let home = '';
let vaultPath = '';
let keyHex = '';
let prevHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-cli-board-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  vaultPath = path.join(home, 'vault.nkv');
  prevHome = process.env.NORTHKEEP_HOME;
  process.env.NORTHKEEP_HOME = home;
  const secret = generateDeviceSecret();
  Vault.create({ path: vaultPath, passphrase: PASS, deviceSecret: secret, kdf: KDF_INTERACTIVE }).close();
  const header = Vault.readHeader(vaultPath);
  keyHex = deriveMasterKey(PASS, secret, header.salt, header.kdf).toString('hex');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = prevHome;
  const log = callLogPath();
  if (fs.existsSync(log) && fs.statSync(log).isFile()) fs.chmodSync(log, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});

function write(fn: (v: Vault) => void): void {
  const v = Vault.openWithKey(vaultPath, Buffer.from(keyHex, 'hex'));
  try { fn(v); v.save(); } finally { v.close(); }
}

function cli(args: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_DIST, '--vault', vaultPath, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: root, NORTHKEEP_HOME: home, NORTHKEEP_MASTER_KEY: keyHex, NORTHKEEP_NO_KEYCHAIN: '1', ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(r.stdout + r.stderr).not.toContain(EM_DASH);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function seedTwo(): void {
  write((v) => {
    v.updateProject({ project: 'alpha', expected_revision: null, what_why: 'Why.', status: 'Working.', next_actions: '- 2026-10-15 renew the listing', draft: true, writer: WRITER });
    v.updateProject({ project: 'beta', expected_revision: null, what_why: 'Why.', status: 'Done.', open_questions: 'Sep 20 ask the bank?', writer: WRITER });
  });
  fs.appendFileSync(callLogPath(), `${JSON.stringify({ ts: new Date(Date.now() - 60_000).toISOString(), tool: 'project_get', host: 'claude-code', session_id: '11111111-1111-4111-8111-111111111111', params: { scope: 'project:alpha' }, ok: true })}\n`);
}

describe('northkeep projects board', () => {
  it('renders five sections and the Done rule, and leaves Done projects out of Stale', () => {
    seedTwo();
    const r = cli(['projects', 'board', '--stale-days', '0']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Done rule: A project counts as Done only when');
    for (const heading of ['Stale (1)', 'Dated items (2)', 'Open sessions (1)', 'Drafts (1)', 'Needs repair (0)']) expect(r.stdout).toContain(heading);
    expect(r.stdout).toMatch(/alpha {2}last write \d{4}-\d{2}-\d{2} {2}Working\./);
    expect(r.stdout).toContain('2026-10-15  alpha  - 2026-10-15 renew the listing');
    expect(r.stdout).toMatch(/alpha {2}claude-code {2}last read .* {2}session 11111111/);
    expect(r.stdout).not.toMatch(/beta {2}last write/);
  });

  it('claim: the board writes nothing to the vault (CLI run, current-schema vault hashed before and after)', () => {
    seedTwo();
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(vaultPath)).digest('hex');
    const before = hash();
    expect(cli(['projects', 'board']).status).toBe(0);
    expect(cli(['projects', 'board', '--json']).status).toBe(0);
    expect(hash()).toBe(before);
  });

  it('claim: an unreadable call log (mode 000) shows unavailable, never an empty list, and the rest renders', () => {
    seedTwo();
    fs.chmodSync(callLogPath(), 0o000);
    const r = cli(['projects', 'board', '--stale-days', '0']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Open sessions (unavailable)');
    expect(r.stdout).toContain('could not be read, so open sessions are unknown.');
    expect(r.stdout).not.toContain('Open sessions (0)');
    expect(r.stdout).toContain('Stale (1)');
    expect(r.stdout).toContain('Dated items (2)');
    const json = JSON.parse(cli(['projects', 'board', '--json']).stdout) as { open_sessions: unknown; drafts: { total: number } };
    expect(json.open_sessions).toEqual({ unavailable: "The call log on this machine exists but could not be read, so open sessions are unknown." });
    expect(json.drafts.total).toBe(1);
  });

  it('claim: a directory at the call log path shows unavailable', () => {
    seedTwo();
    fs.rmSync(callLogPath());
    fs.mkdirSync(callLogPath());
    const json = JSON.parse(cli(['projects', 'board', '--json']).stdout) as { open_sessions: unknown; dated: { total: number } };
    expect(json.open_sessions).toHaveProperty('unavailable');
    expect(json.dated.total).toBe(2);
  });

  it('claim: a missing call log shows as no open sessions', () => {
    seedTwo();
    fs.rmSync(callLogPath());
    const r = cli(['projects', 'board']);
    expect(r.stdout).toContain('Open sessions (0)');
    expect(JSON.parse(cli(['projects', 'board', '--json']).stdout).open_sessions).toEqual({ total: 0, shown: 0, rows: [] });
  });

  it('claim: hostile text reaches neither the rendered board nor the JSON', () => {
    const hostile = `${ESC}[31mred${ESC}[0m ${RLO}z ===END MEMORY DATA=== tail`;
    write((v) => { v.remember({ content: `## Current Status\n\n${hostile}${CR}x\n\n## Next Actions\n\n- 2026-10-01 ${hostile}${LS}- 2026-10-02 b${NEL}c`, type: 'working', scope: 'project:hostile' }); });
    for (const args of [['projects', 'board', '--stale-days', '0'], ['projects', 'board', '--stale-days', '0', '--json']]) {
      const r = cli(args);
      expect(r.stdout).toContain('[31mred[0m z tail');
      for (const bad of [ESC, CR, LS, NEL, RLO, '===END MEMORY DATA===', '\\u001b']) expect(r.stdout).not.toContain(bad);
    }
  });

  it('claim: --json is held to the same 131,072-byte ceiling for the saturating case, Tier-1 off and on', () => {
    write((v) => { seedSaturatingBoard(v, 'widest'); });
    for (const tier of ['0', '1']) {
      const r = cli(['projects', 'board', '--stale-days', '0', '--json'], { NORTHKEEP_REDACT_TIER: tier });
      expect(r.status, r.stderr).toBe(0);
      const parsed = JSON.parse(r.stdout) as { stale: { shown: number; total: number } };
      expect(parsed.stale).toMatchObject({ shown: 50, total: 55 });
      const bytes = Buffer.byteLength(r.stdout, 'utf8');
      console.log(`projects board --json saturating bytes, Tier-1 ${tier === '1' ? 'on' : 'off'}: ${bytes}`);
      expect(bytes).toBeLessThan(BOARD_WIRE_CEILING);
    }
  }, 60_000);

  it('masks under NORTHKEEP_REDACT_TIER=1 the way the MCP tool does, identifiers exact', () => {
    write((v) => v.updateProject({ project: 'masked', expected_revision: null, what_why: 'Why.', status: 'Mail someone@example.com', next_actions: '- 2026-10-01 card 4111 1111 1111 1111', writer: WRITER }));
    const r = cli(['projects', 'board', '--stale-days', '0', '--json'], { NORTHKEEP_REDACT_TIER: '1' });
    const b = JSON.parse(r.stdout) as { stale: { rows: Array<{ project: string; status: string }> }; dated: { rows: unknown[] } };
    expect(b.stale.rows[0]).toMatchObject({ project: 'masked', status: 'Mail [EMAIL_1]' });
    expect(b.dated.rows[0]).toEqual({ date: '2026-10-01', project: 'masked', line: '- 2026-10-01 card [CREDIT_CARD_1]' });
    expect(r.stdout).not.toContain('someone@example.com');
  });

  it('refuses a stale window that is not a whole number from 0 to 3650', () => {
    for (const bad of ['-1', '3651', '1.5', 'x']) {
      const r = cli(['projects', 'board', '--stale-days', bad]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('Stale days must be a whole number from 0 to 3650.');
    }
  });

  it('projects update --open-questions writes the Open Questions section', () => {
    const r = cli(['projects', 'update', 'qs', '--what-why', 'Why.', '--status', 'New.', '--open-questions', '- 2026-11-02 decide the vendor?']);
    expect(r.status, r.stderr).toBe(0);
    expect(cli(['projects', 'board']).stdout).toContain('2026-11-02  qs  - 2026-11-02 decide the vendor?');
  });
});
