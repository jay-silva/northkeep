import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createOpenAICompatibleProvider,
  createSession,
  createWebSearchTool,
  runTask,
  setToolBudget,
} from '../packages/converse/dist/index.js';
import type {
  ApprovalRequest,
  ConverseVault,
  TaskEvent,
  TaskHooks,
  ToolDefinition,
} from '../packages/converse/dist/index.js';

/**
 * M10d acceptance — web_search (Brave) + the tool-spend budget (ADR 0030),
 * driving the BUILT @northkeep/converse against a FAKE OpenAI SSE endpoint and
 * a FAKE Brave server, both on loopback. Proves end to end:
 *  - a web_search tool call runs after approval; the subscription token rides
 *    the X-Subscription-Token HEADER and appears NOWHERE in the URL, the audit,
 *    or the approval request;
 *  - the ranked results come back FENCED as external data and the model answers;
 *  - trusted-api screening: an SSN in the query is HARD-BLOCKED, but a protected
 *    name is NOT (identity screening is dropped for search — ADR 0030 §2);
 *  - the daily budget cap denies a costed search once spent, loud + audited.
 *
 * TEST-ONLY seams: the tool is built with testEndpoint (loopback origin +
 * rebinding the credential's authorized host to 127.0.0.1) and testOverrides
 * (loopback resolver + allowHttp), which the production SSRF guard would refuse.
 * No production wiring constructs these.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distPath = path.join(repoRoot, 'packages', 'converse', 'dist', 'index.js');

let home: string;
let priorHome: string | undefined;
let fakeProvider: http.Server;
let fakeProviderUrl: string;
let braveServer: http.Server;
let braveOrigin = '';
let bravePort = 0;
/** Every X-Subscription-Token header the fake Brave server received. */
let braveTokensSeen: Array<string | undefined> = [];
/** Every full request URL the fake Brave server received. */
let braveUrlsSeen: string[] = [];
/** Every Accept header the fake Brave server received. */
let braveAcceptsSeen: Array<string | undefined> = [];

const SSN = '123-45-6789';
const fakeVault: ConverseVault = { retrieve: () => [], list: () => [], commit: () => [] };

const EMAIL = 'jay.private@example.org';

/** What query the fake model puts in its web_search call, keyed off the message. */
function queryForMessage(msg: string): string {
  if (msg.includes('EXFIL-SSN')) return `medical records for ${SSN}`;
  if (msg.includes('NAME')) return 'reviews for Carol Mansfield realty';
  if (msg.includes('EMAIL')) return `who owns ${EMAIL}`;
  return 'best espresso machines 2026';
}

