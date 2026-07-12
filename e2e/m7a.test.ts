import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * M7a acceptance — quick-switch (ADR 0011 phase a) — against a fake
 * OpenAI-compatible endpoint whose REPLY NAMES THE MODEL that answered, so a
 * switch is proven end-to-end from what the user sees, not just wire capture:
 *  - the web /api/converse accepts a per-turn model override; the override is
 *    per-turn (the next turn reverts to the endpoint's configured model);
 *  - a malformed model id is rejected (400);
 *  - the CLI REPL switches models mid-conversation (:model / :models);
 *  - the tier-0 guard holds on :endpoint — a redaction-off conversation can
 *    NEVER be switched to a non-private endpoint.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const serverPath = path.join(repoRoot, 'apps', 'web', 'dist', 'server.js');
const PASSPHRASE = 'm7a e2e passphrase';

let home: string;
let server: ChildProcess;
let baseUrl: string;
let token: string;
let fakeProvider: http.Server;
let fakeProviderUrl: string;
/** Parsed JSON of every body POSTed to the fake chat endpoint. */
const outbound: Array<{ model?: string }> = [];

const env = () => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NORTHKEEP_HOME: home,
  NORTHKEEP_PASSPHRASE: PASSPHRASE,
  NORTHKEEP_NO_KEYCHAIN: '1',
  // Point Ollama at a dead port: distillation degrades to heuristics, keeping
  // this test hermetic even on a machine with a real Ollama running.
  NORTHKEEP_OLLAMA_URL: 'http://127.0.0.1:9',
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

beforeAll(async () => {
  expect(fs.existsSync(serverPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-m7a-'));
  await cliAsync(['init']);

  // Fake endpoint: two models; the SSE reply names the model that answered.
  fakeProvider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'alpha-model' }, { id: 'beta-model' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body) as { model?: string };
        outbound.push(parsed);
        res.setHeader('content-type', 'text/event-stream');
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: `answered by ${parsed.model}` } }] })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => fakeProvider.listen(0, '127.0.0.1', r));
  fakeProviderUrl = `http://127.0.0.1:${(fakeProvider.address() as { port: number }).port}`;

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
}, 30000);

afterAll(async () => {
  server?.kill();
  await new Promise((r) => fakeProvider.close(r));
  fs.rmSync(home, { recursive: true, force: true });
});

describe('M7a acceptance — quick-switch', () => {
  let endpointId: string;

  it('adds the endpoint (configured model: alpha-model)', async () => {
    const added = await api('/api/providers', {
      method: 'POST',
      json: { label: 'Fake Local', base_url: fakeProviderUrl, model: 'alpha-model' },
    });
    expect(added.status).toBe(200);
    endpointId = (added.body.endpoint as { id: string }).id;
  });

  it('a per-turn model override reaches the endpoint AND the visible provenance', async () => {
    const { status, events } = await converse({
      endpoint_id: endpointId,
      message: 'Hello there.',
      tier: 1,
      model: 'beta-model',
    });
    expect(status).toBe(200);
    const start = events.find((e) => e.type === 'start')!;
    const done = events.find((e) => e.type === 'done')!;
    expect(start.model).toBe('beta-model');
    expect(done.model).toBe('beta-model'); // the provenance strip's source
    expect(done.reply).toContain('answered by beta-model'); // proven end-to-end
    expect(outbound.at(-1)?.model).toBe('beta-model');
  });

  it('the override is per-turn: the same session reverts to the configured model', async () => {
    const first = await converse({
      endpoint_id: endpointId,
      message: 'Switch me.',
      tier: 1,
      model: 'beta-model',
    });
    const sessionId = (first.events.find((e) => e.type === 'start') as { session_id?: string })
      .session_id!;
    const second = await converse({
      endpoint_id: endpointId,
      session_id: sessionId,
      message: 'And back.',
      tier: 1,
    });
    const done = second.events.find((e) => e.type === 'done')!;
    expect(done.model).toBe('alpha-model');
    expect(outbound.at(-1)?.model).toBe('alpha-model');
  });

  it('rejects malformed and traversal-shaped model ids with 400 (nothing sent)', async () => {
    const before = outbound.length;
    for (const model of ['bad model !!', '../../etc/passwd', 'a/../b']) {
      const { status } = await converse({ endpoint_id: endpointId, message: 'Hi.', tier: 1, model });
      expect(status, model).toBe(400);
    }
    expect(outbound.length).toBe(before);
  });

  it('the audit row records the model that actually answered', async () => {
    const audit = JSON.parse(await cliAsync(['audit', '--format', 'json'])) as Array<
      Record<string, unknown>
    >;
    const models = audit.filter((r) => r.tool === 'converse').map((r) => r.model);
    expect(models).toContain('beta-model');
    expect(models).toContain('alpha-model');
  });

  it('CLI REPL: :models lists, :model switches mid-conversation', async () => {
    const output = await replSession(
      [':models', ':model beta-model', 'Hello from the REPL.'],
      ['--endpoint', endpointId, '--tier', '1'],
    );
    expect(output).toContain('alpha-model'); // :models listed both
    expect(output).toContain('beta-model');
    expect(output).toContain('Next turns use beta-model');
    expect(output).toContain('answered by beta-model'); // the switched model replied
    expect(outbound.at(-1)?.model).toBe('beta-model');
  }, 120000);

  it('REPL tier-0 guard: cannot :endpoint onto a non-private endpoint with redaction off', async () => {
    // A bounded endpoint exists (never actually called).
    await api('/api/providers', {
      method: 'POST',
      json: { label: 'Fake Cloud', base_url: 'https://api.example.com', model: 'x' },
    });
    const before = outbound.length;
    const output = await replSession([':endpoint Fake Cloud'], ['--endpoint', endpointId, '--tier', '0']);
    expect(output).toContain('Not switching');
    expect(output).toContain('not private');
    expect(outbound.length).toBe(before); // nothing was sent anywhere
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
    // Generous: every CLI spawn pays a full production Argon2id derivation
    // (see vitest.config.ts), so a slow CI box needs headroom.
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
