#!/usr/bin/env node
// ADR 0063 acceptance: a stand-in for a cloud AI app, talking to the LOCAL
// connector started by scripts/adr-0063-servers.mjs. It connects with a
// pairing code the way Claude or ChatGPT does (OAuth with PKCE), then calls
// the hosted project tools. It refuses any connector that is not on
// 127.0.0.1, and any state directory outside /tmp/nk-0063-acceptance.
//   node scripts/adr-0063-cloud.mjs <dir> connect <pairing code>
//   node scripts/adr-0063-cloud.mjs <dir> get <slug>
//   node scripts/adr-0063-cloud.mjs <dir> update <slug> <status> [expected_revision]
//   node scripts/adr-0063-cloud.mjs <dir> legacy <entry id>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [dir, cmd, ...args] = process.argv.slice(2);
if (!dir || !dir.startsWith('/tmp/nk-0063-acceptance')) {
  console.error('usage: node scripts/adr-0063-cloud.mjs /tmp/nk-0063-acceptance connect|get|update|legacy ...');
  process.exit(2);
}
const servers = JSON.parse(fs.readFileSync(path.join(dir, 'servers.json'), 'utf8'));
const base = servers.connector;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
  console.error(`Refusing a connector that is not on 127.0.0.1: ${base}`);
  process.exit(2);
}
const tokenFile = path.join(dir, 'cloud-app.json');
const REDIRECT_URI = 'http://127.0.0.1:9/callback';

async function readRpc(resp) {
  const text = await resp.text();
  if ((resp.headers.get('content-type') || '').includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return JSON.parse(text);
}

async function connect(pairingCode) {
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'adr-0063 acceptance app', redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp',
    }),
  }).then((r) => r.json());
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest().toString('base64url');
  const resource = `${base}/mcp`;
  const consent = await fetch(`${base}/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({ client_id: reg.client_id, redirect_uri: REDIRECT_URI, code_challenge: challenge,
      state: 's', scope: 'mcp', resource, pairing_code: pairingCode }).toString(),
  });
  const location = consent.headers.get('location');
  const code = location ? new URL(location).searchParams.get('code') : null;
  if (!code) throw new Error(`The connector refused the pairing code (HTTP ${consent.status}).`);
  const tok = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
      client_id: reg.client_id, code_verifier: verifier, resource }),
  }).then((r) => r.json());
  if (!tok.access_token) throw new Error('The connector issued no access token.');
  fs.writeFileSync(tokenFile, JSON.stringify({ access_token: tok.access_token }), { mode: 0o600 });
  console.log('Cloud app connected to the local connector.');
}

async function call(name, argsObj) {
  const { access_token } = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  const rpc = await readRpc(await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: argsObj } }),
  }));
  return {
    text: rpc?.result?.content?.[0]?.text ?? rpc?.error?.message ?? '',
    isError: rpc?.result?.isError === true,
    structured: rpc?.result?.structuredContent,
  };
}

function statusOf(doc) {
  const m = /## Current Status\n\n([^\n]*)/.exec(doc);
  return m ? m[1] : '(no status)';
}

if (cmd === 'connect') {
  await connect(args[0]);
} else if (cmd === 'get') {
  const got = await call('project_get', { project: args[0] });
  if (got.isError) {
    console.log(`Cloud app: project_get refused: ${got.text.split('\n')[0]}`);
  } else {
    console.log(`Cloud app sees revision ${got.structured.revision}, status: ${statusOf(got.text)}`);
  }
} else if (cmd === 'update') {
  const [slug, status, pinned] = args;
  const expected = pinned ?? (await call('project_get', { project: slug })).structured?.revision;
  const up = await call('project_update', { project: slug, expected_revision: expected, status, log_entry: 'Cloud app edit (ADR 0063 acceptance).' });
  if (up.isError) console.log(`Cloud app: project_update refused: ${up.text.split('\n')[0]}`);
  else console.log(`Cloud app wrote revision ${up.structured.revision} on top of ${expected}.`);
} else if (cmd === 'legacy') {
  // Makes one pending row look as a connector from before ADR 0063 left it: no recorded base.
  const res = await fetch(`http://127.0.0.1:${servers.admin}/legacy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entry_id: args[0] }),
  }).then((r) => r.json());
  console.log(`Rows given no base (pre-ADR 0063 shape): ${res.updated}`);
} else {
  console.error('commands: connect <code> | get <slug> | update <slug> <status> [expected_revision] | legacy <entry id>');
  process.exit(2);
}
