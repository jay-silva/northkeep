import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * A protocol fake of the ADR 0063 connector, written from
 * docs/design/sync-guardrails.md (sections 2, D1, D2, D5), for client tests.
 * It is not the connector: apps/connector-server is built on another branch,
 * and the merged branches must run the same scenarios against it. One account;
 * rows are plaintext because nothing here tests encryption.
 */

export interface FakeRow {
  entry_id: string;
  scope: string;
  type: string;
  content: string;
  pending: boolean;
  /** A vault id, 'new', or null for a legacy row. */
  base_revision: string | null;
  write_seq: number;
}

export interface FakeConnector {
  url: () => string;
  close: () => Promise<void>;
  rows: () => FakeRow[];
  /** D2: the document hosted project_get would serve, or null. */
  head: (scope: string) => FakeRow | null;
  /** Hosted project_update over the served head (base = P, or the current pending row's base). */
  cloudUpdate: (scope: string, content: string) => string;
  /** Hosted project_create: base 'new'. */
  cloudCreate: (scope: string, content: string) => string;
  /** A row as a pre-ADR connector wrote it: no base. */
  seedLegacy: (scope: string, content: string, type?: string) => string;
  /** Hosted memory_remember: a non-working pending row. */
  cloudRemember: (scope: string, content: string, type?: string) => string;
  /** Hosted memory_forget of a pushed entry. */
  cloudForget: (entryId: string) => void;
  vaultPair: () => { server: string; version: number } | null;
  pushes: () => Array<{ scopes: string[]; vault?: { server: string; version: number }; reset?: boolean; status: number }>;
  requests: () => string[];
  setTombstoneEnforce: (on: boolean) => void;
  /** Answer the next request to this path with this status. */
  failNext: (path: string, status: number, body?: unknown) => void;
}

