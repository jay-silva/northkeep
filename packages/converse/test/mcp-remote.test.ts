import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addRemoteServer,
  addServer,
  getServer,
  hasRemoteTokens,
  isHttpServer,
  isStdioServer,
  loadCredentials,
  loadMcpConfig,
  mcpConfigPath,
  remoteUrlRefusal,
  saveCredentials,
  setTokenBackend,
  updateCredentials,
  createSession,
  runTask,
  type ChatTurnResult,
  type ModelProvider,
  type TaskEvent,
  type TokenBackend,
  type ToolDefinition,
} from '../src/index.js';

/**
 * M12 — remote MCP servers (ADR 0035). Covers the config discriminated union,
 * the add-time origin check, and the Keychain-backed credential store.
 */

let home: string;
let restoreBackend: () => void;

/** In-memory stand-in for the Keychain. See tokens.ts on why there is no file fallback. */
function memoryBackend(): TokenBackend {
  const items = new Map<string, string>();
  return {
    available: () => true,
    get: (id) => items.get(id) ?? null,
    set: (id, value) => void items.set(id, value),
    delete: (id) => void items.delete(id),
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-mcp-remote-'));
  process.env.NORTHKEEP_HOME = home;
  restoreBackend = setTokenBackend(memoryBackend());
});

