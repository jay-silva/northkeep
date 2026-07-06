import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditAsCsv } from '../src/audit.js';
import { appendCallLog } from '../src/log.js';
import { grantedScopes } from '../src/server.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-audit-'));
  prevHome = process.env.NORTHKEEP_HOME;
  process.env.NORTHKEEP_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('audit CSV formula-injection guard', () => {
  it('neuters cells that would execute as spreadsheet formulas', () => {
    appendCallLog({ ts: '2026-07-06T00:00:00Z', tool: 'memory_list', provider: '=cmd|calc', ok: true });
    appendCallLog({ ts: '2026-07-06T00:00:01Z', tool: 'memory_list', provider: '@SUM(1)', ok: true });
    appendCallLog({ ts: '2026-07-06T00:00:02Z', tool: 'memory_list', provider: '+HYPERLINK("x")', ok: true });
    const csv = auditAsCsv();
    // No cell begins a formula: each dangerous value is apostrophe-prefixed.
    for (const line of csv.split('\n').slice(1).filter(Boolean)) {
      const providerCell = line.split(',')[1] ?? '';
      expect(/^"?[=+\-@]/.test(providerCell)).toBe(false);
    }
    expect(csv).toContain("'=cmd|calc");
    expect(csv).toContain("'@SUM(1)");
  });
});

describe('grantedScopes fail-closed parsing', () => {
  function withEnv(value: string | undefined, fn: () => void): void {
    const prev = process.env.NORTHKEEP_SCOPES;
    if (value === undefined) delete process.env.NORTHKEEP_SCOPES;
    else process.env.NORTHKEEP_SCOPES = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.NORTHKEEP_SCOPES;
      else process.env.NORTHKEEP_SCOPES = prev;
    }
  }

  it('unset ⇒ full owner access (undefined)', () => {
    withEnv(undefined, () => expect(grantedScopes()).toBeUndefined());
  });

  it('present but empty/whitespace/commas ⇒ deny-all (NOT full access)', () => {
    for (const bad of ['', '   ', ',', ' , ']) {
      withEnv(bad, () => expect(grantedScopes(), `"${bad}" must not grant full access`).toEqual([]));
    }
  });

  it('named scopes ⇒ exactly those', () => {
    withEnv('personal, client:henderson', () =>
      expect(grantedScopes()).toEqual(['personal', 'client:henderson']),
    );
  });
});