beforeAll(async () => {
  expect(fs.existsSync(distPath), 'run pnpm build first').toBe(true);

  braveServer = http.createServer((req, res) => {
    braveTokensSeen.push(
      typeof req.headers['x-subscription-token'] === 'string'
        ? (req.headers['x-subscription-token'] as string)
        : undefined,
    );
    braveUrlsSeen.push(req.url ?? '');
    braveAcceptsSeen.push(typeof req.headers.accept === 'string' ? req.headers.accept : undefined);
    // Mirror the REAL Brave API (verified live): a non-JSON Accept is rejected
    // with 422 "Unable to validate request parameter(s)". This is what caught
    // us — the old fixture answered JSON regardless of Accept, so a wrong
    // header passed every test while the real API 422'd. Now it can't.
    if (req.headers.accept !== 'application/json') {
      res.statusCode = 422;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'VALIDATION', detail: 'Unable to validate request parameter(s)', status: 422 } }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        web: {
          results: [
            { title: 'Top Espresso Machines', url: 'https://example.com/a', description: 'A roundup.' },
            { title: 'Buyer Guide', url: 'https://example.com/b', description: 'How to choose.' },
          ],
        },
      }),
    );
  });
  await new Promise<void>((r) => braveServer.listen(0, '127.0.0.1', r));
  bravePort = (braveServer.address() as { port: number }).port;
  braveOrigin = `http://127.0.0.1:${bravePort}`;

  fakeProvider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      res.setHeader('content-type', 'text/event-stream');
      const send = (p: unknown) => res.write(`data: ${JSON.stringify(p)}\n\n`);
      const toolMsg = parsed.messages.filter((m) => m.role === 'tool').at(-1);
      if (toolMsg !== undefined) {
        const ack = toolMsg.content.includes('blocked_exfiltration')
          ? 'The harness blocked that search.'
          : toolMsg.content.includes('budget_exceeded')
            ? 'Search budget is used up; answering from memory.'
            : 'Based on the results, the top pick is the Model X.';
        send({ choices: [{ delta: { content: ack } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      } else {
        const userMsg = parsed.messages.filter((m) => m.role === 'user').at(-1)!;
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_s1',
                    function: { name: 'web_search', arguments: JSON.stringify({ query: queryForMessage(userMsg.content) }) },
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
  await new Promise((r) => braveServer.close(r));
  await new Promise((r) => fakeProvider.close(r));
});

beforeEach(() => {
  // Fresh NORTHKEEP_HOME per test so the budget ledger never bleeds across.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-m10d-'));
  priorHome = process.env.NORTHKEEP_HOME;
  process.env.NORTHKEEP_HOME = home;
  braveTokensSeen = [];
  braveUrlsSeen = [];
  braveAcceptsSeen = [];
});

function restoreHome(): void {
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
}

const TOKEN = 'brave-test-token-SECRET';

function searchTool(): ToolDefinition {
  return createWebSearchTool({
    apiKey: TOKEN,
    testEndpoint: { origin: braveOrigin, authorizedHost: '127.0.0.1' },
    testOverrides: {
      allowHttp: true,
      resolver: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      isPrivateAddress: () => false,
    },
  });
}

/**
 * A web_search tool whose egress classifies as BOUNDED (not loopback-private),
 * by keeping the real Brave hostname in the origin and resolving it to the
 * loopback fixture via testOverrides. This is the only way to exercise the
 * production Tier-1 egress-mask layer (task.ts applies applyTier1 to tool
 * args only for a bounded destination — a loopback origin is private and
 * SKIPS the floor). G5 finding 2.
 */
function boundedSearchTool(port: number): ToolDefinition {
  return createWebSearchTool({
    apiKey: TOKEN,
    testEndpoint: { origin: `http://api.search.brave.com:${port}`, authorizedHost: 'api.search.brave.com' },
    testOverrides: {
      allowHttp: true,
      resolver: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      isPrivateAddress: () => false,
    },
  });
}

function logText(): string {
  return fs.readFileSync(path.join(home, 'mcp-calls.log'), 'utf8');
}

function run(message: string, hooks: TaskHooks) {
  return runTask({
    message,
    session: createSession(),
    provider: createOpenAICompatibleProvider({ baseUrl: fakeProviderUrl }),
    model: 'fake-model',
    vault: fakeVault,
    redactTier: 0, // loopback provider = private; model sees the plaintext query
    distill: false,
    tools: [searchTool()],
    hooks,
  });
}

describe('M10d acceptance — web_search + budget', () => {
  it('searches after approval; token rides the header, never the URL/audit', async () => {
    const approvals: ApprovalRequest[] = [];
    const result = await run('find me an espresso machine', {
      onEvent: () => {},
      requestApproval: (req) => {
        approvals.push(req);
        return Promise.resolve('allow');
      },
    });

    expect(result.reply).toBe('Based on the results, the top pick is the Model X.');
    expect(result.toolCallsMade[0]!.decision).toBe('approved');

    // The gate saw the QUERY (via argsPlain), and the token was NOT in it.
    expect(approvals[0]!.argsPlain).toContain('espresso');
    expect(approvals[0]!.argsPlain).not.toContain(TOKEN);

    // Brave received the token in the HEADER, and the query in the URL — but
    // never the token in the URL.
    expect(braveTokensSeen).toEqual([TOKEN]);
    expect(braveUrlsSeen[0]).toContain('espresso');
    expect(braveUrlsSeen[0]).not.toContain(TOKEN);
    // And we sent Accept: application/json — the real Brave API 422s anything
    // else (the fixture now enforces that, so a regression here fails loudly).
    expect(braveAcceptsSeen).toEqual(['application/json']);

    // The results came back FENCED as external data (the model's round-2 saw them).
    // Audit + reply carry no token anywhere.
    expect(logText()).not.toContain(TOKEN);
    expect(result.reply).not.toContain(TOKEN);
    restoreHome();
  });

  it('hard-blocks a query carrying an SSN (secret screen survives trusted-api)', async () => {
    const approvals: ApprovalRequest[] = [];
    const events: TaskEvent[] = [];
    const result = await run('EXFIL-SSN look this up', {
      onEvent: (e) => events.push(e),
      requestApproval: (req) => {
        approvals.push(req);
        return Promise.resolve('allow');
      },
    });
    expect(approvals).toHaveLength(0); // hard-denied before any prompt
    expect(braveTokensSeen).toEqual([]); // Brave never contacted
    expect(result.toolCallsMade[0]!.decision).toBe('denied');
    const perm = events.find(
      (e): e is Extract<TaskEvent, { type: 'permission' }> => e.type === 'permission',
    )!;
    expect(perm.via).toBe('screen');
    expect(logText()).not.toContain(SSN);
    restoreHome();
  });

  it('does NOT block a query with a protected name (identity dropped for search)', async () => {
    const approvals: ApprovalRequest[] = [];
    // A session actively protecting the name "Carol Mansfield".
    const session = createSession();
    session.pseudonyms['carol mansfield'] = 'Person-1';
    const result = await runTask({
      message: 'NAME search that agent',
      session,
      provider: createOpenAICompatibleProvider({ baseUrl: fakeProviderUrl }),
      model: 'fake-model',
      vault: fakeVault,
      redactTier: 0,
      distill: false,
      tools: [searchTool()],
      hooks: {
        onEvent: () => {},
        requestApproval: (req) => {
          approvals.push(req);
          return Promise.resolve('allow');
        },
      },
    });
    // The search ran: one prompt with NO warnings, Brave contacted.
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.warnings).toEqual([]);
    expect(braveTokensSeen).toEqual([TOKEN]);
    expect(result.toolCallsMade[0]!.decision).toBe('approved');
    restoreHome();
  });

  it('masks literal PII in the query toward a BOUNDED Brave egress (prod Tier-1 floor)', async () => {
    // web_search drops the warn-class email FLAG (trusted-api), but the Tier-1
    // egress floor still masks the literal email before it reaches Brave —
    // because the egress classifies bounded (real hostname, not loopback).
    const result = await runTask({
      message: 'EMAIL find the owner',
      session: createSession(),
      provider: createOpenAICompatibleProvider({ baseUrl: fakeProviderUrl }),
      model: 'fake-model',
      vault: fakeVault,
      redactTier: 1, // bounded egress: the floor needs a nonzero tier context
      distill: false,
      tools: [boundedSearchTool(bravePort)],
      hooks: { onEvent: () => {}, requestApproval: () => Promise.resolve('allow') },
    });
    expect(result.toolCallsMade[0]!.decision).toBe('approved');
    // Brave received the MASKED query — the real email never left the machine.
    expect(braveUrlsSeen).toHaveLength(1);
    const received = decodeURIComponent(braveUrlsSeen[0]!);
    expect(received).not.toContain(EMAIL);
    expect(received).toMatch(/\[EMAIL/);
    restoreHome();
  });

  it('denies a search once the daily budget cap is spent', async () => {
    setToolBudget('web_search', { dailyCap: 1, perConversationCap: 5 });
    // First conversation: the one allowed search runs.
    await run('search one', { onEvent: () => {}, requestApproval: () => Promise.resolve('allow') });
    expect(braveTokensSeen).toEqual([TOKEN]);

    // Second conversation, same day: the cap is spent → denied before the gate.
    const approvals: ApprovalRequest[] = [];
    const events: TaskEvent[] = [];
    const result = await run('search two', {
      onEvent: (e) => events.push(e),
      requestApproval: (req) => {
        approvals.push(req);
        return Promise.resolve('allow');
      },
    });
    expect(approvals).toHaveLength(0); // never prompted
    expect(braveTokensSeen).toEqual([TOKEN]); // still just the one call — no second Brave hit
    expect(result.toolCallsMade[0]!.decision).toBe('denied');
    const perm = events.find(
      (e): e is Extract<TaskEvent, { type: 'permission' }> => e.type === 'permission',
    )!;
    expect(perm.via).toBe('budget');
    restoreHome();
  });
});
