/**
 * ADR 0060 C18c through the real CLI: `northkeep log` shows one line per
 * call, labels a call with no outcome, and counts calls, not raw rows.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const CLI_DIST = path.resolve(__dirname, '..', 'dist', 'index.js');
let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-cli-log-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

it('C18c (CLI): pending rows fold into their outcome; an unfinished call reads as interrupted', () => {
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const rows = [
    { ts: old, tool: 'memory_list', ok: false, error: 'pending', phase: 'pending', call_id: 'a', params: {} },
    { ts: old, tool: 'memory_list', ok: true, phase: 'done', call_id: 'a', params: {}, result_count: 2 },
    { ts: old, tool: 'memory_remember', ok: false, error: 'pending', phase: 'pending', call_id: 'b', params: {} },
  ];
  fs.writeFileSync(path.join(home, 'mcp-calls.log'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = spawnSync(process.execPath, [CLI_DIST, 'log', '-n', '2'], {
    env: { PATH: '/usr/bin:/bin', HOME: home, NORTHKEEP_HOME: home, NORTHKEEP_NO_KEYCHAIN: '1' },
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  const lines = r.stdout.trim().split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^✓ .* memory_list .*→ 2 results/);
  expect(lines[1]).toMatch(/^… .* memory_remember .*→ outcome unknown \(interrupted\)/);
  expect(r.stdout).not.toContain('pending');
});
