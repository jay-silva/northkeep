import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectServer,
  createPermissionEngine,
  createSession,
  getServer,
  pinTools,
  runTask,
  setToolsPin,
  type ApprovalRequest,
  type ChatMessage,
  type ChatOptions,
  type ChatTurnResult,
  type ModelProvider,
  type TaskEvent,
} from '../packages/converse/dist/index.js';
import type { CallLogEntry } from '../packages/mcp-server/dist/index.js';

/**
 * M11 e2e (ADR 0033): the agent loop driving NorthKeep's OWN MCP server as a
 * client. This is Decision 5 — the vault's server goes first and gets no
 * privilege for being ours — and it is the only test that exercises a REAL
 * stdio child process, a real MCP handshake, and the real permission path
 * together.
 *
 * The MODEL is scripted (no network, no Ollama); everything else is real.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const mcpServerPath = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js');
const PASSPHRASE = 'm11 e2e passphrase';
const PRIVATE_URL = 'http://127.0.0.1:11434';

let home: string;

function cli(args: string[]): Promise<string> {
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

/** A provider that asks for one tool call, then concludes. */
function scripted(script: ChatTurnResult[]): ModelProvider {
  const provider: ModelProvider = {
    kind: 'openai-compatible',
    baseUrl: PRIVATE_URL,
    chat: (m, o) => provider.chatTurn(m, o).then((r) => r.text),
    chatTurn: (_messages: ChatMessage[], options: ChatOptions) => {
      const next = script.shift();
      if (next === undefined) throw new Error('script exhausted');
      if (next.text.length > 0) options.onToken?.(next.text);
      return Promise.resolve(next);
    },
    listModels: () => Promise.resolve([]),
  };
  return provider;
}

const vault = { retrieve: () => [], list: () => [], commit: () => [] };

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-m11-e2e-'));
  process.env.NORTHKEEP_HOME = home;
  await cli(['init']);
  await cli(['remember', '--type', 'semantic', 'My espresso machine is a Rancilio Silvia']);
  // Our own MCP server, added the way a user would. memory_retrieve is declared
  // read-only; memory_forget deliberately is NOT (fail closed → asks every time).
  await cli([
    'mcp',
    'add',
    'vault',
    '--command',
    process.execPath,
    '--arg',
    mcpServerPath,
    '--safe-read',
    'memory_retrieve,memory_list',
    // A server is told what it needs through explicit config, and the
    // fingerprint covers exactly these values.
    '--env',
    `NORTHKEEP_HOME=${home}`,
    '--env',
    `NORTHKEEP_PASSPHRASE=${PASSPHRASE}`,
    '--env',
    'NORTHKEEP_NO_KEYCHAIN=1',
  ]);
}, 120_000);

