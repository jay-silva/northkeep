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
  probeRequiresAuth,
  remoteUrlRefusal,
  saveCredentials,
  setTokenBackend,
  updateCredentials,
  createSession,
  runTask,
  startRemoteConnect,
  KeychainOAuthProvider,
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

  it('refuses a tool whose serverId is NOT in the config, in a private-pinned conversation', async () => {
    // Adversarial review 2026-07-27, finding 5: nothing is added to the
    // config, so the id resolves to no server at all. The ceiling must refuse
    // that as remote (unknown = it leaves), not classify it as local because
    // the lookup came back empty. An already-connected remote tool whose
    // config row was removed mid-turn is exactly this shape.
    const { executed, events, result } = await run('ghost', 'private-only');
    expect(executed).toEqual([]);
    const denial = events.find((e) => e.type === 'permission' && e.decision === 'denied');
    expect(denial).toBeDefined();
    expect(JSON.stringify(denial)).toMatch(/pinned to private/);
    expect(result.toolCallsMade[0]?.decision).toBe('denied');
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

/**
 * A provider that answers only the OAuth discovery documents, so the SDK can
 * build an authorization URL without touching the network. Everything else 404s.
 */
const fakeOAuthDiscovery: typeof fetch = (input) => {
  const url = String(typeof input === 'string' ? input : (input as URL).toString());
  if (url.includes('/.well-known/oauth-authorization-server') || url.includes('/.well-known/openid-configuration')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          issuer: 'https://mcp.example.com',
          authorization_endpoint: 'https://mcp.example.com/authorize',
          token_endpoint: 'https://mcp.example.com/token',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
};

describe('a completed sign-in persists the client credentials it used', () => {
  it('stores a pasted client secret on token save, so refresh can authenticate later', async () => {
    const provider = new KeychainOAuthProvider({
      serverId: 'gmail',
      origin: 'https://mcp.example.com',
      clientId: 'client-123',
      clientSecret: 'the-pasted-secret',
    });
    await provider.saveTokens({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' });
    const rec = loadCredentials('gmail');
    expect(rec?.client).toEqual({ client_id: 'client-123', client_secret: 'the-pasted-secret' });
    expect(rec?.tokens?.refresh_token).toBe('rt');
  });

  it('preserves a stored DCR registration when this attempt pasted nothing', async () => {
    saveCredentials('cloudflare', {
      origin: 'https://mcp.example.com',
      client: { client_id: 'dcr-client', client_secret: 'dcr-secret' },
    });
    const provider = new KeychainOAuthProvider({
      serverId: 'cloudflare',
      origin: 'https://mcp.example.com',
    });
    await provider.saveTokens({ access_token: 'at', token_type: 'Bearer' });
    expect(loadCredentials('cloudflare')?.client).toEqual({
      client_id: 'dcr-client',
      client_secret: 'dcr-secret',
    });
  });
});

describe('probeRequiresAuth: what counts as demanding credentials', () => {
  const server = { id: 'gmail', transport: 'http', url: 'https://mcp.example.com/v1', trust: 'strict', safeRead: [], addedAt: 'now' } as never;

  it('treats PUBLISHED protected-resource metadata as demanding auth, without a handshake', async () => {
    // Acceptance finding 2026-07-27: Google's Gmail server answers the
    // anonymous handshake and even tools/list, gating only tools/call. Its
    // RFC 9728 declaration is the honest signal. The stub REFUSES any POST so
    // the test also proves the metadata path never falls through to a
    // handshake attempt.
    const calls: Array<{ url: string; method: string }> = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const url = String(typeof input === 'string' ? input : (input as URL).toString());
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (method !== 'GET') {
        return Promise.reject(new Error('the metadata path must not attempt a handshake'));
      }
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              resource: 'https://mcp.example.com/v1',
              authorization_servers: ['https://accounts.example.com/'],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };
    await expect(probeRequiresAuth(server, fakeFetch)).resolves.toBe(true);
    expect(calls.some((c) => c.url.includes('/.well-known/oauth-protected-resource'))).toBe(true);
    // The strong claim, asserted rather than implied: a rejected POST would be
    // swallowed by the probe's catch and the probe would still return true, so
    // only this proves no handshake was attempted after the metadata answered.
    expect(calls.every((c) => c.method === 'GET' && c.url.includes('/.well-known/'))).toBe(true);
  });

  it('still refuses a server with NO declaration that lets the anonymous handshake in', async () => {
    // The refusal ADR 0035 promised, kept: credential-less in fact means no
    // metadata AND an open door. The stub speaks just enough streamable-http
    // to let an anonymous initialize succeed.
    const fakeFetch: typeof fetch = (input, init) => {
      const url = String(typeof input === 'string' ? input : (input as URL).toString());
      if (url.includes('/.well-known/')) {
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      if ((init?.method ?? 'GET') === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
        if (body.method === 'initialize') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: {
                  protocolVersion: '2025-06-18',
                  capabilities: {},
                  serverInfo: { name: 'open-door', version: '1' },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        // notifications/initialized and anything else: accepted, no content.
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };
    await expect(probeRequiresAuth(server, fakeFetch)).resolves.toBe(false);
  });
});

describe('a sign-in attempt must not destroy the grant it is replacing', () => {
  /** The record a connected server has: tokens, and a client secret behind them. */
  function seedConnected(id: string, origin: string) {
    saveCredentials(id, {
      origin,
      tokens: { access_token: 'live-at', token_type: 'Bearer', refresh_token: 'live-rt' },
      client: { client_id: 'client-123', client_secret: 'the-secret-the-user-pasted' },
    });
  }

  it('leaves a working grant intact when the user cancels at the confirm screen', async () => {
    const server = addRemoteServer({ id: 'gmail', url: 'https://mcp.example.com/v1' });
    seedConnected('gmail', 'https://mcp.example.com');

    const pending = await startRemoteConnect(server, {
      // No network: the probe and the listener are both injected.
      probeRequiresAuth: () => Promise.resolve(true),
      awaitCallback: () => ({
        result: new Promise<never>(() => undefined), // never resolves
        ready: Promise.resolve(),
        cancel: () => undefined,
      }),
      openBrowser: () => undefined,
      fetchImpl: fakeOAuthDiscovery,
    });
    // The user reads the destination and does not recognize it.
    pending.cancel();

    // Everything that would otherwise have to be re-obtained is still here. The
    // earlier version deleted the whole record at the top of startRemoteConnect,
    // so cancelling cost the user their client secret as well as their sign-in.
    expect(hasRemoteTokens('gmail')).toBe(true);
    const rec = loadCredentials('gmail');
    expect(rec?.tokens?.refresh_token).toBe('live-rt');
    expect(rec?.client?.client_secret).toBe('the-secret-the-user-pasted');
    // Only this attempt's PKCE verifier is gone.
    expect(rec?.codeVerifier).toBeUndefined();
  });

  it('still forces a fresh authorization rather than reporting success from the old token', async () => {
    const server = addRemoteServer({ id: 'gmail', url: 'https://mcp.example.com/v1' });
    seedConnected('gmail', 'https://mcp.example.com');
    // Hiding the stored token (rather than deleting it) has to actually work,
    // or "Sign in again" would silently do nothing and report success.
    const pending = await startRemoteConnect(server, {
      probeRequiresAuth: () => Promise.resolve(true),
      awaitCallback: () => ({ result: new Promise<never>(() => undefined), ready: Promise.resolve(), cancel: () => undefined }),
      openBrowser: () => undefined,
      fetchImpl: fakeOAuthDiscovery,
    });
    expect(pending.authorizationUrl.toString()).not.toBe('https://mcp.example.com/');
    pending.cancel();
  });
});

describe('CSRF state and callback readiness (adversarial review 2026-07-27, findings 2 and 3)', () => {
  it('state() is crypto-random, fresh per call, and remembered on the provider', () => {
    const p = new KeychainOAuthProvider({ serverId: 'x', origin: 'https://mcp.example.com' });
    const a = p.state();
    expect(p.issuedState).toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(p.state()).not.toBe(a);
  });

  it('puts the issued state in the authorization URL and hands the SAME value to the listener', async () => {
    // The finding: no state() meant the SDK omitted the parameter, the caller
    // read null from the URL, and the callback's mismatch guard was dead code.
    // The URL builder and the callback verifier must share one issued value.
    const server = addRemoteServer({
      id: 'gmail',
      url: 'https://mcp.example.com/v1',
      clientId: 'client-123',
    });
    const expectedStates: Array<string | null> = [];
    let rejectResult: ((e: Error) => void) | null = null;
    const pending = await startRemoteConnect(server, {
      probeRequiresAuth: () => Promise.resolve(true),
      awaitCallback: (expectedState) => {
        expectedStates.push(expectedState);
        return {
          result: new Promise<never>((_, rej) => {
            rejectResult = rej;
          }),
          ready: Promise.resolve(),
          cancel: () => rejectResult?.(new Error('cancelled by test')),
        };
      },
      openBrowser: () => undefined,
      fetchImpl: fakeOAuthDiscovery,
    });
    const urlState = pending.authorizationUrl.searchParams.get('state');
    expect(urlState).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const proceeding = pending.proceed();
    expect(expectedStates).toEqual([urlState]);
    pending.cancel();
    await expect(proceeding).rejects.toThrow(/cancelled by test/);
  });

  it('does not open a browser when the callback port cannot be bound', async () => {
    // Finding 3: listen() returns before EADDRINUSE arrives, so the old flow
    // opened the browser over a port owned by another process, which would
    // then receive the user's real sign-in code. Readiness must fail first.
    const server = addRemoteServer({
      id: 'gmail',
      url: 'https://mcp.example.com/v1',
      clientId: 'client-123',
    });
    let opened = 0;
    const pending = await startRemoteConnect(server, {
      probeRequiresAuth: () => Promise.resolve(true),
      awaitCallback: () => ({
        result: new Promise<never>(() => undefined),
        ready: Promise.reject(new Error('Port 8788 is already in use, so NorthKeep cannot receive the sign-in.')),
        cancel: () => undefined,
      }),
      openBrowser: () => {
        opened += 1;
      },
      fetchImpl: fakeOAuthDiscovery,
    });
    await expect(pending.proceed()).rejects.toThrow(/already in use/);
    expect(opened).toBe(0);
  });
});

describe('SDK error recovery must not destroy the grant a re-sign-in is replacing (finding 4)', () => {
  /** The record a connected server has, plus this attempt's PKCE verifier. */
  const seed = (): void =>
    saveCredentials('gmail', {
      origin: 'https://mcp.example.com',
      tokens: { access_token: 'live-at', token_type: 'Bearer', refresh_token: 'live-rt' },
      client: { client_id: 'client-123', client_secret: 'the-secret-the-user-pasted' },
      codeVerifier: 'this-attempt-verifier',
    });

  it('preserves the stored tokens and client under ignoreStoredTokens, for every scope', () => {
    // The SDK's auth() calls invalidateCredentials('all' | 'tokens') on
    // InvalidClient/UnauthorizedClient/InvalidGrant from the NEW attempt.
    // While the stored record is the PREVIOUS grant, none of those may touch
    // it; only the attempt's own verifier is clearable.
    seed();
    const p = new KeychainOAuthProvider({
      serverId: 'gmail',
      origin: 'https://mcp.example.com',
      ignoreStoredTokens: true,
    });
    p.invalidateCredentials('tokens');
    p.invalidateCredentials('client');
    p.invalidateCredentials('all');
    const rec = loadCredentials('gmail');
    expect(rec?.tokens?.refresh_token).toBe('live-rt');
    expect(rec?.client?.client_secret).toBe('the-secret-the-user-pasted');
    expect(rec?.codeVerifier).toBeUndefined();
  });

  it('still invalidates normally when no re-sign-in is in flight', () => {
    // An expired refresh token during ordinary use must keep clearing, or the
    // next attempt would present dead credentials forever.
    seed();
    const p = new KeychainOAuthProvider({ serverId: 'gmail', origin: 'https://mcp.example.com' });
    p.invalidateCredentials('tokens');
    let rec = loadCredentials('gmail');
    expect(rec?.tokens).toBeUndefined();
    expect(rec?.client?.client_secret).toBe('the-secret-the-user-pasted');
    p.invalidateCredentials('all');
    rec = loadCredentials('gmail');
    expect(rec?.client).toBeUndefined();
    expect(rec?.codeVerifier).toBeUndefined();
  });
});

describe('a remote call names its ORIGIN, not just the label (audit 2026-07-25)', () => {
  it('carries the origin into the approval prompt and the proof, and omits it for stdio', async () => {
    // The audit found ADR 0035 claiming "every call names the host in the
    // approval prompt" while both surfaces showed only the user-chosen label.
    // A label is not an identity, and "gmail" says nothing about where the mail
    // is going, so this pins the origin at both places it has to appear.
    addRemoteServer({ id: 'gmail', url: 'https://mcp.example.com/v1' });
    const cmd = path.join(home, 'server.js');
    fs.writeFileSync(cmd, '// fake\n');
    addServer({ id: 'vault', command: cmd, args: [] });

    const seen: Array<{ server?: string; serverOrigin?: string }> = [];
    const runOne = async (serverId: string) => {
      const executed: string[] = [];
      const script: ChatTurnResult[] = [
        { text: '', toolCalls: [{ id: 'c1', name: `${serverId}__search`, arguments: '{"q":"x"}' }], stopReason: 'tool_use' },
        { text: 'done', toolCalls: [], stopReason: 'end' },
      ];
      const provider: ModelProvider = {
        kind: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        chat: (m, o) => provider.chatTurn(m, o).then((r) => r.text),
        chatTurn: () => Promise.resolve(script.shift()!),
      };
      return runTask({
        provider,
        vault: { retrieve: () => [], list: () => [], commit: () => [] },
        session: createSession(),
        model: 'llama3.2:3b',
        message: 'search',
        redactTier: 0,
        distill: false,
        tools: [
          {
            name: `${serverId}__search`,
            serverId,
            description: 'search',
            inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
            risk: 'safe-read',
            egress: () => null,
            execute: (args) => {
              executed.push(JSON.stringify(args));
              return Promise.resolve({ content: 'r', meta: { bytes: 1, truncated: false, ok: true } });
            },
          },
        ],
        // Force the prompt rather than a grant, so the request is observable.
        gate: { evaluate: () => Promise.resolve('ask') },
        hooks: {
          onEvent: () => undefined,
          requestApproval: (req) => {
            seen.push({ ...(req.server !== undefined ? { server: req.server } : {}), ...(req.serverOrigin !== undefined ? { serverOrigin: req.serverOrigin } : {}) });
            return Promise.resolve('allow' as const);
          },
        },
        auditFn: () => undefined,
      });
    };

    const remote = await runOne('gmail');
    expect(seen[0]).toEqual({ server: 'gmail', serverOrigin: 'https://mcp.example.com' });
    expect(remote.toolCallsMade[0]?.mcpOrigin).toBe('https://mcp.example.com');

    const local = await runOne('vault');
    // A stdio server has no origin, and that ABSENCE is the statement that
    // nothing left the machine. Asserted, so nobody fills it in "for symmetry".
    expect(seen[1]).toEqual({ server: 'vault' });
    expect(local.toolCallsMade[0]?.mcpOrigin).toBeUndefined();
  });
});
