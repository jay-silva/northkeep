import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('scripts/adr-0053-canary.sh (M-A1)', () => {
  it('exits 0 with no canary fired and every control live', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-canary-'));
    try {
      const r = spawnSync('/bin/bash', ['scripts/adr-0053-canary.sh'], {
        cwd: REPO_ROOT,
        env: { PATH: '/usr/bin:/bin', TMPDIR: tmp },
        encoding: 'utf8',
        timeout: 110_000,
      });
      expect(r.stdout).toContain('result M-A1: PASS');
      const lines = r.stdout.split('\n');
      const at = lines.indexOf('canaries fired:');
      expect(at).toBeGreaterThan(-1);
      expect(lines[at + 1]).toBe('  (none)');
      expect(r.status).toBe(0);
      expect(fs.readdirSync(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
