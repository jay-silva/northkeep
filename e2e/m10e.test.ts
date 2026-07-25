import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handleApprove, handleConverseStream } from '../apps/web/dist/converse.js';
import { UiSession } from '../apps/web/dist/session.js';
import { addEndpoint, createWebSearchTool } from '../packages/converse/dist/index.js';
import type { ToolDefinition } from '../packages/converse/dist/index.js';

/**
 * M10e acceptance — the web GUI agent-loop approval protocol (ADR 0031).
 * Drives the REAL converse handler with a MockRes (capturing the NDJSON
 * stream), a fake OpenAI endpoint that emits a web_search tool call, and a
 * fake Brave (via the tool's loopback test seam — the registry's real tool
 * is SSRF-guarded and cannot reach a fixture). Proves end to end:
 *  - a tool call SUSPENDS the stream on approval_request; POST /approve
 *    resumes it and the loop finishes with tool_egress in `done`;
 *  - a second approve for the same id 404s (single-settle);
 *  - an approve whose session_id doesn't match 404s (cross-conversation);
 *  - a bad/absent approval_id 404s; a bad decision 400s;
 *  - a denied approval feeds permission_denied and the loop concludes.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const PASSPHRASE = 'm10e e2e passphrase';

let home: string;
let vaultPath: string;
let braveServer: http.Server;
let braveOrigin = '';
let fakeModel: http.Server;
let fakeModelUrl = '';
let endpointId = '';

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

/** A minimal ServerResponse stand-in that captures NDJSON lines. */
class MockRes extends EventEmitter {
  statusCode = 200;
  writableEnded = false;
  readonly lines: Array<Record<string, unknown>> = [];
  private buf = '';
  writeHead(): this {
    return this;
  }
  setHeader(): this {
    return this;
  }
  write(chunk: string): boolean {
    if (this.writableEnded) return false;
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    return true;
  }
  end(): void {
    this.writableEnded = true;
    this.emit('finish');
  }
  /** Resolve once an event of `type` has been captured. */
  async waitFor(type: string, timeoutMs = 4000): Promise<Record<string, unknown>> {
    const start = Date.now();
    for (;;) {
      const found = this.lines.find((l) => l.type === type);
      if (found) return found;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for '${type}'`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

function session(): UiSession {
  return new UiSession(vaultPath); // isUnlocked() resolves the ambient passphrase env
}

function searchTool(): ToolDefinition {
  return createWebSearchTool({
    apiKey: 'brave-test-token',
    testEndpoint: { origin: braveOrigin, authorizedHost: '127.0.0.1' },
    testOverrides: {
      allowHttp: true,
      resolver: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      isPrivateAddress: () => false,
    },
  });
}

function converseBody(over: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({ endpoint_id: endpointId, message: 'find an espresso machine', tier: 1, tools: true, ...over }),
  );
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-m10e-'));
  vaultPath = path.join(home, 'vault.nkv');
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_PASSPHRASE = PASSPHRASE; // ambient unlock for the UiSession
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  await cliAsync(['--vault', vaultPath, 'init']);

  braveServer = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        web: { results: [{ title: 'Best Espresso Machines', url: 'https://example.com/a', description: 'A roundup.' }] },
      }),
    );
  });
  await new Promise<void>((r) => braveServer.listen(0, '127.0.0.1', r));
  braveOrigin = `http://127.0.0.1:${(braveServer.address() as { port: number }).port}`;

  fakeModel = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (req.url?.includes('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
        return;
      }
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      res.setHeader('content-type', 'text/event-stream');
      const send = (p: unknown) => res.write(`data: ${JSON.stringify(p)}\n\n`);
      const hasTool = parsed.messages.some((m) => m.role === 'tool');
      if (hasTool) {
        send({ choices: [{ delta: { content: 'The top pick is the Model X.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      } else {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c1', function: { name: 'web_search', arguments: '{"query":"espresso machines"}' } },
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
  await new Promise<void>((r) => fakeModel.listen(0, '127.0.0.1', r));
  fakeModelUrl = `http://127.0.0.1:${(fakeModel.address() as { port: number }).port}`;
  const ep = addEndpoint({ label: 'Fake', baseUrl: fakeModelUrl, model: 'fake-model', kind: 'openai-compatible' });
  endpointId = ep.id;
});

afterEach(() => {
  // Clear grants/budget between tests so they don't bleed.
  try {
    fs.rmSync(path.join(home, 'permissions.json'), { force: true });
    fs.rmSync(path.join(home, 'budget.json'), { force: true });
  } catch {
    /* ignore */
  }
});

afterAll(async () => {
  delete process.env.NORTHKEEP_PASSPHRASE;
  await new Promise((r) => braveServer.close(r));
  await new Promise((r) => fakeModel.close(r));
  fs.rmSync(home, { recursive: true, force: true });
});

describe('M10e — web approval protocol', () => {
  it('suspends on approval_request, resumes on POST /approve, finishes with tool_egress', async () => {
    const res = new MockRes();
    const done = handleConverseStream(session(), converseBody(), res as never, { toolsOverride: [searchTool()] });

    const ask = await res.waitFor('approval_request');
    expect(ask.tool).toBe('web_search');
    expect(ask.query).toBe('espresso machines'); // the query, not the Brave URL
    expect(ask.offer_scopes).toBe(true);
    expect(String(JSON.stringify(ask))).not.toContain('brave-test-token');
    const sid = ask.session_id ?? (await res.waitFor('start')).session_id;

    const approve = handleApprove(
      Buffer.from(JSON.stringify({ session_id: sid, approval_id: ask.approval_id, decision: 'allow' })),
    );
    expect(approve.status).toBe(200);

    await done;
    const doneEv = res.lines.find((l) => l.type === 'done')!;
    expect(doneEv.reply).toBe('The top pick is the Model X.');
    // The "what left this device" proof carries the egress, never the token.
    const egress = doneEv.tool_egress as Array<{ name: string; host: string; url: string }>;
    expect(egress).toHaveLength(1);
    expect(egress[0]!.name).toBe('web_search');
    expect(JSON.stringify(egress)).not.toContain('brave-test-token');
  });

  it('a second approve for the same id 404s (single-settle)', async () => {
    const res = new MockRes();
    const done = handleConverseStream(session(), converseBody(), res as never, { toolsOverride: [searchTool()] });
    const ask = await res.waitFor('approval_request');
    const start = await res.waitFor('start');
    const payload = Buffer.from(
      JSON.stringify({ session_id: start.session_id, approval_id: ask.approval_id, decision: 'allow' }),
    );
    expect(handleApprove(payload).status).toBe(200);
    expect(handleApprove(payload).status).toBe(404); // already settled
    await done;
  });

  it('rejects an approve with a mismatched session_id (404) and a bad decision (400)', async () => {
    const res = new MockRes();
    const done = handleConverseStream(session(), converseBody(), res as never, { toolsOverride: [searchTool()] });
    const ask = await res.waitFor('approval_request');
    // Wrong conversation → 404, and the real approval is still pending.
    expect(
      handleApprove(Buffer.from(JSON.stringify({ session_id: 'not-my-session', approval_id: ask.approval_id, decision: 'allow' }))).status,
    ).toBe(404);
    // Bad decision → 400.
    const start = await res.waitFor('start');
    expect(
      handleApprove(Buffer.from(JSON.stringify({ session_id: start.session_id, approval_id: ask.approval_id, decision: 'sudo-allow' }))).status,
    ).toBe(400);
    // A genuine approve still works afterwards.
    expect(
      handleApprove(Buffer.from(JSON.stringify({ session_id: start.session_id, approval_id: ask.approval_id, decision: 'allow' }))).status,
    ).toBe(200);
    await done;
  });

  it('an unknown approval_id 404s', () => {
    expect(handleApprove(Buffer.from(JSON.stringify({ session_id: 'x', approval_id: 'nope', decision: 'allow' }))).status).toBe(404);
  });

  it('a timed-out approval deletes its entry so a late approve 404s (single-settle, G4 fix)', async () => {
    const res = new MockRes();
    // Short timeout so the approval self-denies (by DELETION) before we answer.
    const done = handleConverseStream(session(), converseBody(), res as never, {
      toolsOverride: [searchTool()],
      approvalTimeoutMs: 40,
    });
    const ask = await res.waitFor('approval_request');
    const start = await res.waitFor('start');
    await done; // the loop times out, denies, and concludes
    // The entry is gone: a late approve for that id 404s (not a stale 200).
    const late = handleApprove(
      Buffer.from(JSON.stringify({ session_id: start.session_id, approval_id: ask.approval_id, decision: 'allow' })),
    );
    expect(late.status).toBe(404);
    // And the loop concluded with the call denied (timeout).
    expect(res.lines.find((l) => l.type === 'permission' && l.decision !== 'approved')).toBeDefined();
    expect(res.lines.find((l) => l.type === 'done')).toBeDefined();
  });

  it('a denied approval feeds permission_denied and the loop concludes', async () => {
    const res = new MockRes();
    const done = handleConverseStream(session(), converseBody(), res as never, { toolsOverride: [searchTool()] });
    const ask = await res.waitFor('approval_request');
    const start = await res.waitFor('start');
    expect(
      handleApprove(Buffer.from(JSON.stringify({ session_id: start.session_id, approval_id: ask.approval_id, decision: 'deny' }))).status,
    ).toBe(200);
    await done;
    const perm = res.lines.find((l) => l.type === 'permission' && l.decision === 'denied');
    expect(perm).toBeDefined();
    expect(res.lines.find((l) => l.type === 'done')).toBeDefined();
  });
});
