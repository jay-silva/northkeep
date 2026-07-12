import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * M7b acceptance — auto-routing + the privacy ceiling (ADR 0011 phase b).
 * Two FAKE local endpoints (A and B) whose replies name themselves, plus a
 * bounded endpoint that is never reachable — so every assertion about "where
 * did this turn actually go" is proven from the visible reply, and the
 * ceiling assertions are proven by the absence of any attempt to leave:
 *  - rules route by task (code → B, everything else → A), reason in audit;
 *  - a private-only conversation SKIPS a rule pointing at a bounded endpoint
 *    (and says so) instead of silently escalating;
 *  - the pin also binds MANUAL endpoint picks (400);
 *  - the REPL routes under :auto and refuses to leave while :private.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const serverPath = path.join(repoRoot, 'apps', 'web', 'dist', 'server.js');
const PASSPHRASE = 'm7b e2e passphrase';

let home: string;
let server: ChildProcess;
let baseUrl: string;
let token: string;
const fakes: http.Server[] = [];

const env = () => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NORTHKEEP_HOME: home,
  NORTHKEEP_PASSPHRASE: PASSPHRASE,
  NORTHKEEP_NO_KEYCHAIN: '1',
  NORTHKEEP_OLLAMA_URL: 'http://127.0.0.1:9', // dead → heuristic distillation
});

function cliAsync(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, ...args], { env: env(), encoding: 'utf8' }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr || stdout)) : resolve(stdout),
    );
  });
}

