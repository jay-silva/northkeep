/**
 * ADR 0060 code review item 5: `northkeep redact --tier 3` and `converse
 * --tier 3` used to run Tier 1 and say so nowhere. A tier is now honoured or
 * refused by name (invariant 6). The name model is pointed at a closed port.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const CLI_DIST = path.resolve(__dirname, '..', 'dist', 'index.js');
let home = '';
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-cli-tier-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI_DIST, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: home, NORTHKEEP_HOME: home, NORTHKEEP_NO_KEYCHAIN: '1', NORTHKEEP_OLLAMA_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8',
  });
}

it('redact --tier 3 runs Tier 3: dates to the year and listed names, with a loud note when the name model is down', () => {
  const r = cli(['redact', '--tier', '3', 'Donna Keller was born 03/15/1948, mail donna@example.com']);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).not.toMatch(/03\/15\/1948|Donna Keller|donna@example\.com/);
  expect(r.stdout).toContain('[DATE-1948]');
  expect(r.stderr).toContain('Tier 3 ran its built-in date and name lists only');
});

it('redact and converse refuse a tier they do not have, by name', () => {
  for (const bad of ['4', 'two', '0']) {
    const r = cli(['redact', '--tier', bad, 'mail bob@example.com']);
    expect(r.status, bad).not.toBe(0);
    expect(r.stdout, bad).toBe('');
    expect(r.stderr, bad).toContain(`--tier ${bad} is not 1, 2 or 3.`);
  }
  const c = cli(['converse', '--tier', '5']);
  expect(c.status).not.toBe(0);
  expect(c.stderr).toContain('--tier 5 is not 0, 1, 2 or 3.');
});
