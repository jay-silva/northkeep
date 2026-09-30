#!/usr/bin/env node
// ADR 0063 acceptance: a local sync server (in-memory store) and a local
// Cloud Connect connector on the real Neon SQL over PGlite, both on
// 127.0.0.1, built from this repository. Nothing here reaches the network.
// Usage: node scripts/adr-0063-servers.mjs <dir>; writes <dir>/servers.json
// with both URLs and runs until killed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2];
if (!dir || !path.isAbsolute(dir) || !dir.startsWith('/tmp/')) {
  console.error('usage: node scripts/adr-0063-servers.mjs /tmp/<dir>');
  process.exit(2);
}

const fromConnector = createRequire(path.join(root, 'apps/connector-server/package.json'));
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { PGlite } = await import(pathToFileURL(fromConnector.resolve('@electric-sql/pglite')).href);
const { createConnectorServer } = await load('apps/connector-server/dist/create-server.js');
const { NeonConnectorStorage } = await load('apps/connector-server/dist/neon-storage.js');
const { createSyncServer } = await load('apps/sync-server/dist/server.js');
const { InMemoryStorage } = await load('apps/sync-server/dist/storage.js');

for (const k of [
  'DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'CONNECTOR_ENTITLEMENT_SECRET', 'NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES',
  'NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES', 'NORTHKEEP_ENTITLEMENT_SECRET', 'NORTHKEEP_CONNECTOR_MAINTENANCE',
]) delete process.env[k];
process.env.CONNECTOR_KEK_PEPPER = crypto.randomBytes(32).toString('base64');
process.env.CONNECTOR_TOMBSTONE_ENFORCE = '1';
process.env.NORTHKEEP_CONNECTOR_RATE_LIMIT = '0';
process.env.NORTHKEEP_SYNC_RATE_LIMIT = '0';

/**
 * The Neon HTTP driver's call shapes over one PGlite database, numbers as
 * strings the way Neon returns int8 (the adr0063 suites' pgliteAsNeon).
 * Transactions queue, because PGlite has one connection.
 */
function pgliteAsNeon(db) {
  const strings = (rows) =>
    rows.map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' || typeof v === 'bigint' ? String(v) : v])),
    );
  const exec = async (text, values) => strings((await db.query(text, values)).rows);
  const pending = (text, values) => {
    let started;
    const run = () => (started ??= exec(text, values));
    return { text, values, then: (ok, bad) => run().then(ok, bad) };
  };
  const sql = (parts, ...values) => {
    if (typeof parts === 'string') return pending(parts, []);
    let text = parts[0] ?? '';
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${parts[i + 1] ?? ''}`;
    return pending(text, values);
  };
  let chain = Promise.resolve();
  sql.transaction = (queries) => {
    const run = chain.then(async () => {
      await db.query('BEGIN');
      try {
        const out = [];
        for (const q of queries) out.push(await exec(q.text, q.values));
        await db.query('COMMIT');
        return out;
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      }
    });
    chain = run.catch(() => undefined);
    return run;
  };
  return sql;
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const pg = new PGlite();
const storage = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(pg));
await storage.ensureSchema();
const connectorPort = await freePort();
process.env.PUBLIC_URL = `http://127.0.0.1:${connectorPort}`;
const connector = createConnectorServer(storage);
await new Promise((resolve) => connector.listen(connectorPort, '127.0.0.1', resolve));

const sync = createSyncServer(new InMemoryStorage());
await new Promise((resolve) => sync.listen(0, '127.0.0.1', resolve));

// Acceptance step 5 needs a row as a pre-ADR connector left it. No connector
// route writes one any more, so this loopback-only side door nulls the base
// of one pending row in this throwaway database. It is not the connector.
const admin = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    try {
      if (req.method !== 'POST' || req.url !== '/legacy') throw new Error('not found');
      const { entry_id } = JSON.parse(body);
      const rows = await pg.query('UPDATE shared_entries SET base_revision = NULL WHERE entry_id = $1 AND pending RETURNING entry_id', [entry_id]);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ updated: rows.rows.length }));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err.message ?? err) }));
    }
  });
});
await new Promise((resolve) => admin.listen(0, '127.0.0.1', resolve));

const urls = {
  sync: `http://127.0.0.1:${sync.address().port}`,
  connector: `http://127.0.0.1:${connectorPort}`,
  admin: admin.address().port,
  pid: process.pid,
};
fs.writeFileSync(path.join(dir, 'servers.json'), JSON.stringify(urls));
console.log(`sync ${urls.sync} connector ${urls.connector} (PGlite, tombstone enforcement on)`);
