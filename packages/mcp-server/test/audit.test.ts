import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditAsCsv } from '../src/audit.js';
import { callLogPath } from '@northkeep/core';
import { appendCallLog, readCallLogStrict } from '../src/log.js';
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

describe('readCallLogStrict', () => {
  it('reads an empty list when no log exists yet, and throws on a log it cannot read', () => {
    expect(readCallLogStrict()).toEqual([]);
    appendCallLog({ ts: '2026-09-23T00:00:00Z', tool: 'memory_list', provider: 'p', ok: true });
    expect(readCallLogStrict()).toHaveLength(1);
    fs.chmodSync(callLogPath(), 0o200);
    try {
      expect(() => readCallLogStrict()).toThrow('could not be read');
    } finally {
      fs.chmodSync(callLogPath(), 0o600);
    }
    fs.rmSync(callLogPath());
    fs.mkdirSync(callLogPath());
    expect(() => readCallLogStrict()).toThrow('could not be read');
  });
});


describe('ADR 0060 D7: readers fold pending rows', () => {
  it('C18c: a finished call is one row; an unfinished one is labelled, never shown as success', async () => {
    const { auditAsJson } = await import('../src/audit.js');
    const { readCallLog } = await import('../src/log.js');
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    appendCallLog({ ts: old, tool: 'memory_list', ok: false, error: 'pending', phase: 'pending', call_id: 'a', params: {} });
    appendCallLog({ ts: old, tool: 'memory_list', ok: true, phase: 'done', call_id: 'a', params: {}, result_count: 2 });
    appendCallLog({ ts: old, tool: 'memory_remember', ok: false, error: 'pending', phase: 'pending', call_id: 'b', params: {} });
    appendCallLog({ ts: fresh, tool: 'memory_list', ok: false, error: 'pending', phase: 'pending', call_id: 'c', params: {} });
    appendCallLog({ ts: fresh, tool: 'converse', ok: true, params: {} });
    const rows = readCallLog();
    expect(rows.map((r) => [r.tool, r.ok, r.outcome_label])).toEqual([
      ['memory_list', true, undefined],
      ['memory_remember', false, 'outcome unknown (interrupted)'],
      ['memory_list', false, 'in progress'],
      ['converse', true, undefined],
    ]);
    // Counting is by call, after folding: the last two calls, not the last two raw rows.
    expect(readCallLog(2).map((r) => r.tool)).toEqual(['memory_list', 'converse']);
    expect(auditAsJson()).toHaveLength(4);
    const csv = auditAsCsv().trim().split('\n');
    expect(csv[0]!.endsWith(',session_id,phase,call_id')).toBe(true);
    expect(csv).toHaveLength(5);
    expect(csv[2]).toContain('pending (outcome unknown (interrupted))');
    // The raw file keeps every row for derivations.
    expect(readCallLogStrict()).toHaveLength(5);
  });
});
