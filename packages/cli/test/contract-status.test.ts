/** `northkeep contract status` through the real CLI, against a temp HOME. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const CLI_DIST = path.resolve(__dirname, '..', 'dist', 'index.js');
const V0221_CLAUDE = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'mcp-server', 'test', 'fixtures', 'contract-v0.22.1-claude.md'),
  'utf8',
);
let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-cli-contract-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function status(): string {
  const r = spawnSync(process.execPath, [CLI_DIST, 'contract', 'status'], {
    env: { PATH: '/usr/bin:/bin', HOME: home, NORTHKEEP_HOME: path.join(home, '.northkeep'), NORTHKEEP_NO_KEYCHAIN: '1' },
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split('\n').find((line) => line.trim().startsWith('Claude Code')) ?? '';
}

it('prints stale for an earlier release and edited for a file the user changed', () => {
  const file = path.join(home, '.claude', 'rules', 'northkeep-projects.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, V0221_CLAUDE);
  expect(status()).toMatch(/^ {2}Claude Code +stale +\//);
  fs.writeFileSync(file, `${V0221_CLAUDE}My own line.\n`);
  expect(status()).toMatch(/^ {2}Claude Code +edited +\//);
});