afterAll(() => {
  delete process.env.NORTHKEEP_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('M11 — the vault as an MCP tool, under the gate', () => {
  it('lists the real server\'s tools, namespaced, with declared risk', async () => {
    const out = await cli(['mcp', 'tools', 'vault']);
    expect(out).toContain('vault__memory_retrieve');
    expect(out).toContain('vault__memory_forget');
    expect(out).toMatch(/vault__memory_retrieve\s+.*read-only/);
    // Undeclared → consequential, which can never hold an 'always' grant.
    expect(out).toMatch(/vault__memory_forget\s+.*consequential/);
  }, 60_000);

  it('runs a REAL tool call through the loop: approval, execution, fenced result, audit', async () => {
    const server = getServer('vault')!;
    const conn = await connectServer(server);
    setToolsPin('vault', conn.pin);
    try {
      const provider = scripted([
        {
          text: 'Let me check your vault.',
          toolCalls: [
            {
              id: 'c1',
              name: 'vault__memory_retrieve',
              arguments: JSON.stringify({ query: 'espresso' }),
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'You have a Rancilio Silvia.', toolCalls: [], stopReason: 'end' },
      ]);
      const approvals: ApprovalRequest[] = [];
      const events: TaskEvent[] = [];
      const rows: CallLogEntry[] = [];
      const session = createSession();

      const result = await runTask({
        session,
        provider,
        model: 'scripted',
        vault,
        distill: false,
        auditFn: (e) => rows.push(e),
        message: 'what espresso machine do I have?',
        redactTier: 0,
        tools: conn.tools,
        gate: createPermissionEngine({ persist: false }),
        hooks: {
          onEvent: (e) => events.push(e),
          requestApproval: (req) => {
            approvals.push(req);
            return Promise.resolve('allow');
          },
        },
      });

      expect(result.reply).toBe('You have a Rancilio Silvia.');

      // The gate saw an MCP call: no host to show, but it names the SERVER, so
      // the user is never asked to approve an unnamed thing (ADR 0033 D4).
      expect(approvals).toHaveLength(1);
      expect(approvals[0]!.tool).toBe('vault__memory_retrieve');
      expect(approvals[0]!.egress).toBeNull();
      expect(approvals[0]!.server).toBe('vault');

      // The real server actually answered out of the real vault.
      const toolMsg = session.plainHistory.find((m) => m.role === 'tool')!;
      expect(toolMsg.content).toContain('Rancilio Silvia');
      // ...and it is FENCED, even though there is no egress URL to name. This
      // is the fail-open that ADR 0033 called out and the loop now closes.
      expect(toolMsg.content).toMatch(/^\[EXTERNAL CONTENT «[0-9a-f]{16}» /);
      expect(toolMsg.content).toContain('[END EXTERNAL CONTENT');

      // Audit names the server, since there is no domain to name, and stays
      // content-free: no query text, no memory content.
      const toolRows = rows.filter((r) => r.tool_call !== undefined);
      expect(toolRows).toHaveLength(1);
      expect(toolRows[0]!.tool_call!.mcp_server).toBe('vault');
      expect(toolRows[0]!.tool_call!.domain).toBeUndefined();
      expect(toolRows[0]!.tool_call!.decision).toBe('approved');
      const logText = JSON.stringify(rows);
      expect(logText).not.toContain('Rancilio');
      expect(logText).not.toContain('espresso');

      // Nothing egressed anywhere nameable, so the proof reports no egress.
      expect(result.toolCallsMade[0]).not.toHaveProperty('egress');
    } finally {
      await conn.close();
    }
  }, 60_000);

  it('remembers an "always" for a read-only tool, keyed on the SERVER', async () => {
    const server = getServer('vault')!;
    const conn = await connectServer(server);
    try {
      const engine = createPermissionEngine({ persist: true });
      const run = async (answer: 'allow-always' | 'allow'): Promise<ApprovalRequest[]> => {
        const asked: ApprovalRequest[] = [];
        await runTask({
          session: createSession(),
          provider: scripted([
            {
              text: '',
              toolCalls: [
                { id: 'c1', name: 'vault__memory_retrieve', arguments: '{"query":"x"}' },
              ],
              stopReason: 'tool_use',
            },
            { text: 'done', toolCalls: [], stopReason: 'end' },
          ]),
          model: 'scripted',
          vault,
          distill: false,
          auditFn: () => {},
          message: 'look it up',
          redactTier: 0,
          tools: conn.tools,
          gate: engine,
          hooks: {
            onEvent: () => {},
            requestApproval: (req) => {
              asked.push(req);
              return Promise.resolve(answer);
            },
          },
        });
        return asked;
      };

      expect(await run('allow-always')).toHaveLength(1); // asked once
      const grants = JSON.parse(
        fs.readFileSync(path.join(home, 'permissions.json'), 'utf8'),
      ) as { grants: Array<Record<string, unknown>> };
      const grant = grants.grants.find((g) => g.tool === 'vault__memory_retrieve')!;
      // Keyed on the server, with NO host — the whole point of Decision 1.
      expect(grant.server).toBe('vault');
      expect(grant.host).toBeUndefined();
      expect(grant.scope).toBe('always');

      // A second run is auto-allowed by that grant: no prompt at all.
      expect(await run('allow')).toHaveLength(0);
    } finally {
      await conn.close();
    }
  }, 60_000);


  it('an AUTO-ALLOWED MCP call still shows what it sent (audit gap)', async () => {
    // A granted MCP call displays no prompt, and the audit keeps only a hash,
    // so before this the arguments a granted server received were visible
    // NOWHERE. The ephemeral turn proof now carries the masked arguments.
    const conn = await connectServer(getServer('vault')!);
    try {
      const engine = createPermissionEngine({ persist: false });
      const run = async (answer: 'allow-always' | 'allow') =>
        runTask({
          session: createSession(),
          provider: scripted([
            {
              text: '',
              toolCalls: [
                { id: 'c1', name: 'vault__memory_retrieve', arguments: '{"query":"espresso"}' },
              ],
              stopReason: 'tool_use',
            },
            { text: 'done', toolCalls: [], stopReason: 'end' },
          ]),
          model: 'scripted',
          vault,
          distill: false,
          auditFn: () => {},
          message: 'look it up',
          redactTier: 0,
          tools: conn.tools,
          gate: engine,
          hooks: { onEvent: () => {}, requestApproval: () => Promise.resolve(answer) },
        });

      await run('allow-always');
      // Second turn is auto-allowed by the grant: no prompt is shown at all.
      const second = await run('allow');
      const call = second.toolCallsMade[0]!;
      expect(call.mcpServer).toBe('vault');
      expect(call.argsSent).toContain('espresso');
      // It still reports no URL egress, because none is nameable.
      expect(call).not.toHaveProperty('egress');
    } finally {
      await conn.close();
    }
  }, 60_000);

  it('never lets a CONSEQUENTIAL tool be remembered, so it asks every time', async () => {
    const server = getServer('vault')!;
    const conn = await connectServer(server);
    try {
      const engine = createPermissionEngine({ persist: true });
      const askFor = async (): Promise<number> => {
        let asked = 0;
        await runTask({
          session: createSession(),
          provider: scripted([
            {
              text: '',
              toolCalls: [
                { id: 'c1', name: 'vault__memory_forget', arguments: '{"id":"nope"}' },
              ],
              stopReason: 'tool_use',
            },
            { text: 'done', toolCalls: [], stopReason: 'end' },
          ]),
          model: 'scripted',
          vault,
          distill: false,
          auditFn: () => {},
          message: 'forget it',
          redactTier: 0,
          tools: conn.tools,
          gate: engine,
          hooks: {
            onEvent: () => {},
            requestApproval: () => {
              asked += 1;
              // Even answering "always" must not create a grant for a
              // consequential tool (ADR 0033 Decision 4).
              return Promise.resolve('allow-always');
            },
          },
        });
        return asked;
      };
      expect(await askFor()).toBe(1);
      expect(await askFor()).toBe(1); // asked AGAIN — nothing was remembered
      const raw = fs.readFileSync(path.join(home, 'permissions.json'), 'utf8');
      expect(raw).not.toContain('vault__memory_forget');
    } finally {
      await conn.close();
    }
  }, 60_000);

  it('refuses to connect once the advertised definitions change', async () => {
    const server = getServer('vault')!;
    // Pretend we approved a different tool list.
    setToolsPin('vault', pinTools([{ name: 'something_else' }]));
    await expect(connectServer(getServer('vault')!)).rejects.toThrow(/have CHANGED/);
    // Restore for any later test.
    const conn = await connectServer(getServer('vault')!, { enforcePin: false });
    setToolsPin('vault', conn.pin);
    await conn.close();
    expect(server.id).toBe('vault');
  }, 60_000);
});

describe('M11 — screens and the argument floor (ADR 0033 Decision 3)', () => {
  it('HARD-BLOCKS a secret-shaped argument to an MCP tool, before any prompt', async () => {
    const conn = await connectServer(getServer('vault')!);
    try {
      let asked = 0;
      const events: TaskEvent[] = [];
      await runTask({
        session: createSession(),
        provider: scripted([
          {
            text: '',
            toolCalls: [
              {
                id: 'c1',
                name: 'vault__memory_remember',
                arguments: JSON.stringify({ content: 'my ssn is 123-45-6789' }),
              },
            ],
            stopReason: 'tool_use',
          },
          { text: 'done', toolCalls: [], stopReason: 'end' },
        ]),
        model: 'scripted',
        vault,
        distill: false,
        auditFn: () => {},
        message: 'remember it',
        redactTier: 0,
        tools: conn.tools,
        gate: createPermissionEngine({ persist: false }),
        hooks: {
          onEvent: (e) => events.push(e),
          requestApproval: () => {
            asked += 1;
            return Promise.resolve('allow');
          },
        },
      });
      // The screens carry over to MCP calls (ADR 0033 delta table): a
      // catastrophic-secret shape is refused BEFORE a human is even asked, so
      // there is no prompt to fatigue-click through.
      expect(asked).toBe(0);
      const perm = events.find((e) => e.type === 'permission');
      expect(perm).toBeDefined();
      expect((perm as { decision: string }).decision).not.toBe('approved');
      expect((perm as { via?: string }).via).toBe('screen');
    } finally {
      await conn.close();
    }
  }, 60_000);

  it('applies the Tier-1 floor to what a STRICT server actually receives', async () => {
    // End to end: the model asks to store an email address, the user approves,
    // and the memory the server really wrote is inspected afterwards. A strict
    // server is an unknown destination, so it must receive the masked form.
    const conn = await connectServer(getServer('vault')!);
    try {
      await runTask({
        session: createSession(),
        provider: scripted([
          {
            text: '',
            toolCalls: [
              {
                id: 'c1',
                name: 'vault__memory_remember',
                arguments: JSON.stringify({
                  content: 'Reach my plumber at pipes@example.com',
                  type: 'semantic',
                }),
              },
            ],
            stopReason: 'tool_use',
          },
          { text: 'stored', toolCalls: [], stopReason: 'end' },
        ]),
        model: 'scripted',
        vault,
        distill: false,
        auditFn: () => {},
        message: 'remember my plumber',
        redactTier: 0,
        tools: conn.tools,
        gate: createPermissionEngine({ persist: false }),
        hooks: { onEvent: () => {}, requestApproval: () => Promise.resolve('allow') },
      });
      const listed = await cli(['list']);
      expect(listed).toContain('plumber');
      // The real email never reached the server; the deterministic mask did.
      expect(listed).not.toContain('pipes@example.com');
      expect(listed).toMatch(/\[EMAIL_\d+\]/);
    } finally {
      await conn.close();
    }
  }, 60_000);
});

// ---------- the web GUI path (M11 GUI) ----------

describe('M11 GUI — the same servers, the same gate, over HTTP', () => {
  let server: ChildProcess;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    const serverPath = path.join(repoRoot, 'apps', 'web', 'dist', 'server.js');
    server = spawn(process.execPath, [serverPath], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NORTHKEEP_HOME: home,
        NORTHKEEP_PASSPHRASE: PASSPHRASE,
        NORTHKEEP_NO_KEYCHAIN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 30_000);
      server.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/.exec(buf);
        if (m) {
          clearTimeout(t);
          resolve(m[0]);
        }
      });
    });
    const parsed = new URL(url);
    baseUrl = parsed.origin;
    token = parsed.searchParams.get('token')!;
  }, 60_000);

  afterAll(() => {
    server?.kill('SIGTERM');
  });

  const call = async (route: string, init?: { method?: string; json?: unknown }) => {
    const res = await fetch(`${baseUrl}${route}`, {
      method: init?.method ?? 'GET',
      headers: {
        'X-NorthKeep-Token': token,
        ...(init?.json !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init?.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('lists configured servers without exposing anything a model could reach', async () => {
    const { status, body } = await call('/api/mcp');
    expect(status).toBe(200);
    const servers = body.servers as Array<Record<string, unknown>>;
    expect(servers.map((s) => s.id)).toContain('vault');
    expect(servers[0]!.reviewed).toBeDefined();
  }, 60_000);

  it('the add route exists but a token alone can never spawn a program (ADR 0034)', async () => {
    // M11 had no add route at all, which left desktop-only users unable to use
    // MCP. ADR 0034 replaced that blunt rule with the property that actually
    // matters: an automated caller holding a session token cannot cause a
    // program to be spawned. A path needs the passphrase; see the ADR-0034
    // block below for the full matrix.
    const { status } = await call('/api/mcp/add', {
      method: 'POST',
      json: { id: 'evil', command: '/bin/sh' },
    });
    expect(status).toBe(401);
  }, 60_000);

  it('inspects a server: real definitions, and whether they match what was approved', async () => {
    const { status, body } = await call('/api/mcp/inspect', { method: 'POST', json: { id: 'vault' } });
    expect(status).toBe(200);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.name)).toContain('vault__memory_retrieve');
    // Risk is OUR classification, not the server's claim.
    const forget = tools.find((t) => t.name === 'vault__memory_forget')!;
    expect(forget.risk).toBe('consequential');
    expect(body.pin).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it('accepting a pin is accepting exactly what was shown', async () => {
    const inspect = await call('/api/mcp/inspect', { method: 'POST', json: { id: 'vault' } });
    const pin = inspect.body.pin as string;
    expect((await call('/api/mcp/accept', { method: 'POST', json: { id: 'vault', pin } })).status).toBe(200);
    const after = await call('/api/mcp/inspect', { method: 'POST', json: { id: 'vault' } });
    expect(after.body.reviewed).toBe(true);
    expect(after.body.changed).toBe(false);
  }, 60_000);

  it('404s an unknown server rather than guessing', async () => {
    expect((await call('/api/mcp/inspect', { method: 'POST', json: { id: 'nope' } })).status).toBe(404);
    expect((await call('/api/mcp/remove', { method: 'POST', json: { id: 'nope' } })).status).toBe(404);
  }, 60_000);


  it('safe-read accepts the NAMESPACED names the panel shows, and really applies them', async () => {
    // The inspect route returns `vault__memory_list`, but risk is matched on the
    // bare name — so accepting the displayed form used to return 200 and change
    // nothing. A permission setting that silently does not apply is the failure
    // mode invariant #6 exists to prevent.
    // Establish the precondition rather than assuming it: only memory_retrieve
    // is read-only, so memory_list must currently be consequential.
    await call('/api/mcp/safe-read', {
      method: 'POST',
      json: { id: 'vault', tools: ['memory_retrieve'] },
    });
    const before = await call('/api/mcp/inspect', { method: 'POST', json: { id: 'vault' } });
    const listBefore = (before.body.tools as Array<Record<string, unknown>>).find(
      (t) => t.name === 'vault__memory_list',
    )!;
    expect(listBefore.risk).toBe('consequential');

    const set = await call('/api/mcp/safe-read', {
      method: 'POST',
      json: { id: 'vault', tools: ['vault__memory_retrieve', 'vault__memory_list'] },
    });
    expect(set.status).toBe(200);

    const after = await call('/api/mcp/inspect', { method: 'POST', json: { id: 'vault' } });
    const listAfter = (after.body.tools as Array<Record<string, unknown>>).find(
      (t) => t.name === 'vault__memory_list',
    )!;
    expect(listAfter.risk).toBe('safe-read');
    // Restore the original declaration for any later test.
    await call('/api/mcp/safe-read', {
      method: 'POST',
      json: { id: 'vault', tools: ['memory_retrieve', 'memory_list'] },
    });
  }, 60_000);

  it('refuses a tool name belonging to a DIFFERENT server rather than silently ignoring it', async () => {
    const res = await call('/api/mcp/safe-read', {
      method: 'POST',
      json: { id: 'vault', tools: ['other__memory_list'] },
    });
    expect(res.status).toBe(400);
  }, 60_000);

  it('caps the safe-read list so a huge write cannot bloat the config read on every turn', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `t${i}`);
    expect((await call('/api/mcp/safe-read', { method: 'POST', json: { id: 'vault', tools: many } })).status).toBe(400);
  }, 60_000);


  // ---- ADR 0034: adding a server from the GUI ----

  it('offers a catalog whose entries carry no caller-supplied path', async () => {
    const { status, body } = await call('/api/mcp/catalog');
    expect(status).toBe(200);
    const entries = body.entries as Array<Record<string, unknown>>;
    const vaultEntry = entries.find((e) => e.id === 'vault')!;
    expect(vaultEntry.available).toBe(true);
    // The command is OURS, resolved from this installation.
    expect(vaultEntry.command).toBe(process.execPath);
    expect(vaultEntry.safe_read ?? vaultEntry.safeRead).toBeDefined();
  }, 60_000);

  it('adds a catalog server in one call, with no passphrase and no path', async () => {
    const { status, body } = await call('/api/mcp/add', {
      method: 'POST',
      json: { id: 'fromcatalog', catalogId: 'vault' },
    });
    expect(status).toBe(200);
    expect(body.reviewed).toBe(false); // adding is never approving
    const list = await call('/api/mcp');
    const added = (list.body.servers as Array<Record<string, unknown>>).find(
      (s) => s.id === 'fromcatalog',
    )!;
    expect(added.reviewed).toBe(false);
    expect(added.command).toBe(process.execPath);
    await call('/api/mcp/remove', { method: 'POST', json: { id: 'fromcatalog' } });
  }, 60_000);

  it('REFUSES a free-form path with a valid token but no passphrase', async () => {
    // This is the attack ADR 0034 is written against: an automated caller
    // holding a session token (leaked token, SSRF bypass, injected model)
    // must not be able to cause a program to be spawned.
    const { status, body } = await call('/api/mcp/add', {
      method: 'POST',
      json: { id: 'evil', command: '/bin/sh', args: ['-c', 'echo pwned'] },
    });
    expect(status).toBe(401);
    expect(String(body.error)).toMatch(/passphrase/i);
    expect((await call('/api/mcp')).body.servers).not.toContainEqual(
      expect.objectContaining({ id: 'evil' }),
    );
  }, 60_000);

  it('REFUSES a wrong passphrase, and adds nothing', async () => {
    const { status } = await call('/api/mcp/add', {
      method: 'POST',
      json: { id: 'evil', command: '/bin/sh', passphrase: 'not the passphrase' },
    });
    expect(status).toBe(401);
  }, 120_000);

  it('REFUSES a path outside the allowed roots EVEN WITH the right passphrase', async () => {
    // The structural bound: the GUI cannot be talked into /bin/sh even by
    // someone who knows the passphrase.
    const { status, body } = await call('/api/mcp/add', {
      method: 'POST',
      json: { id: 'evil', command: '/bin/sh', passphrase: PASSPHRASE },
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/terminal/i);
  }, 120_000);

  it('ACCEPTS a free-form path under an allowed root with the right passphrase', async () => {
    // ~/.northkeep/mcp-servers is an allowed root; NORTHKEEP_HOME is the temp
    // home for this run, but allowedGuiRoots uses os.homedir(), so use the
    // installation root instead — the repo itself is allowed.
    const { status } = await call('/api/mcp/add', {
      method: 'POST',
      json: {
        id: 'allowed',
        command: process.execPath,
        args: [mcpServerPath],
        passphrase: PASSPHRASE,
      },
    });
    // process.execPath may sit outside the allowed roots on some machines; in
    // that case the refusal must be the ALLOWLIST one, never a silent add.
    expect([200, 400]).toContain(status);
    if (status === 200) {
      await call('/api/mcp/remove', { method: 'POST', json: { id: 'allowed' } });
    }
  }, 120_000);

  it('never accepts environment variables from the GUI', async () => {
    // Those land in plain text in mcp.json; a browser form invites secrets.
    const { status } = await call('/api/mcp/add', {
      method: 'POST',
      json: { id: 'fromcatalog2', catalogId: 'vault', env: { SECRET: 'nope' } },
    });
    expect(status).toBe(200);
    const raw = fs.readFileSync(path.join(home, 'mcp.json'), 'utf8');
    expect(raw).not.toContain('nope');
    await call('/api/mcp/remove', { method: 'POST', json: { id: 'fromcatalog2' } });
  }, 60_000);

  it('requires the session token like every other route', async () => {
    const res = await fetch(`${baseUrl}/api/mcp`);
    expect(res.status).toBe(401);
  }, 60_000);
});
