import { describe, expect, it } from 'vitest';
import { SCHEMA_SQL, SCHEMA_STATEMENTS } from '../src/neon-storage.js';

/**
 * Regression guard for the M5b production outage: Neon's serverless HTTP
 * driver executes ONE statement per call, so a multi-statement schema string
 * throws at runtime and 500s every request (unit/e2e never catch it — they
 * run InMemoryStorage). Encode the invariant here: every schema entry must be
 * a single statement, and anyone adding a table must add a new ARRAY ENTRY,
 * not append to an existing string.
 */
describe('Neon schema statements', () => {
  it('each entry is a single SQL statement (no internal semicolons)', () => {
    expect(SCHEMA_STATEMENTS.length).toBeGreaterThanOrEqual(2);
    for (const statement of SCHEMA_STATEMENTS) {
      // Strip string literals defensively, then assert no semicolon remains
      // (a trailing one would also break the one-statement-per-call rule).
      expect(statement.replace(/'[^']*'/g, ''), statement.slice(0, 40)).not.toContain(';');
    }
  });

  it('covers both tables, and SCHEMA_SQL stays the human-readable join', () => {
    const all = SCHEMA_STATEMENTS.join('\n');
    expect(all).toContain('CREATE TABLE IF NOT EXISTS sync_blobs');
    expect(all).toContain('CREATE TABLE IF NOT EXISTS subscriptions');
    expect(SCHEMA_SQL).toContain('sync_blobs');
    expect(SCHEMA_SQL).toContain('subscriptions');
  });
});
