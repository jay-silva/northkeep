#!/usr/bin/env node
/**
 * ADR 0063 concurrency proof on a real Postgres (RULES Engineering #3). PGlite
 * runs one connection, so it proves the SQL's logic but not its locking. This
 * script creates a throwaway cluster in the directory you name, listening on
 * 127.0.0.1 only, captures the exact statements NeonConnectorStorage sends
 * (a recording driver, no network), and races two psql sessions:
 *   1. two cloud updates at the same counter value: exactly one lands and the
 *      held stale row survives;
 *   2. two pushes with vault versions 5 and 6, in both orders: the older one
 *      writes nothing;
 *   3. two first reads of a scope's counter at once: the one whose insert
 *      loses still gets the counter (its follow-up read sees the commit).
 * Needs initdb, pg_ctl and psql on PATH and a built dist (pnpm -r build).
 * Usage: node apps/connector-server/scripts/adr0063-real-pg.mjs <empty-dir>
 * It never reads DATABASE_URL and never connects anywhere but its own cluster.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { NeonConnectorStorage, SCHEMA_STATEMENTS } = await import(path.join(here, '..', 'dist', 'neon-storage.js'));

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir) || fs.readdirSync(dir).length > 0) {
  console.error('Give an existing empty directory for the throwaway cluster.');
  process.exit(2);
}

// ---- a recording driver: captures {text, values}, runs nothing ----------
function recorder() {
  const log = [];
  const q = (strings, ...values) => {
    if (typeof strings === 'string') return { text: strings, values: [], then: (ok) => Promise.resolve(ok([])) };
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
    const item = { text, values };
    return { ...item, then: (ok) => { log.push([item]); return Promise.resolve(ok([])); } };
  };
  q.transaction = async (items) => {
    log.push(items.map(({ text, values }) => ({ text, values })));
    return items.map(() => [{ accepted: 1 }]);
  };
  return { sql: q, log };
}

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.length === 0 ? `'{}'` : `ARRAY[${v.map(literal).join(', ')}]`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function inline({ text, values }) {
  let out = text;
  for (let i = values.length; i >= 1; i--) out = out.split(`$${i}`).join(literal(values[i - 1]));
  return out;
}

async function capture(fn) {
  const r = recorder();
  await fn(new NeonConnectorStorage('postgres://unused', r.sql));
  return r.log.at(-1).map(inline);
}

/** Every statement a call sends, in order, including one after an error. */
async function captureAll(fn) {
  const r = recorder();
  try {
    await fn(new NeonConnectorStorage('postgres://unused', r.sql));
  } catch {
    // The recorder answers every read with no rows; only the statements matter.
  }
  return r.log.flat().map(inline);
}

// ---- the throwaway cluster ---------------------------------------------
const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const data = path.join(dir, 'data');
// macOS postmaster refuses to start without a valid locale in the environment.
const pgEnv = { ...process.env, LC_ALL: 'C' };
execFileSync('initdb', ['-D', data, '-A', 'trust', '-U', 'nk', '--no-sync'], { stdio: 'ignore', env: pgEnv });
execFileSync('pg_ctl', ['-D', data, '-l', path.join(dir, 'pg.log'), '-w', 'start', '-o',
  `-c listen_addresses=127.0.0.1 -c unix_socket_directories='' -p ${port}`], { stdio: 'ignore', env: pgEnv });
