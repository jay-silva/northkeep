import { describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../src/db-url.js';

describe('resolveDatabaseUrl', () => {
  it('prefers DATABASE_URL', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://a', POSTGRES_URL: 'postgres://b' })).toBe('postgres://a');
  });

  it('falls back to POSTGRES_URL', () => {
    expect(resolveDatabaseUrl({ POSTGRES_URL: 'postgresql://b' })).toBe('postgresql://b');
  });

  it('accepts any *_URL that is a Postgres URL (custom integration prefix)', () => {
    expect(resolveDatabaseUrl({ STORAGE_URL: 'postgres://c' })).toBe('postgres://c');
  });

  it('prefers a pooled connection string when several are present', () => {
    const env = {
      NEON_URL_UNPOOLED: 'postgres://db.neon.tech/x',
      NEON_URL: 'postgres://db-pooler.neon.tech/x',
    };
    expect(resolveDatabaseUrl(env)).toContain('-pooler.');
  });

  it('ignores non-postgres URLs and returns null when none match', () => {
    expect(resolveDatabaseUrl({ SOME_URL: 'https://example.com', OTHER: 'x' })).toBeNull();
    expect(resolveDatabaseUrl({})).toBeNull();
  });
});