export async function startFakeConnector(options: { tombstoneEnforce?: boolean } = {}): Promise<FakeConnector> {
  const rows = new Map<string, FakeRow>();
  const scopeSeq = new Map<string, number>();
  const forgetQueue: string[] = [];
  const tombstones = new Set<string>();
  let enforce = options.tombstoneEnforce ?? true;
  let pair: { server: string; version: number } | null = null;
  const pushLog: Array<{ scopes: string[]; vault?: { server: string; version: number }; reset?: boolean; status: number }> = [];
  const requestLog: string[] = [];
  const failures = new Map<string, { status: number; body?: unknown }>();

  const bump = (scope: string) => {
    const next = (scopeSeq.get(scope) ?? 0) + 1;
    scopeSeq.set(scope, next);
    return next;
  };
  const inScope = (scope: string) => [...rows.values()].filter((r) => r.scope === scope);
  const pushedHead = (scope: string): FakeRow | null =>
    inScope(scope)
      .filter((r) => !r.pending && r.type === 'working')
      .sort((a, b) => b.write_seq - a.write_seq)[0] ?? null;
  const isCurrent = (row: FakeRow): boolean => {
    if (!row.pending || row.type !== 'working' || row.base_revision === null) return false;
    const p = pushedHead(row.scope);
    return p ? row.base_revision === p.entry_id : row.base_revision === 'new';
  };
  const head = (scope: string): FakeRow | null =>
    inScope(scope).find((r) => r.pending && isCurrent(r)) ?? pushedHead(scope);
  const addPending = (scope: string, content: string, type: string, base: string | null): string => {
    const id = `conn_${randomUUID()}`;
    rows.set(id, { entry_id: id, scope, type, content, pending: true, base_revision: base, write_seq: bump(scope) });
    return id;
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      requestLog.push(`${req.method} ${url.pathname}${url.search}`);
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '{}' : JSON.stringify(body));
      };
      const failure = failures.get(url.pathname);
      if (failure) {
        failures.delete(url.pathname);
        send(failure.status, failure.body);
        return;
      }
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};

      if (req.method === 'GET' && url.pathname === '/client/pending') {
        const v2 = url.searchParams.get('v') === '2';
        const entries = [...rows.values()]
          .filter((r) => r.pending)
          .filter((r) => v2 || !(r.type === 'working' && r.scope.startsWith('project:')))
          .map((r) => ({
            server_id: r.entry_id,
            scope: r.scope,
            type: r.type,
            content: r.content,
            ...(v2 && r.base_revision !== null ? { base_revision: r.base_revision } : {}),
            ...(v2 ? { stale: r.type === 'working' && r.scope.startsWith('project:') && !isCurrent(r) } : {}),
          }));
        send(200, { entries, forgets: forgetQueue.map((entry_id) => ({ entry_id })) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/client/ack') {
        for (const a of (body.acked as Array<{ server_id: string; local_entry_id: string }>) ?? []) {
          const row = rows.get(a.server_id);
          if (!row || !row.pending) continue;
          rows.delete(a.server_id);
          rows.set(a.local_entry_id, { ...row, entry_id: a.local_entry_id, pending: false, write_seq: bump(row.scope) });
        }
        for (const id of (body.forgets as string[]) ?? []) {
          const i = forgetQueue.indexOf(id);
          if (i >= 0) forgetQueue.splice(i, 1);
          const row = rows.get(id);
          if (row) {
            rows.delete(id);
            bump(row.scope);
          }
        }
        send(200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/client/discard') {
        let discarded = 0;
        for (const id of (body.server_ids as string[]) ?? []) {
          const row = rows.get(id);
          if (row?.pending) {
            rows.delete(id);
            bump(row.scope);
            discarded++;
          }
        }
        send(200, { ok: true, discarded });
        return;
      }
      if (req.method === 'PUT' && url.pathname === '/client/entries') {
        const scopes = (body.scopes as string[]) ?? [];
        const vault = body.vault as { server: string; version: number } | undefined;
        const reset = body.reset === true;
        const log = (status: number) => pushLog.push({ scopes, ...(vault ? { vault } : {}), ...(reset ? { reset } : {}), status });
        if (pair !== null && !reset) {
          if (!vault || (vault.server === pair.server && vault.version < pair.version)) {
            log(428);
            send(428, { code: 'stale_push', vault_version: pair.version });
            return;
          }
        }
        const blocked = scopes.filter((s) => tombstones.has(s));
        if (enforce && blocked.length > 0) {
          log(412);
          send(412, { scopes: blocked });
          return;
        }
        if (vault) pair = { server: vault.server, version: vault.version };
        for (const scope of scopes) {
          const seq = bump(scope);
          for (const r of inScope(scope)) if (!r.pending) rows.delete(r.entry_id);
          for (const e of (body.entries as Array<{ entry_id: string; scope: string; type: string; content: string }>) ?? []) {
            if (e.scope !== scope) continue;
            rows.set(e.entry_id, { entry_id: e.entry_id, scope, type: e.type, content: e.content, pending: false, base_revision: null, write_seq: seq });
          }
        }
        log(200);
        send(200, { ok: true });
        return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/client/scope/')) {
        const scope = decodeURIComponent(url.pathname.slice('/client/scope/'.length));
        const doomed = inScope(scope);
        for (const r of doomed) rows.delete(r.entry_id);
        tombstones.add(scope);
        bump(scope);
        send(200, { deleted: doomed.length });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/client/manifest') {
        send(200, {
          entries: [...rows.values()].filter((r) => !r.pending).map((r) => ({ entry_id: r.entry_id, entry_hash: '', scope: r.scope })),
          tombstone_enforce: enforce,
        });
        return;
      }
      send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

  return {
    url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise((r) => server.close(() => r())),
    rows: () => [...rows.values()],
    head,
    cloudUpdate: (scope, content) => {
      const served = head(scope);
      if (!served) throw new Error('no project to update');
      const base = served.pending ? served.base_revision : served.entry_id;
      if (served.pending) rows.delete(served.entry_id);
      return addPending(scope, content, 'working', base);
    },
    cloudCreate: (scope, content) => addPending(scope, content, 'working', 'new'),
    seedLegacy: (scope, content, type = 'working') => addPending(scope, content, type, null),
    cloudRemember: (scope, content, type = 'semantic') => addPending(scope, content, type, null),
    cloudForget: (entryId) => {
      forgetQueue.push(entryId);
    },
    vaultPair: () => pair,
    pushes: () => pushLog,
    requests: () => requestLog,
    setTombstoneEnforce: (on) => {
      enforce = on;
    },
    failNext: (path, status, body) => {
      failures.set(path, { status, body });
    },
  };
}