const psqlArgs = ['-X', '-q', '-At', '-h', '127.0.0.1', '-p', String(port), '-U', 'nk', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
const psql = (sqlText) => execFileSync('psql', psqlArgs, { input: sqlText, encoding: 'utf8' });
function session(sqlText) {
  return new Promise((resolve, reject) => {
    const p = spawn('psql', psqlArgs);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => (code === 0 ? resolve({ out, ms: Date.now() - started }) : reject(new Error(out))));
    const started = Date.now();
    p.stdin.end(sqlText);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
}

try {
  psql(SCHEMA_STATEMENTS.map((s) => `${s};`).join('\n'));
  const A = 'acct';
  const S = 'project:x';

  // ---- 1. the D2 compare-and-swap ---------------------------------------
  psql(`
    INSERT INTO connector_accounts (account_hash) VALUES ('${A}');
    INSERT INTO scope_seq VALUES ('${A}', '${S}', 2);
    INSERT INTO shared_entries (account_hash, entry_id, scope, type, content, origin, pending, base_revision, write_seq) VALUES
      ('${A}', 'P1', '${S}', '', 'p', 'vault', false, NULL, 1),
      ('${A}', 'conn_cur', '${S}', '', 'c', 'connector', true, 'P1', 2),
      ('${A}', 'conn_stale_held', '${S}', '', 's', 'connector', true, 'P0', 1);`);
  const cas = (id) => capture((st) => st.writeConnectorRows(A, S, {
    expectedSeq: 2, rows: [{ entryId: id, content: 'nkc1:x', baseRevision: 'P1' }], replacedId: 'conn_cur',
  }));
  const [t1] = await cas('conn_t1');
  const [t2] = await cas('conn_t2');
  const s1 = session(`BEGIN;\n${t1};\nSELECT pg_sleep(2);\nCOMMIT;\n`);
  await sleep(500);
  const r2 = await session(`${t2};\n`);
  const r1 = await s1;
  const pendingRows = psql(`SELECT string_agg(entry_id, ',' ORDER BY entry_id) FROM shared_entries WHERE pending;`).trim();
  const seq = psql(`SELECT seq FROM scope_seq WHERE scope = '${S}';`).trim();
  check('CAS: the first session lands at seq 3', r1.out.trim() === '3', JSON.stringify(r1.out.trim()));
  check('CAS: the second session blocks, then lands nothing', r2.out.trim() === '' && r2.ms >= 1000, `${JSON.stringify(r2.out.trim())} after ${r2.ms}ms`);
  check('CAS: pending rows are the held stale row and the winner', pendingRows === 'conn_stale_held,conn_t1', pendingRows);
  check('CAS: the counter moved once', seq === '3', seq);

  // ---- 2. the D5 vault-order guard, both orders --------------------------
  const entry = (id) => ({ entryId: id, scope: 'project:g', type: '', content: `nkc1:${id}`, entryHash: '', createdAt: new Date().toISOString() });
  // Both push paths: the route tries the accepting path first and falls back
  // to the plain replace when enforcement is off.
  const claimFor = (version) => ({ server: 's'.repeat(16), version, reset: false });
  const paths = {
    replaceScopes: (id, version) => capture((st) => st.replaceScopes('g', ['project:g'], [entry(id)], claimFor(version))),
    replaceScopesAcceptingReshare: (id, version) =>
      capture((st) => st.replaceScopesAcceptingReshare('g', ['project:g'], [entry(id)], {}, claimFor(version))),
  };
  for (const [pathName, pushSql] of Object.entries(paths))
  for (const [first, second] of [[5, 6], [6, 5]]) {
    psql(`DELETE FROM shared_entries WHERE account_hash = 'g'; DELETE FROM scope_seq WHERE account_hash = 'g';
      DELETE FROM connector_accounts WHERE account_hash = 'g';
      INSERT INTO connector_accounts (account_hash, vault_server, vault_version) VALUES ('g', '${'s'.repeat(16)}', 4);`);
    const [g1, ...rest1] = await pushSql(`H${first}`, first);
    const all2 = await pushSql(`H${second}`, second);
    const a = session(`BEGIN;\n${g1};\nSELECT pg_sleep(2);\n${rest1.join(';\n')};\nCOMMIT;\n`);
    await sleep(500);
    const b = await session(`BEGIN;\n${all2.join(';\n')};\nCOMMIT;\n`);
    await a;
    const pair = psql(`SELECT vault_version FROM connector_accounts WHERE account_hash = 'g';`).trim();
    const rowsNow = psql(`SELECT string_agg(entry_id, ',') FROM shared_entries WHERE account_hash = 'g';`).trim();
    const gseq = psql(`SELECT seq FROM scope_seq WHERE account_hash = 'g';`).trim();
    const expectSeq = first === 5 ? '2' : '1';
    check(`${pathName} v${first} then v${second}: the pair ends at 6`, pair === '6', pair);
    check(`${pathName} v${first} then v${second}: only H6 is stored`, rowsNow === 'H6', rowsNow);
    check(`${pathName} v${first} then v${second}: the second push blocked on the account row`, b.ms >= 1000, `${b.ms}ms`);
    check(`${pathName} v${first} then v${second}: the counter moved only for accepted pushes`, gseq === expectSeq, gseq);
  }

  // ---- 3. readScopeSeq when two requests create a counter at once ---------
  const [readFirst, readAgain] = await captureAll((st) => st.readScopeSeq('r', 'project:new'));
  check('readScopeSeq sends a follow-up read when the insert returns no row', typeof readAgain === 'string' && /^\s*SELECT seq FROM scope_seq/.test(readAgain));
  const winner = session(`BEGIN;\n${readFirst};\nSELECT pg_sleep(2);\nCOMMIT;\n`);
  await sleep(500);
  const loser = await session(`${readFirst};\n\\echo after-insert\n${readAgain};\n`);
  const won = await winner;
  check('readScopeSeq: the first session creates the counter at 0', won.out.trim() === '0', JSON.stringify(won.out.trim()));
  check('readScopeSeq: the losing insert returns no row, then the follow-up read returns 0',
    loser.out.trim() === 'after-insert\n0' && loser.ms >= 1000, `${JSON.stringify(loser.out.trim())} after ${loser.ms}ms`);
} finally {
  execFileSync('pg_ctl', ['-D', data, '-m', 'fast', 'stop'], { stdio: 'ignore', env: pgEnv });
}
console.log(failed === 0 ? 'all real-Postgres checks passed' : `${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
