import { describe, expect, it } from 'vitest';
import type { CallLogEntry } from '../src/log.js';
import { openSessions } from '../src/open-sessions.js';

/**
 * ADR 0052 Decision 2. openSessions is pure over call-log rows, so every case
 * here is a hand-built log: no vault, no server, no wall clock.
 */

const NOW = new Date('2026-09-21T12:00:00.000Z');
const SCOPE = 'project:northkeep';
const CURRENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function row(
  ts: string,
  tool: string,
  session_id: string | undefined,
  extra: Partial<CallLogEntry> = {},
): CallLogEntry {
  return {
    ts,
    tool,
    provider: 'claude-code@2.1',
    ok: true,
    params: { scope: SCOPE },
    ...(session_id ? { session_id } : {}),
    ...extra,
  };
}

describe('openSessions', () => {
  it('reports a session that read and never wrote back', () => {
    const open = openSessions(
      [row('2026-09-20T09:00:00.000Z', 'project_resume', A)],
      SCOPE,
      CURRENT,
      NOW,
    );
    expect(open).toEqual([
      {
        session_id: A,
        host: 'claude-code',
        opened_at: '2026-09-20T09:00:00.000Z',
        last_read_at: '2026-09-20T09:00:00.000Z',
      },
    ]);
  });

  it('keeps the first read as opened_at and the newest as last_read_at', () => {
    const open = openSessions(
      [
        row('2026-09-20T09:00:00.000Z', 'project_get', A),
        row('2026-09-20T11:00:00.000Z', 'project_resume', A),
      ],
      SCOPE,
      CURRENT,
      NOW,
    );
    expect(open[0]).toMatchObject({
      opened_at: '2026-09-20T09:00:00.000Z',
      last_read_at: '2026-09-20T11:00:00.000Z',
    });
  });

  for (const tool of ['project_update', 'project_checkpoint', 'project_wrap']) {
    it(`is closed by a successful ${tool}`, () => {
      const open = openSessions(
        [
          row('2026-09-20T09:00:00.000Z', 'project_resume', A),
          row('2026-09-20T10:00:00.000Z', tool, A),
        ],
        SCOPE,
        CURRENT,
        NOW,
      );
      expect(open).toEqual([]);
    });
  }

  it('stays open when the write failed', () => {
    const open = openSessions(
      [
        row('2026-09-20T09:00:00.000Z', 'project_resume', A),
        row('2026-09-20T10:00:00.000Z', 'project_wrap', A, { ok: false }),
      ],
      SCOPE,
      CURRENT,
      NOW,
    );
    expect(open).toHaveLength(1);
  });

  it('a write from another session does not close this one', () => {
    const open = openSessions(
      [
        row('2026-09-20T09:00:00.000Z', 'project_resume', A),
        row('2026-09-20T10:00:00.000Z', 'project_wrap', B),
      ],
      SCOPE,
      CURRENT,
      NOW,
    );
    expect(open.map((s) => s.session_id)).toEqual([A]);
  });

  it('excludes a read older than the window', () => {
    const open = openSessions(
      [row('2026-08-01T09:00:00.000Z', 'project_resume', A)],
      SCOPE,
      CURRENT,
      NOW,
    );
    expect(open).toEqual([]);
  });

  it('excludes the current session', () => {
    const open = openSessions(
      [row('2026-09-20T09:00:00.000Z', 'project_resume', CURRENT)],
      SCOPE,
      CURRENT,
      NOW,
    );
    expect(open).toEqual([]);
  });

  it('skips rows with no session id', () => {
    const open = openSessions(
      [row('2026-09-20T09:00:00.000Z', 'project_resume', undefined)],
      SCOPE,
      CURRENT,
      NOW,
    );
    expect(open).toEqual([]);
  });

  it('returns only the three newest', () => {
    const rows = ['1', '2', '3', '4', '5'].map((n) =>
      row(`2026-09-1${n}T09:00:00.000Z`, 'project_resume', `session-${n}`),
    );
    const open = openSessions(rows, SCOPE, CURRENT, NOW);
    expect(open.map((s) => s.session_id)).toEqual(['session-5', 'session-4', 'session-3']);
  });

  it('ignores reads and writes on another project scope', () => {
    const other = { params: { scope: 'project:other' } };
    const open = openSessions(
      [
        row('2026-09-20T09:00:00.000Z', 'project_resume', A, other),
        row('2026-09-20T09:30:00.000Z', 'project_resume', B),
        row('2026-09-20T10:00:00.000Z', 'project_wrap', B, other),
      ],
      SCOPE,
      CURRENT,
      NOW,
    );
    expect(open.map((s) => s.session_id)).toEqual([B]);
  });

  it('takes the host from the provider name half', () => {
    const open = openSessions(
      [row('2026-09-20T09:00:00.000Z', 'project_resume', A, { provider: 'codex-mcp-client@0.9.1' })],
      SCOPE,
      CURRENT,
      NOW,
    );
    expect(open[0]?.host).toBe('codex-mcp-client');
  });
});
