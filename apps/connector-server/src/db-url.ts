/**
 * Resolve the Postgres connection string from the environment (copied from
 * apps/sync-server/src/db-url.ts). Different Vercel storage integrations inject
 * it under different names — DATABASE_URL, POSTGRES_URL, or a prefixed
 * `<PREFIX>_URL`. The value never leaves the deploy environment; this only reads
 * process.env.
 *
 * NOTE (ADR 0016): the connector uses a SEPARATE Neon database from the sync
 * server, so the deploy environment points these vars at the connector DB.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'DATABASE_POSTGRES_URL']) {
    const value = env[name];
    if (value && isPostgresUrl(value)) return value;
  }
  // Fallback: any *_URL (or *_URL_* pooled variant) that is a Postgres URL —
  // covers a custom integration prefix like STORAGE_URL. Prefer a pooled URL.
  const candidates = Object.entries(env)
    .filter(([key, value]) => /URL/.test(key) && typeof value === 'string' && isPostgresUrl(value))
    .map(([, value]) => value as string);
  const pooled = candidates.find((u) => u.includes('-pooler.') || u.includes('pgbouncer=true'));
  return pooled ?? candidates[0] ?? null;
}

function isPostgresUrl(value: string): boolean {
  return value.startsWith('postgres://') || value.startsWith('postgresql://');
}