afterEach(() => {
  restoreBackend();
  delete process.env.NORTHKEEP_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('remoteUrlRefusal (ADR 0035 Decision 1)', () => {
  it('keeps the endpoint path but drops query and fragment', () => {
    const r = remoteUrlRefusal('https://gmailmcp.googleapis.com/mcp/v1?token=leaked#x');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.endpoint).toBe('https://gmailmcp.googleapis.com/mcp/v1');
      // Identity is the origin; the path is how you reach it.
      expect(r.origin).toBe('https://gmailmcp.googleapis.com');
    }
  });

  it('normalizes a bare origin and a trailing slash to the same endpoint', () => {
    const a = remoteUrlRefusal('https://mcp.example.com/');
    const b = remoteUrlRefusal('https://mcp.example.com');
    expect(a.ok && b.ok && a.endpoint === b.endpoint).toBe(true);
  });

  it('preserves a non-default port, because identity is scheme+host+PORT', () => {
    const r = remoteUrlRefusal('https://mcp.example.com:8443/v1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.origin).toBe('https://mcp.example.com:8443');
  });

  it.each([
    ['http://mcp.example.com/v1', 'plain http'],
    ['https://user:pw@mcp.example.com/v1', 'embedded credentials'],
    ['https://192.168.1.1/mcp', 'a bare private IP'],
    // The first draft of ADR 0035 assumed a remote URL could never be private.
    // It can, which is why the check is positive rather than a blocklist.
    ['https://8.8.8.8/mcp', 'a bare public IP'],
    ['https://[::1]/mcp', 'a bracketed IPv6 literal'],
    ['https://localhost/mcp', 'localhost'],
    ['https://foo.localhost/mcp', 'a .localhost name'],
    ['https://box.local/mcp', 'an mDNS name'],
    ['https://svc.internal/mcp', 'a .internal name'],
    ['not a url', 'an unparseable string'],
    ['ftp://mcp.example.com/', 'a non-http scheme'],
  ])('refuses %s (%s)', (url) => {
    const r = remoteUrlRefusal(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  it('does NOT resolve DNS, so a public name pointing at loopback passes here', () => {
    // Recorded as a test rather than left implicit: the add-time check is
    // syntactic (scheme, name shape, classification). Refusing a name that
    // RESOLVES private is the transport guard's job at connect time, where the
    // answer is fresh and the connection is pinned to it. ADR 0035 Decision 1
    // was amended to say this, because the two checks live in different files
    // and only one of them can see an IP address.
    expect(remoteUrlRefusal('https://127.0.0.1.nip.io/mcp').ok).toBe(true);
  });
});

describe('config discriminated union (ADR 0035 Decision 9)', () => {
  it('stores a remote server as endpoint, strict, with no fingerprint', () => {
    const s = addRemoteServer({ id: 'gmail', url: 'https://mcp.example.com/v1/rpc?k=1' });
    expect(s.transport).toBe('http');
    expect(s.url).toBe('https://mcp.example.com/v1/rpc');
    expect(s.trust).toBe('strict');
    expect(s).not.toHaveProperty('fingerprint');
    expect(s).not.toHaveProperty('command');

    const reloaded = getServer('gmail');
    expect(reloaded).toBeDefined();
    expect(isHttpServer(reloaded!)).toBe(true);
  });

  it('refuses a remote add whose URL would not pass the origin check', () => {
    expect(() => addRemoteServer({ id: 'bad', url: 'http://mcp.example.com' })).toThrow(/https/);
    expect(loadMcpConfig().servers).toHaveLength(0);
  });

  it('refuses to rebind an existing id, remote or local', () => {
    addRemoteServer({ id: 'gmail', url: 'https://mcp.example.com' });
    expect(() => addRemoteServer({ id: 'gmail', url: 'https://other.example.com' })).toThrow(/already exists/);
  });

  it('marks a stdio add as transport stdio', () => {
    const cmd = path.join(home, 'server.js');
    fs.writeFileSync(cmd, '// fake\n');
    const s = addServer({ id: 'local', command: cmd, args: [] });
    expect(s.transport).toBe('stdio');
    expect(isStdioServer(s)).toBe(true);
  });

  it('loads a pre-M12 entry (no transport field) as stdio, unchanged', () => {
    // The regression that would otherwise be invisible: Jay's existing vault
    // server was written before the union existed. If the loader dropped it,
    // the symptom is "all my MCP tools vanished" and no other test would fail.
    const cmd = path.join(home, 'server.js');
    fs.writeFileSync(cmd, '// fake\n');
    fs.mkdirSync(path.dirname(mcpConfigPath()), { recursive: true });
    fs.writeFileSync(
      mcpConfigPath(),
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: 'vault',
            command: cmd,
            args: ['--stdio'],
            cwd: home,
            env: { FOO: 'bar' },
            trust: 'trusted',
            safeRead: ['search'],
            fingerprint: 'a'.repeat(64),
            addedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const loaded = getServer('vault');
    expect(loaded).toBeDefined();
    expect(isStdioServer(loaded!)).toBe(true);
    if (isStdioServer(loaded!)) {
      expect(loaded.command).toBe(cmd);
      expect(loaded.args).toEqual(['--stdio']);
      expect(loaded.cwd).toBe(home);
      expect(loaded.env).toEqual({ FOO: 'bar' });
      expect(loaded.fingerprint).toBe('a'.repeat(64));
    }
    expect(loaded!.trust).toBe('trusted');
    expect(loaded!.safeRead).toEqual(['search']);
  });

  it('drops a hand-edited remote entry that is trusted, or whose URL is refused', () => {
    fs.mkdirSync(path.dirname(mcpConfigPath()), { recursive: true });
    fs.writeFileSync(
      mcpConfigPath(),
      JSON.stringify({
        version: 1,
        servers: [
          { id: 'a', transport: 'http', url: 'https://ok.example.com', trust: 'trusted', safeRead: [], addedAt: 'x' },
          { id: 'b', transport: 'http', url: 'http://ok.example.com', trust: 'strict', safeRead: [], addedAt: 'x' },
          { id: 'c', transport: 'http', url: 'https://ok.example.com', trust: 'strict', safeRead: [], addedAt: 'x' },
        ],
      }),
    );
    expect(loadMcpConfig().servers.map((s) => s.id)).toEqual(['c']);
  });
});

describe('credential store (ADR 0035 Decision 8)', () => {
  it('reports not-connected until a token exists', () => {
    addRemoteServer({ id: 'gmail', url: 'https://mcp.example.com' });
    expect(hasRemoteTokens('gmail')).toBe(false);
    saveCredentials('gmail', {
      origin: 'https://mcp.example.com',
      tokens: { access_token: 'at', token_type: 'Bearer' },
    });
    expect(hasRemoteTokens('gmail')).toBe(true);
  });

  it('keeps no secret in mcp.json', () => {
    addRemoteServer({ id: 'gmail', url: 'https://mcp.example.com', clientId: 'client-123' });
    saveCredentials('gmail', {
      origin: 'https://mcp.example.com',
      tokens: { access_token: 'SECRET-ACCESS', token_type: 'Bearer', refresh_token: 'SECRET-REFRESH' },
      client: { client_id: 'client-123', client_secret: 'SECRET-CLIENT' },
      codeVerifier: 'SECRET-VERIFIER',
    });
    const onDisk = fs.readFileSync(mcpConfigPath(), 'utf8');
    expect(onDisk).toContain('client-123'); // the id is not a secret
    for (const secret of ['SECRET-ACCESS', 'SECRET-REFRESH', 'SECRET-CLIENT', 'SECRET-VERIFIER']) {
      expect(onDisk).not.toContain(secret);
    }
  });

  it('serializes concurrent updates so a refresh cannot lose a rotated token', async () => {
    saveCredentials('gmail', {
      origin: 'https://mcp.example.com',
      tokens: { access_token: 'v0', token_type: 'Bearer', refresh_token: 'r0' },
    });
    // Both writers read-modify-write. Without the chain, the second read sees
    // the pre-first state and the first rotation is lost.
    await Promise.all([
      updateCredentials('gmail', (cur) => ({
        ...cur!,
        tokens: { ...cur!.tokens!, access_token: 'v1', refresh_token: 'r1' },
      })),
      updateCredentials('gmail', (cur) => ({
        ...cur!,
        tokens: { ...cur!.tokens!, scope: `seen:${cur!.tokens!.refresh_token}` },
      })),
    ]);
    const final = loadCredentials('gmail');
    expect(final?.tokens?.refresh_token).toBe('r1');
    expect(final?.tokens?.scope).toBe('seen:r1');
  });

  it('treats an unreadable record as no record rather than throwing', () => {
    const backend = memoryBackend();
    restoreBackend();
    restoreBackend = setTokenBackend(backend);
    backend.set('gmail', 'not json');
    expect(loadCredentials('gmail')).toBeNull();
    expect(hasRemoteTokens('gmail')).toBe(false);
  });
});

describe('privacy ceiling on remote MCP egress (ADR 0035 Decision 3, option B)', () => {
  const PRIVATE_URL = 'http://localhost:11434/v1';

  /** Minimal scripted provider: one tool call, then a final answer. */
  function providerCalling(toolName: string): ModelProvider {
    const script: ChatTurnResult[] = [
      {
        text: '',
        toolCalls: [{ id: 'c1', name: toolName, arguments: '{"q":"hello"}' }],
        stopReason: 'tool_use',
      },
      { text: 'done', toolCalls: [], stopReason: 'end' },
    ];
    const provider: ModelProvider = {
      kind: 'openai-compatible',
      baseUrl: PRIVATE_URL,
      chat: (m, o) => provider.chatTurn(m, o).then((r) => r.text),
      chatTurn: () => Promise.resolve(script.shift()!),
    };
    return provider;
  }

  function mcpTool(serverId: string, executed: string[]): ToolDefinition {
    return {
      name: `${serverId}__search`,
      serverId,
      description: 'search',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      risk: 'safe-read',
      egress: () => null,
      execute: (args) => {
        executed.push(JSON.stringify(args));
        return Promise.resolve({ content: 'result', meta: { bytes: 6, truncated: false, ok: true } });
      },
    };
  }

  async function run(serverId: string, ceiling: 'private-only' | 'bounded-allowed') {
    const executed: string[] = [];
    const events: TaskEvent[] = [];
    const result = await runTask({
      provider: providerCalling(`${serverId}__search`),
      vault: { retrieve: () => [], list: () => [], commit: () => [] },
      session: createSession(),
      model: 'llama3.2:3b',
      message: 'search my mail',
      redactTier: 0,
      distill: false,
      tools: [mcpTool(serverId, executed)],
      ceiling,
      // Auto-approve everything, so a refusal can only come from the ceiling.
      gate: { evaluate: () => Promise.resolve('allow') },
      hooks: {
        onEvent: (e) => void events.push(e),
        requestApproval: () => Promise.resolve('allow' as const),
      },
      auditFn: () => undefined,
    });
    return { executed, events, result };
  }

  it('refuses a REMOTE MCP tool in a private-pinned conversation, before it runs', async () => {
    addRemoteServer({ id: 'gmail', url: 'https://mcp.example.com/v1' });
    const { executed, events, result } = await run('gmail', 'private-only');
    expect(executed).toEqual([]); // nothing left the machine
    const denial = events.find((e) => e.type === 'permission' && e.decision === 'denied');
    expect(denial).toBeDefined();
    expect(JSON.stringify(denial)).toMatch(/pinned to private/);
    // Denied, and with no egress recorded, because nothing egressed.
    expect(result.toolCallsMade[0]?.decision).toBe('denied');
    expect(result.toolCallsMade[0]).not.toHaveProperty('egress');
  });

  it('allows the SAME tool when the conversation is not pinned', async () => {
    addRemoteServer({ id: 'gmail', url: 'https://mcp.example.com/v1' });
    const { executed } = await run('gmail', 'bounded-allowed');
    expect(executed).toEqual(['{"q":"hello"}']);
  });

  it('does NOT refuse a LOCAL stdio server in a private-pinned conversation', async () => {
    // The asymmetry is deliberate: a local program is not egress, so the
    // ceiling has nothing to bind. If this ever starts failing, the ceiling has
    // grown a reach ADR 0035 did not give it.
    const cmd = path.join(home, 'server.js');
    fs.writeFileSync(cmd, '// fake\n');
    addServer({ id: 'vault', command: cmd, args: [] });
    const { executed } = await run('vault', 'private-only');
    expect(executed).toEqual(['{"q":"hello"}']);
  });
});
