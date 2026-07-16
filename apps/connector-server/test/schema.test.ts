import { describe, expect, it } from 'vitest';
import { SCHEMA_SQL, SCHEMA_STATEMENTS } from '../src/neon-storage.js';

/**
 * Regression guard for the ADR 0010 rule (the M5b production outage): Neon's
 * serverless HTTP driver executes ONE statement per call, so a multi-statement
 * schema string throws at runtime and 500s every request (unit/e2e never catch
 * it — they run InMemoryStorage). Every schema entry must be a single statement,
 * and anyone adding a table must add a new ARRAY ENTRY, not append to a string.
 */
describe('Neon connector schema statements', () => {
  it('each entry is a single SQL statement (no internal semicolons)', () => {
    expect(SCHEMA_STATEMENTS.length).toBeGreaterThanOrEqual(7);
    for (const statement of SCHEMA_STATEMENTS) {
      expect(statement.replace(/'[^']*'/g, ''), statement.slice(0, 40)).not.toContain(';');
    }
  });

  it('covers every connector table, and SCHEMA_SQL stays the human-readable join', () => {
    const all = SCHEMA_STATEMENTS.join('\n');
    for (const table of [
      'connector_accounts',
      'pairing_codes',
      'oauth_clients',
      'oauth_codes',
      'oauth_tokens',
      'shared_entries',
      'scope_tombstones',
      'connector_audit',
    ]) {
      expect(all, table).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(SCHEMA_SQL, table).toContain(table);
    }
  });
});
