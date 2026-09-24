/**
 * Shared infrastructure for the ADR 0061 suites: a PGlite-backed Neon driver
 * stand-in (optionally returning every number as a string, the way Neon's HTTP
 * driver returns int8), an ephemeral HTTP listener, entitlement signing, and
 * the OAuth steps a real AI app performs. No real database, no network beyond
 * 127.0.0.1.
 */

import crypto from 'node:crypto';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { PGlite } from '@electric-sql/pglite';
import type { createConnectorServer } from '../src/create-server.js';

type PendingQuery = Promise<unknown[]> & { text: string; values: unknown[] };

function stringifyNumbers(rows: unknown[]): unknown[] {
  return rows.map((r) => {
    if (!r || typeof r !== 'object') return r;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) out[k] = typeof v === 'number' ? String(v) : v;
    return out;
  });
}

export function pgliteAsNeon(db: PGlite, opts: { numbersAsStrings?: boolean } = {}): NeonQueryFunction<false, false> {
  const exec = async (text: string, values: unknown[]): Promise<unknown[]> => {
    const rows = (await db.query(text, values)).rows as unknown[];
    return opts.numbersAsStrings ? stringifyNumbers(rows) : rows;
  };
  const pending = (text: string, values: unknown[]): PendingQuery => {
    let started: Promise<unknown[]> | undefined;
    const run = (): Promise<unknown[]> => (started ??= exec(text, values));
    return {
      text,
      values,
      then: (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        run().then(onFulfilled, onRejected),
    } as PendingQuery;
  };
  const sql = ((strings: TemplateStringsArray | string, ...values: unknown[]) => {
    if (typeof strings === 'string') return pending(strings, []);
    let text = strings[0] ?? '';
    const params: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      params.push(values[i]);
      text += `$${params.length}${strings[i + 1] ?? ''}`;
    }
    return pending(text, params);
  }) as NeonQueryFunction<false, false>;
  (sql as unknown as { transaction: (q: PendingQuery[]) => Promise<unknown[][]> }).transaction = async (queries) => {
    await db.query('BEGIN');
    try {
      const results: unknown[][] = [];
      for (const q of queries) results.push(await exec(q.text, q.values));
      await db.query('COMMIT');
      return results;
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  };
  return sql;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** Build the app on a fixed free port with PUBLIC_URL pointing at it, then listen. */
export async function startServer(
  build: () => ReturnType<typeof createConnectorServer>,
): Promise<{ server: Server; base: string; close: () => Promise<void> }> {
  const port = await freePort();
  const prior = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
  const app = build();
  if (prior === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = prior;
  const server = await new Promise<Server>((resolve) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
  });
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Run `fn` with env vars set (undefined deletes), restoring them afterwards. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prior[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export function signTestEntitlement(secret: string, opts: { active: boolean; expSec: number }): string {
  const body = JSON.stringify({ active: opts.active, period_end: opts.expSec, exp: opts.expSec, nonce: 'n' });
  const sig = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `${Buffer.from(body, 'utf8').toString('base64url')}.${sig}`;
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);
export const TEST_PEPPER_B64 = Buffer.alloc(32, 7).toString('base64');
export const REDIRECT_URI = 'http://localhost:9999/callback';

export function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest().toString('base64url');
  return { verifier, challenge };
}

export async function registerClient(
  base: string,
  opts: { confidential: boolean; clientName?: string },
): Promise<{ client_id: string; client_secret?: string; client_secret_expires_at?: number }> {
  const body: Record<string, unknown> = {
    client_name: opts.clientName ?? 'adr0061-client',
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'mcp',
  };
  if (!opts.confidential) body.token_endpoint_auth_method = 'none';
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`register ${res.status}`);
  return (await res.json()) as { client_id: string; client_secret?: string };
}

export function form(fields: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) p.append(k, v);
  return p.toString();
}

export async function postForm(
  base: string,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}
