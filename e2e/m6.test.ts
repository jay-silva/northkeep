import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * M6 acceptance — Converse, the mediated client — driven through the real
 * UI server binary against a FAKE OpenAI-compatible endpoint and a FAKE
 * Ollama (NER + distillation). Proves, end to end over the wire:
 *  - a seeded secret is masked in the captured outbound request body
 *  - the memory context was injected, names pseudonymized (Tier 2)
 *  - the pseudonym is restored in the reply the user sees
 *  - the exchange is distilled into the vault, visibly, and undo works
 *  - the audit row is content-free and carries endpoint/model/tier/privacy
 *  - endpoint management never returns key material
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const serverPath = path.join(repoRoot, 'apps', 'web', 'dist', 'server.js');
const PASSPHRASE = 'm6 e2e passphrase';
const FAKE_SSN = '219-09-9999'; // SSA's advertised never-issued example

let home: string;
let server: ChildProcess;
let baseUrl: string;
let token: string;
let fakeProvider: http.Server;
let fakeProviderUrl: string;
let fakeOllama: http.Server;
let fakeOllamaUrl: string;
/** Every body POSTed to the fake provider's chat endpoint. */
const outboundBodies: string[] = [];

function cliAsync(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          NORTHKEEP_HOME: home,
          NORTHKEEP_PASSPHRASE: PASSPHRASE,
          NORTHKEEP_NO_KEYCHAIN: '1',
        },
        encoding: 'utf8',
      },
      (error, stdout, stderr) => (error ? reject(new Error(stderr || stdout)) : resolve(stdout)),
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
      'X-Northkeep-Token': token,
      ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** POST /api/converse and parse the NDJSON stream into events. */
async function converse(json: unknown): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${baseUrl}/api/converse`, {
    method: 'POST',
    headers: { 'X-Northkeep-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify(json),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  expect(fs.existsSync(serverPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-m6-'));
  await cliAsync(['init']);
  await cliAsync(['remember', 'Jay takes his coffee black.', '--type', 'semantic']);

  // Fake OpenAI-compatible chat endpoint (SSE), capturing outbound bodies.
  fakeProvider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'fake-model' }, { id: 'other-model' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        outboundBodies.push(body);
        res.setHeader('content-type', 'text/event-stream');
        const reply = 'Person-1 is handling it. And you take your coffee black.';
        for (const piece of [reply.slice(0, 20), reply.slice(20)]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
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

  // Fake Ollama: serves BOTH Tier-2 NER and distillation, told apart by prompt.
  fakeOllama = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }));
        return;
      }
      const prompt = (JSON.parse(body) as { prompt?: string }).prompt ?? '';
      if (prompt.includes('durable personal memory')) {
        res.end(
          JSON.stringify({
            response: JSON.stringify({
              memories: [
                { type: 'semantic', content: 'The user is planning a sailing trip with their lawyer.', confidence: 0.8 },
              ],
            }),
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            response: JSON.stringify({ entities: [{ text: 'Bob Henderson', kind: 'person' }] }),
          }),
        );
      }
    });
  });
  await new Promise<void>((r) => fakeOllama.listen(0, '127.0.0.1', r));
  fakeOllamaUrl = `http://127.0.0.1:${(fakeOllama.address() as { port: number }).port}`;

  server = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NORTHKEEP_HOME: home,
      NORTHKEEP_PASSPHRASE: PASSPHRASE,
      NORTHKEEP_NO_KEYCHAIN: '1',
      NORTHKEEP_OLLAMA_URL: fakeOllamaUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  await new Promise((r) => fakeOllama.close(r));
  fs.rmSync(home, { recursive: true, force: true });
});