async function api(
  route: string,
  options: { method?: string; json?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? 'GET',
    headers: {
      'X-NorthKeep-Token': token,
      ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function converse(json: unknown): Promise<{ status: number; events: Array<Record<string, unknown>> }> {
  const res = await fetch(`${baseUrl}/api/converse`, {
    method: 'POST',
    headers: { 'X-NorthKeep-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify(json),
  });
  const text = await res.text();
  const events = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { status: res.status, events };
}

/** A fake endpoint whose reply names itself. */
function startFake(name: string): Promise<string> {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: `${name}-model` }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body) as { model?: string };
        res.setHeader('content-type', 'text/event-stream');
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: `answered by ${name} (${parsed.model})` } }] })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  fakes.push(srv);
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as { port: number }).port}`)),
  );
}

let epA: string; // default; catch-all target
let epB: string; // code target
let epCloud: string; // bounded, unreachable — must never be contacted

beforeAll(async () => {
  expect(fs.existsSync(serverPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-m7b-'));
  await cliAsync(['init']);

  const urlA = await startFake('A');
  const urlB = await startFake('B');

  server = spawn(process.execPath, [serverPath], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  const readyLine: string = await new Promise((resolve, reject) => {
    let out = '';
    server.stdout!.on('data', (c: Buffer) => {
      out += c.toString('utf8');
      const match = /NORTHKEEP_UI_URL=(\S+)/.exec(out);
      if (match) resolve(match[1]!);
    });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
    setTimeout(() => reject(new Error(`server not ready: ${out}`)), 15000);
  });
  const parsed = new URL(readyLine);
  baseUrl = parsed.origin;
  token = parsed.searchParams.get('token')!;

  const addEp = async (label: string, base_url: string, model: string): Promise<string> => {
    const r = await api('/api/providers', { method: 'POST', json: { label, base_url, model } });
    expect(r.status).toBe(200);
    return (r.body.endpoint as { id: string }).id;
  };
  epA = await addEp('Alpha Local', urlA, 'A-model');
  epB = await addEp('Beta Local', urlB, 'B-model');
  epCloud = await addEp('Cloudy', 'https://api.invalid.example', 'cloud-model');
  await api(`/api/providers/${encodeURIComponent(epA)}/default`, { method: 'POST' });
}, 30000);

afterAll(async () => {
  server?.kill();
  await Promise.all(fakes.map((f) => new Promise((r) => f.close(r))));
  fs.rmSync(home, { recursive: true, force: true });
});

describe('M7b acceptance — the concierge routes, the ceiling holds', () => {
  it('accepts routing rules over the API and lists them back', async () => {
    const put = await api('/api/routing', {
      method: 'PUT',
      json: { rules: [{ task: 'code', endpointId: epB }, { task: '*', endpointId: epA }] },
    });
    expect(put.status).toBe(200);
    const got = await api('/api/routing');
    expect((got.body.rules as unknown[]).length).toBe(2);
  });

  it('rejects rules the loader would silently drop: unknown endpoint, unknown task, non-string model', async () => {
    for (const rules of [
      [{ task: 'code', endpointId: 'nope' }],
      [{ task: 'typo-task', endpointId: epA }],
      [{ task: 'code', endpointId: epA, model: { malicious: true } }],
    ]) {
      const bad = await api('/api/routing', { method: 'PUT', json: { rules } });
      expect(bad.status, JSON.stringify(rules)).toBe(400);
    }
    // And the stored policy is untouched by the failed writes.
    const got = await api('/api/routing');
    expect((got.body.rules as unknown[]).length).toBe(2);
  });

  it('auto routes a code question to B and says why — visibly and in the audit', async () => {
    const { events } = await converse({
      endpoint_id: 'auto',
      message: 'Why does this throw?\n```js\nconst x = null; x.y\n```',
      tier: 1,
    });
    const done = events.find((e) => e.type === 'done')!;
    expect(done.reply).toContain('answered by B');
    expect(String(done.route_reason)).toContain('code');
    expect(String(done.route_reason)).toContain('Beta Local');

    const audit = JSON.parse(await cliAsync(['audit', '--format', 'json'])) as Array<Record<string, unknown>>;
    const row = audit.reverse().find((r) => r.tool === 'converse')!;
    expect(String(row.route_reason)).toContain('code');
  });

  it('auto routes everything else to A via the catch-all', async () => {
    const { events } = await converse({
      endpoint_id: 'auto',
      message: 'Good morning, tell me something nice about lighthouses',
      tier: 1,
    });
    const done = events.find((e) => e.type === 'done')!;
    expect(done.reply).toContain('answered by A');
  });

  it('a private-only conversation SKIPS a rule pointing at a bounded endpoint — and says so', async () => {
    // Point the code rule at the (unreachable) bounded endpoint.
    await api('/api/routing', {
      method: 'PUT',
      json: { rules: [{ task: 'code', endpointId: epCloud }, { task: '*', endpointId: epA }] },
    });
    const { events } = await converse({
      endpoint_id: 'auto',
      message: 'Fix this ```code``` please',
      tier: 1,
      ceiling: 'private-only',
    });
    const done = events.find((e) => e.type === 'done')!;
    // It stayed home (the reply proves it — an escaped turn could not answer,
    // and the reason names the skip).
    expect(done.reply).toContain('answered by A');
    expect(String(done.route_reason)).toContain('skipped Cloudy');
    expect(String(done.route_reason)).toContain('privacy ceiling');
  });

  it('the same rule DOES route to the bounded endpoint when the ceiling allows (and fails only at transport)', async () => {
    const { events } = await converse({
      endpoint_id: 'auto',
      message: 'Fix this ```code``` please',
      tier: 1,
    });
    // Unreachable host → the turn errors — which is itself proof the router
    // chose the bounded endpoint under bounded-allowed.
    expect(events.find((e) => e.type === 'error')).toBeDefined();
  });

  it('the pin binds MANUAL picks too: explicit bounded endpoint + private-only → 400', async () => {
    const { status, events } = await converse({
      endpoint_id: epCloud,
      message: 'hello',
      tier: 1,
      ceiling: 'private-only',
    });
    expect(status).toBe(400);
    expect(JSON.stringify(events)).toContain('pinned private');
  });

  it('the ceiling RATCHETS on the conversation: omitting the field keeps the pin; unpinning is explicit', async () => {
    // Pin a conversation.
    const first = await converse({
      endpoint_id: epA,
      message: 'start of a pinned chat',
      tier: 1,
      ceiling: 'private-only',
    });
    const sessionId = (first.events.find((e) => e.type === 'start') as { session_id?: string })
      .session_id!;
    // A later request that OMITS the ceiling must still be pinned.
    const sneaky = await converse({
      endpoint_id: epCloud,
      session_id: sessionId,
      message: 'try to leave quietly',
      tier: 1,
    });
    expect(sneaky.status).toBe(400);
    expect(JSON.stringify(sneaky.events)).toContain('pinned private');
    // Unpinning takes the explicit value — then the bounded pick is allowed
    // (and fails only at transport, proving it was permitted).
    const unpinned = await converse({
      endpoint_id: epCloud,
      session_id: sessionId,
      message: 'leave deliberately',
      tier: 1,
      ceiling: 'bounded-allowed',
    });
    expect(unpinned.status).toBe(200);
    expect(unpinned.events.find((e) => e.type === 'error')).toBeDefined(); // unreachable host
  });

  it('rejects an unrecognized ceiling value loudly (400), and model cannot ride auto', async () => {
    const badCeiling = await converse({ endpoint_id: epA, message: 'hi', tier: 1, ceiling: 'Private-Only' });
    expect(badCeiling.status).toBe(400);
    const override = await converse({ endpoint_id: 'auto', message: 'hi', tier: 1, model: 'x-model' });
    expect(override.status).toBe(400);
  });

  it('REPL: :auto routes by task; :private keeps the conversation home', async () => {
    // Restore rules: code → B, * → A.
    await api('/api/routing', {
      method: 'PUT',
      json: { rules: [{ task: 'code', endpointId: epB }, { task: '*', endpointId: epA }] },
    });
    const output = await replSession(
      [
        ':auto',
        'Why does this throw?\n', // (single line; classifier sees "debug"-free text → general → A)
        ':private',
        ':endpoint Cloudy',
      ],
      ['--endpoint', epA, '--tier', '1'],
    );
    expect(output).toContain('✦ Auto on');
    expect(output).toContain('answered by A');
    expect(output).toContain('[✦ auto:');
    expect(output).toContain('Pinned private');
    expect(output).toContain('Not switching');
  }, 120000);
});

/** Drive the REPL: send each line, then EOF; resolve with all output. */
function replSession(lines: string[], args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'converse', ...args], {
      env: env(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`REPL did not exit. Output:\n${out}`));
    }, 90000);
    child.stdout!.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr!.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin!.write(lines.join('\n') + '\n');
    child.stdin!.end();
  });
}