describe('M6 acceptance — Converse', () => {
  let endpointId: string;
  let createdIds: string[];

  it('adds an endpoint and discovers its models with a private badge', async () => {
    const models = await api(`/api/models?base=${encodeURIComponent(fakeProviderUrl)}`);
    expect(models.status).toBe(200);
    expect(models.body.models).toContain('fake-model');
    expect(models.body.tier).toBe('private');

    const added = await api('/api/providers', {
      method: 'POST',
      json: { label: 'Fake Local', base_url: fakeProviderUrl, model: 'fake-model' },
    });
    expect(added.status).toBe(200);
    const endpoint = added.body.endpoint as Record<string, unknown>;
    expect(endpoint.tier).toBe('private');
    endpointId = endpoint.id as string;
  });

  it('labels a public endpoint bounded, and never stores or returns a key without a Keychain', async () => {
    const bounded = await api('/api/providers', {
      method: 'POST',
      json: { label: 'Fake Cloud', base_url: 'https://api.example.com', model: 'x' },
    });
    expect((bounded.body.endpoint as Record<string, unknown>).tier).toBe('bounded');

    // No Keychain in this environment: storing a key must refuse loudly…
    const keyed = await api('/api/providers', {
      method: 'POST',
      json: {
        label: 'Keyed',
        base_url: 'https://api.example.com',
        model: 'x',
        api_key: 'sk-test-not-a-real-key',
      },
    });
    expect(keyed.status).toBe(500);
    // …and the key must not appear in the config file or any listing.
    const providersFile = fs.readFileSync(path.join(home, 'providers.json'), 'utf8');
    expect(providersFile).not.toContain('sk-test-not-a-real-key');
    const list = await api('/api/providers');
    expect(JSON.stringify(list.body)).not.toContain('sk-test-not-a-real-key');
  });

  it('runs a full mediated turn: mask → inject → call → restore → distill → audit', async () => {
    const events = await converse({
      endpoint_id: endpointId,
      message: `My SSN is ${FAKE_SSN}. Ask Bob Henderson to file it — and what coffee do I take?`,
      tier: 2,
    });

    const start = events.find((e) => e.type === 'start')!;
    expect(start.privacy).toBe('private');
    expect(start.endpoint_host).toBe('127.0.0.1');

    const done = events.find((e) => e.type === 'done')!;
    expect(done, `no done event: ${JSON.stringify(events)}`).toBeDefined();

    // (a) the secret never left; (b) the name went out as a pseudonym;
    // (c) vault memory was injected into the outbound context.
    const outbound = outboundBodies.join(' ');
    expect(outbound).not.toContain(FAKE_SSN);
    expect(outbound).toContain('[SSN_1]');
    expect(outbound).not.toContain('Bob Henderson');
    expect(outbound).toContain('Person-1');
    expect(outbound).toContain('coffee black');

    // (d) the reply the user sees has the real name restored.
    expect(done.reply).toContain('Bob Henderson');
    expect(done.reply).not.toContain('Person-1');
    expect(done.tier_applied).toBe(2);

    // (e) the exchange was distilled and stored.
    const created = done.memories_created as Array<{ id: string; content: string }>;
    expect(created.length).toBeGreaterThan(0);
    expect(created[0]!.content).toContain('sailing');
    createdIds = created.map((m) => m.id);
    const listed = await cliAsync(['list']);
    expect(listed).toContain('sailing trip');
    expect(listed).toContain('source converse');
  });

  it('wrote a content-free audit row carrying endpoint, model, tier, and privacy', async () => {
    const audit = JSON.parse(await cliAsync(['audit', '--format', 'json'])) as Array<
      Record<string, unknown>
    >;
    const row = audit.reverse().find((r) => r.tool === 'converse')!;
    expect(row, 'no converse audit row').toBeDefined();
    expect(row.endpoint_host).toBe('127.0.0.1');
    expect(row.model).toBe('fake-model');
    expect(row.privacy).toBe('private');
    expect(row.redaction_tier).toBe(2);
    expect(row.created_ids).toEqual(createdIds);
    const rowText = JSON.stringify(row);
    expect(rowText).not.toContain(FAKE_SSN);
    expect(rowText).not.toContain('coffee');
    expect(rowText).not.toContain('Bob Henderson');
    expect(rowText).not.toContain('sailing');
  });

  it('undo tombstones the distilled memories', async () => {
    const undone = await api('/api/converse/undo', { method: 'POST', json: { ids: createdIds } });
    expect(undone.status).toBe(200);
    expect((undone.body.forgotten as string[]).length).toBe(createdIds.length);
    const listed = await cliAsync(['list']);
    expect(listed).not.toContain('sailing trip');
  });

  it('CLI REPL runs a mediated turn: masked outbound, restored reply, provenance line', async () => {
    outboundBodies.length = 0;
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliPath, 'converse', '--endpoint', endpointId, '--tier', '2'],
        {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            NORTHKEEP_HOME: home,
            NORTHKEEP_PASSPHRASE: PASSPHRASE,
            NORTHKEEP_NO_KEYCHAIN: '1',
            NORTHKEEP_OLLAMA_URL: fakeOllamaUrl,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let out = '';
      child.stdout!.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr!.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.on('exit', () => resolve(out));
      child.on('error', reject);
      child.stdin!.write(`Tell Bob Henderson my SSN is ${FAKE_SSN}.\n`);
      child.stdin!.end(); // EOF after the turn → REPL exits cleanly
      setTimeout(() => {
        child.kill();
        reject(new Error(`REPL did not exit. Output so far:\n${out}`));
      }, 20000);
    });

    expect(output).toContain('● private');
    // Outbound went through the same pipeline: masked + pseudonymized.
    const outbound = outboundBodies.join(' ');
    expect(outbound).not.toContain(FAKE_SSN);
    expect(outbound).toContain('[SSN_1]');
    expect(outbound).not.toContain('Bob Henderson');
    // The restored reply and the provenance line reached the terminal.
    expect(output).toContain('Bob Henderson');
    expect(output).toContain('tier 2');
    expect(output).toContain('memory:');
  }, 30000);

  it('keeps the conversation session across turns (wire history in wire space)', async () => {
    const first = await converse({
      endpoint_id: endpointId,
      message: 'Remember to loop in Bob Henderson.',
      tier: 2,
    });
    const sessionId = (first.find((e) => e.type === 'start')! as { session_id?: string })
      .session_id!;
    outboundBodies.length = 0;
    const second = await converse({
      endpoint_id: endpointId,
      session_id: sessionId,
      message: 'Did I mention anyone?',
      tier: 2,
    });
    expect(second.find((e) => e.type === 'done')).toBeDefined();
    // Prior turns ride along in wire space: pseudonyms intact, no plaintext name.
    const outbound = outboundBodies.join(' ');
    expect(outbound).toContain('Person-1');
    expect(outbound).not.toContain('Bob Henderson');
  });
});
