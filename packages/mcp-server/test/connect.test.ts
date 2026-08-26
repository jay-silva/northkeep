import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
  chatgptStatus,
  claudeCodeAvailable,
  claudeCodeStatus,
  claudeDesktopStatus,
  connectChatgpt,
  connectClaudeDesktop,
  connectCursor,
  cursorConfigPath,
  cursorStatus,
  disconnectChatgpt,
  disconnectClaudeDesktop,
  disconnectCursor,
  mcpEntryLooksValid,
  resolveMcpCommand,
} from '../src/connect.js';

let dir: string;
let configPath: string;
let codexPath: string;
let cursorPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-connect-'));
  configPath = path.join(dir, 'nested', 'claude_desktop_config.json');
  codexPath = path.join(dir, 'nested', '.codex', 'config.toml');
  cursorPath = path.join(dir, 'nested', 'cursor_mcp.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function read(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

describe('resolveMcpCommand', () => {
  it('uses the running binary and the sibling index.js of this module', () => {
    const { command, args } = resolveMcpCommand();
    expect(command).toBe(process.execPath);
    expect(args).toHaveLength(1);
    // In this test the module lives in mcp-server/src, but the shipped code
    // lives in mcp-server/dist — assert the resolver targets index.js beside it.
    expect(path.basename(args[0]!)).toBe('index.js');
  });

  it('mcpEntryLooksValid matches the self-start guard suffix', () => {
    expect(mcpEntryLooksValid('/Applications/NorthKeep.app/.../@northkeep/mcp-server/dist/index.js')).toBe(true);
    expect(mcpEntryLooksValid('/repo/packages/mcp-server/dist/index.js')).toBe(true);
    expect(mcpEntryLooksValid('/somewhere/else/index.js')).toBe(false);
  });
});

describe('Claude Desktop config merge (ADR 0013 Decision 2)', () => {
  it('(a) creates a config with ONLY our entry when none exists', () => {
    expect(fs.existsSync(configPath)).toBe(false);
    const result = connectClaudeDesktop({}, configPath);
    expect(result.restartNeeded).toBe(true);

    const config = read();
    expect(Object.keys(config)).toEqual(['mcpServers']);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(['northkeep']);
    expect(servers.northkeep).toMatchObject({ command: result.command, args: result.args });
    // Pretty-printed with a trailing newline.
    expect(fs.readFileSync(configPath, 'utf8').endsWith('\n')).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('\n  ');
    // Nothing to back up when the file didn't exist.
    expect(fs.existsSync(`${configPath}.northkeep-bak`)).toBe(false);
  });

  it('(b) preserves ALL unrelated keys and sibling servers', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        preferences: { x: 1 },
        globalShortcut: 'Cmd+Space',
        mcpServers: { other: { command: '/usr/bin/other', args: ['--go'] } },
      }),
    );

    connectClaudeDesktop({}, configPath);

    const config = read();
    expect(config.preferences).toEqual({ x: 1 });
    expect(config.globalShortcut).toBe('Cmd+Space');
    const servers = config.mcpServers as Record<string, unknown>;
    // The unrelated server is untouched and ours sits alongside it.
    expect(servers.other).toEqual({ command: '/usr/bin/other', args: ['--go'] });
    expect(servers.northkeep).toBeDefined();
  });

  it('(c) backs up the original config before the first write', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const original = JSON.stringify({ preferences: { x: 1 } });
    fs.writeFileSync(configPath, original);

    connectClaudeDesktop({}, configPath);

    const bak = `${configPath}.northkeep-bak`;
    expect(fs.existsSync(bak)).toBe(true);
    // The backup is the PRISTINE pre-NorthKeep config, byte-for-byte.
    expect(fs.readFileSync(bak, 'utf8')).toBe(original);

    // A second write does not overwrite the pristine backup.
    connectClaudeDesktop({ scopes: ['work'] }, configPath);
    expect(fs.readFileSync(bak, 'utf8')).toBe(original);
  });

  it('(d) refuses an unparseable config and leaves it byte-for-byte unchanged', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const garbage = '{ this is not: json, ';
    fs.writeFileSync(configPath, garbage);

    expect(() => connectClaudeDesktop({}, configPath)).toThrow(/not a valid JSON|cannot parse|Refusing/i);
    // Untouched — and no backup, no write happened.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(garbage);
    expect(fs.existsSync(`${configPath}.northkeep-bak`)).toBe(false);
  });

  it('(e) scopes produce env.NORTHKEEP_SCOPES', () => {
    connectClaudeDesktop({ scopes: ['personal', 'work'] }, configPath);
    const servers = read().mcpServers as Record<string, any>;
    expect(servers.northkeep.env).toEqual({ NORTHKEEP_SCOPES: 'personal,work' });
  });

  it('(e2) no scopes ⇒ no env key at all (full owner access)', () => {
    connectClaudeDesktop({}, configPath);
    const servers = read().mcpServers as Record<string, any>;
    expect(servers.northkeep.env).toBeUndefined();
  });

  it('(f) disconnect removes ONLY our entry, leaving others intact', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        preferences: { x: 1 },
        mcpServers: { other: { command: '/usr/bin/other' } },
      }),
    );
    connectClaudeDesktop({ scopes: ['work'] }, configPath);

    const result = disconnectClaudeDesktop(configPath);
    expect(result.removed).toBe(true);

    const config = read();
    expect(config.preferences).toEqual({ x: 1 });
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers.other).toEqual({ command: '/usr/bin/other' });
    expect('northkeep' in servers).toBe(false);
  });

  it('(f2) disconnect on an absent/never-connected config is a no-op', () => {
    expect(disconnectClaudeDesktop(configPath).removed).toBe(false);

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ preferences: { x: 1 } }));
    expect(disconnectClaudeDesktop(configPath).removed).toBe(false);
    // Untouched.
    expect(read()).toEqual({ preferences: { x: 1 } });
  });

  it('(f3) disconnect refuses an unparseable config rather than clobbering it', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const garbage = '{ broken';
    fs.writeFileSync(configPath, garbage);
    expect(() => disconnectClaudeDesktop(configPath)).toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(garbage);
  });

  it('(g) status reflects connected + scopes', () => {
    expect(claudeDesktopStatus(configPath)).toEqual({ connected: false });

    connectClaudeDesktop({ scopes: ['personal'] }, configPath);
    expect(claudeDesktopStatus(configPath)).toEqual({ connected: true, scopes: ['personal'] });

    disconnectClaudeDesktop(configPath);
    expect(claudeDesktopStatus(configPath)).toEqual({ connected: false });

    connectClaudeDesktop({}, configPath);
    expect(claudeDesktopStatus(configPath)).toEqual({ connected: true });
  });
});

describe('Claude Code (gated on the real CLI; never mutates real user config)', () => {
  const hasClaude = claudeCodeAvailable();

  it('claudeCodeAvailable agrees with `which claude`', () => {
    let whichSaysYes = true;
    try {
      execFileSync('which', ['claude'], { stdio: 'ignore' });
    } catch {
      whichSaysYes = false;
    }
    expect(claudeCodeAvailable()).toBe(whichSaysYes);
  });

  it.runIf(hasClaude)('status returns a boolean without throwing', () => {
    const status = claudeCodeStatus();
    expect(typeof status.connected).toBe('boolean');
  });

  it.skipIf(hasClaude)('status is not-connected when the CLI is absent', () => {
    expect(claudeCodeStatus()).toEqual({ connected: false });
  });
});

describe('ChatGPT / Codex config.toml merge (ADR 0021)', () => {
  function readCodex(): string {
    return fs.readFileSync(codexPath, 'utf8');
  }
  function nkEntry(): Record<string, unknown> {
    const parsed = parseToml(readCodex()) as Record<string, unknown>;
    return (parsed.mcp_servers as Record<string, Record<string, unknown>>).northkeep;
  }

  it('creates a config with ONLY our table when none exists', () => {
    expect(fs.existsSync(codexPath)).toBe(false);
    const result = connectChatgpt({}, codexPath);
    expect(result.restartNeeded).toBe(true);

    const entry = nkEntry();
    expect(entry.command).toBe(result.command);
    expect(entry.args).toEqual(result.args);
    expect(entry.env).toBeUndefined(); // no scopes => no env => full access
    // Only our server exists.
    const parsed = parseToml(readCodex()) as Record<string, unknown>;
    expect(Object.keys(parsed.mcp_servers as object)).toEqual(['northkeep']);
  });

  it('writes NORTHKEEP_SCOPES into the .env subtable when scopes are given', () => {
    connectChatgpt({ scopes: ['work', 'personal'] }, codexPath);
    const entry = nkEntry();
    expect((entry.env as Record<string, unknown>).NORTHKEEP_SCOPES).toBe('work,personal');
    expect(chatgptStatus(codexPath)).toEqual({ connected: true, scopes: ['work', 'personal'] });
  });

  it('preserves other servers, root keys, and comments byte-faithfully', () => {
    const original = [
      '# my codex config',
      'model = "gpt-5"',
      'approval_policy = "on-request"',
      '',
      '[mcp_servers.other]',
      'command = "npx"',
      'args = ["-y", "@vendor/other-mcp"]',
      '',
      '[mcp_servers.other.env]',
      'SECRET_TOKEN = "do-not-touch"  # a secret we must never drop',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(codexPath, original);

    connectChatgpt({ scopes: ['work'] }, codexPath);
    const after = readCodex();

    // Everything the user had is still present, verbatim.
    expect(after).toContain('# my codex config');
    expect(after).toContain('model = "gpt-5"');
    expect(after).toContain('[mcp_servers.other]');
    expect(after).toContain('SECRET_TOKEN = "do-not-touch"  # a secret we must never drop');
    // Both servers now parse.
    const parsed = parseToml(after) as Record<string, Record<string, unknown>>;
    expect(Object.keys(parsed.mcp_servers).sort()).toEqual(['northkeep', 'other']);
    expect((parsed.mcp_servers.other.env as Record<string, unknown>).SECRET_TOKEN).toBe('do-not-touch');
  });

  it('reconnect REPLACES our table, never duplicates it', () => {
    connectChatgpt({ scopes: ['work'] }, codexPath);
    connectChatgpt({ scopes: ['personal'] }, codexPath);
    const after = readCodex();
    // Exactly one northkeep table header.
    expect(after.match(/^\[mcp_servers\.northkeep\]$/gm)?.length).toBe(1);
    expect(chatgptStatus(codexPath)).toEqual({ connected: true, scopes: ['personal'] });
  });

  it('disconnect removes ONLY our table, leaving others intact', () => {
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(codexPath, '[mcp_servers.other]\ncommand = "x"\nargs = []\n');
    connectChatgpt({}, codexPath);
    expect(chatgptStatus(codexPath).connected).toBe(true);

    const removed = disconnectChatgpt(codexPath);
    expect(removed).toEqual({ removed: true });
    const parsed = parseToml(readCodex()) as Record<string, Record<string, unknown>>;
    expect(Object.keys(parsed.mcp_servers)).toEqual(['other']);
    // Idempotent: nothing left to remove.
    expect(disconnectChatgpt(codexPath)).toEqual({ removed: false });
  });

  it('backs up the original once before the first write', () => {
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(codexPath, 'model = "gpt-5"\n');
    connectChatgpt({}, codexPath);
    expect(fs.existsSync(codexPath + '.northkeep-bak')).toBe(true);
    expect(fs.readFileSync(codexPath + '.northkeep-bak', 'utf8')).toBe('model = "gpt-5"\n');
  });

  it('REFUSES an unparseable config (connect and disconnect both throw)', () => {
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(codexPath, 'this = = not valid toml [[[');
    expect(() => connectChatgpt({}, codexPath)).toThrow(/Refusing to modify/);
    expect(() => disconnectChatgpt(codexPath)).toThrow(/Refusing to modify/);
    // The bad file was left untouched.
    expect(fs.readFileSync(codexPath, 'utf8')).toBe('this = = not valid toml [[[');
  });

  it('REFUSES an inline-form northkeep entry rather than mangling it', () => {
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    // northkeep declared as an inline table under [mcp_servers] — a form we do
    // not rewrite. We must refuse, not silently duplicate or corrupt it.
    fs.writeFileSync(codexPath, '[mcp_servers]\nnorthkeep = { command = "old", args = [] }\n');
    expect(() => connectChatgpt({}, codexPath)).toThrow(/inline or dotted-key form/);
  });

  it('REFUSES rather than destroy a quoted-dotted sibling server (e.g. "northkeep.backup") and its secret', () => {
    const original = [
      '[mcp_servers.northkeep]',
      'command = "old"',
      'args = []',
      '',
      '[mcp_servers."northkeep.backup"]',
      'command = "python"',
      '',
      '[mcp_servers."northkeep.backup".env]',
      'API_KEY = "SUPER_SECRET_XYZ"',
      '',
      '[mcp_servers.other]',
      'token = "OTHER_SECRET"',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(codexPath, original);

    // Connect and disconnect must both refuse — never silently delete the sibling.
    expect(() => connectChatgpt({}, codexPath)).toThrow(/another\s+MCP server/i);
    expect(() => disconnectChatgpt(codexPath)).toThrow(/another\s+MCP server/i);
    // The file (and the sibling's secret) is untouched.
    expect(fs.readFileSync(codexPath, 'utf8')).toBe(original);
  });

  it('status is not-connected for a missing or northkeep-free config', () => {
    expect(chatgptStatus(codexPath)).toEqual({ connected: false });
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(codexPath, 'model = "gpt-5"\n');
    expect(chatgptStatus(codexPath)).toEqual({ connected: false });
  });
});

function readCursor(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
}

describe('Cursor config merge (ADR 0041)', () => {
  it('(a) creates a config with ONLY our entry (type: stdio) when none exists', () => {
    expect(fs.existsSync(cursorPath)).toBe(false);
    const result = connectCursor({}, cursorPath);
    expect(result.restartNeeded).toBe(true);

    const config = readCursor();
    expect(Object.keys(config)).toEqual(['mcpServers']);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(['northkeep']);
    expect(servers.northkeep).toMatchObject({
      type: 'stdio',
      command: result.command,
      args: result.args,
    });
    expect(fs.readFileSync(cursorPath, 'utf8').endsWith('\n')).toBe(true);
    expect(fs.existsSync(`${cursorPath}.northkeep-bak`)).toBe(false);
  });

  it('(b) preserves unrelated keys, sibling servers, a remote url+headers sibling, and ${env:...} strings', () => {
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(
      cursorPath,
      JSON.stringify({
        preferences: { x: 1 },
        mcpServers: {
          other: { command: '/usr/bin/other', args: ['--go'] },
          hosted: {
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer ${env:HOSTED_TOKEN}' },
          },
        },
      }),
    );

    connectCursor({}, cursorPath);

    const config = readCursor();
    expect(config.preferences).toEqual({ x: 1 });
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers.other).toEqual({ command: '/usr/bin/other', args: ['--go'] });
    expect(servers.hosted).toEqual({
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${env:HOSTED_TOKEN}' },
    });
    expect(servers.northkeep).toBeDefined();
  });

  it('(c) backs up the original config before the first write', () => {
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    const original = JSON.stringify({ preferences: { x: 1 } });
    fs.writeFileSync(cursorPath, original);

    connectCursor({}, cursorPath);

    const bak = `${cursorPath}.northkeep-bak`;
    expect(fs.existsSync(bak)).toBe(true);
    expect(fs.readFileSync(bak, 'utf8')).toBe(original);

    connectCursor({ scopes: ['work'] }, cursorPath);
    expect(fs.readFileSync(bak, 'utf8')).toBe(original);
  });

  it('(d) refuses an unparseable config and leaves it byte-for-byte unchanged', () => {
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    const garbage = '{ this is not: json, ';
    fs.writeFileSync(cursorPath, garbage);

    expect(() => connectCursor({}, cursorPath)).toThrow(/not a valid JSON|cannot parse|Refusing/i);
    expect(fs.readFileSync(cursorPath, 'utf8')).toBe(garbage);
    expect(fs.existsSync(`${cursorPath}.northkeep-bak`)).toBe(false);
  });

  it('(e) scopes produce env.NORTHKEEP_SCOPES', () => {
    connectCursor({ scopes: ['personal', 'work'] }, cursorPath);
    const servers = readCursor().mcpServers as Record<string, { env?: { NORTHKEEP_SCOPES?: string } }>;
    expect(servers.northkeep.env).toEqual({ NORTHKEEP_SCOPES: 'personal,work' });
  });

  it('(e2) no scopes ⇒ no env key at all (full owner access)', () => {
    connectCursor({}, cursorPath);
    const servers = readCursor().mcpServers as Record<string, { env?: unknown }>;
    expect(servers.northkeep.env).toBeUndefined();
  });

  it('(f) disconnect removes ONLY our entry, leaving "mcpServers": {}', () => {
    connectCursor({ scopes: ['work'] }, cursorPath);
    const result = disconnectCursor(cursorPath);
    expect(result.removed).toBe(true);
    expect(readCursor()).toEqual({ mcpServers: {} });
  });

  it('(g) status reflects connected + scopes, and a hand-written entry without type is connected', () => {
    expect(cursorStatus(cursorPath)).toEqual({ connected: false });

    connectCursor({ scopes: ['personal'] }, cursorPath);
    expect(cursorStatus(cursorPath)).toEqual({ connected: true, scopes: ['personal'] });

    disconnectCursor(cursorPath);
    expect(cursorStatus(cursorPath)).toEqual({ connected: false });

    connectCursor({}, cursorPath);
    expect(cursorStatus(cursorPath)).toEqual({ connected: true });

    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(
      cursorPath,
      JSON.stringify({ mcpServers: { northkeep: { command: '/bin/echo', args: [] } } }),
    );
    expect(cursorStatus(cursorPath)).toEqual({ connected: true });
  });

  it('cursorConfigPath() default is absolute, under homedir, ends with /.cursor/mcp.json', () => {
    const prev = process.env.NORTHKEEP_CURSOR_CONFIG;
    delete process.env.NORTHKEEP_CURSOR_CONFIG;
    try {
      const p = cursorConfigPath();
      expect(path.isAbsolute(p)).toBe(true);
      expect(p.startsWith(os.homedir())).toBe(true);
      expect(p.endsWith('/.cursor/mcp.json')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NORTHKEEP_CURSOR_CONFIG;
      else process.env.NORTHKEEP_CURSOR_CONFIG = prev;
    }
  });
});

describe('P1 mcpServersOrThrow (Claude Desktop and Cursor)', () => {
  const writers: Array<{
    name: string;
    file: () => string;
    connect: (p: string) => void;
    disconnect: (p: string) => { removed: boolean };
    status: (p: string) => { connected: boolean };
  }> = [
    {
      name: 'connectClaudeDesktop',
      file: () => configPath,
      connect: (p) => connectClaudeDesktop({}, p),
      disconnect: (p) => disconnectClaudeDesktop(p),
      status: (p) => claudeDesktopStatus(p),
    },
    {
      name: 'connectCursor',
      file: () => cursorPath,
      connect: (p) => connectCursor({}, p),
      disconnect: (p) => disconnectCursor(p),
      status: (p) => cursorStatus(p),
    },
  ];

  for (const w of writers) {
    describe(w.name, () => {
      it('refuses array mcpServers, leaves file byte-identical, no backup', () => {
        const file = w.file();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const original = '{"mcpServers": [{"command": "x", "env": {"SECRET": "do-not-touch"}}]}';
        fs.writeFileSync(file, original);

        expect(() => w.connect(file)).toThrow(/mcpServers.*not a JSON object/i);
        expect(fs.readFileSync(file, 'utf8')).toBe(original);
        expect(fs.existsSync(`${file}.northkeep-bak`)).toBe(false);
      });

      it('refuses string mcpServers, leaves file untouched', () => {
        const file = w.file();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const original = '{"mcpServers": "oops"}';
        fs.writeFileSync(file, original);

        expect(() => w.connect(file)).toThrow(/mcpServers.*not a JSON object/i);
        expect(fs.readFileSync(file, 'utf8')).toBe(original);
        expect(fs.existsSync(`${file}.northkeep-bak`)).toBe(false);
      });

      it('status on a non-object mcpServers is { connected: false } without throwing', () => {
        const file = w.file();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{"mcpServers": [{"command": "x", "env": {"SECRET": "do-not-touch"}}]}');
        expect(w.status(file)).toEqual({ connected: false });
      });

      it('disconnect on a non-object mcpServers is { removed: false } without writing', () => {
        const file = w.file();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const original = '{"mcpServers": "oops"}';
        fs.writeFileSync(file, original);
        expect(w.disconnect(file)).toEqual({ removed: false });
        expect(fs.readFileSync(file, 'utf8')).toBe(original);
        expect(fs.existsSync(`${file}.northkeep-bak`)).toBe(false);
      });
    });
  }
});

describe('P2 Cursor remote hijack guard', () => {
  const remote = {
    mcpServers: { northkeep: { url: 'https://northkeep-connector-server.vercel.app/mcp' } },
  };

  it('refuses to overwrite a remote url-entry; file unchanged, no backup', () => {
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    const original = JSON.stringify(remote);
    fs.writeFileSync(cursorPath, original);

    expect(() => connectCursor({}, cursorPath)).toThrow(/remote MCP server|has a "url"/i);
    expect(fs.readFileSync(cursorPath, 'utf8')).toBe(original);
    expect(fs.existsSync(`${cursorPath}.northkeep-bak`)).toBe(false);
  });

  it('replaces an existing stdio northkeep entry; siblings survive', () => {
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(
      cursorPath,
      JSON.stringify({
        mcpServers: {
          northkeep: { command: '/old', args: ['a'] },
          sibling: { command: '/other' },
        },
      }),
    );

    const result = connectCursor({}, cursorPath);
    const servers = readCursor().mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.northkeep.command).toBe(result.command);
    expect(servers.northkeep.args).toEqual(result.args);
    expect(servers.northkeep.type).toBe('stdio');
    expect(servers.sibling).toEqual({ command: '/other' });
  });

  it('disconnectCursor removes a url-entry', () => {
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(cursorPath, JSON.stringify(remote));
    expect(disconnectCursor(cursorPath)).toEqual({ removed: true });
    expect(readCursor().mcpServers).toEqual({});
  });
});

describe('P3 BOM strip in shared readConfig', () => {
  it('connect succeeds with a leading BOM; rewrite has no BOM; backup keeps original bytes', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const original = `\uFEFF${JSON.stringify({ preferences: { x: 1 } })}`;
    fs.writeFileSync(configPath, original);

    connectClaudeDesktop({}, configPath);

    const rewritten = fs.readFileSync(configPath, 'utf8');
    expect(rewritten.startsWith('\uFEFF')).toBe(false);
    expect(JSON.parse(rewritten).preferences).toEqual({ x: 1 });
    expect(JSON.parse(rewritten).mcpServers).toBeDefined();

    const bak = fs.readFileSync(`${configPath}.northkeep-bak`);
    expect(bak).toEqual(Buffer.from(original, 'utf8'));
  });

  it('BOM + garbage still refuses', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const garbage = `\uFEFF{ this is not: json`;
    fs.writeFileSync(configPath, garbage);
    expect(() => connectClaudeDesktop({}, configPath)).toThrow(/Refusing/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(garbage);
    expect(fs.existsSync(`${configPath}.northkeep-bak`)).toBe(false);
  });
});

describe('P4 symlink-preserving atomic write', () => {
  it('connect via a symlink writes the target and leaves the symlink in place; mode preserved', () => {
    const sibling = path.join(dir, 'elsewhere');
    fs.mkdirSync(sibling, { recursive: true });
    const real = path.join(sibling, 'real.json');
    const link = path.join(dir, 'mcp.json');
    fs.writeFileSync(real, JSON.stringify({ preferences: { x: 1 }, mcpServers: {} }));
    fs.chmodSync(real, 0o640);
    fs.symlinkSync(real, link);

    connectCursor({}, link);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const written = JSON.parse(fs.readFileSync(real, 'utf8')) as {
      preferences: unknown;
      mcpServers: Record<string, unknown>;
    };
    expect(written.preferences).toEqual({ x: 1 });
    expect(written.mcpServers.northkeep).toBeDefined();
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
  });

  it('disconnect through a symlink: still a symlink, entry gone from the target', () => {
    const sibling = path.join(dir, 'elsewhere');
    fs.mkdirSync(sibling, { recursive: true });
    const real = path.join(sibling, 'real.json');
    const link = path.join(dir, 'mcp.json');
    fs.writeFileSync(real, JSON.stringify({ preferences: { x: 1 }, mcpServers: {} }));
    fs.symlinkSync(real, link);

    connectCursor({}, link);
    expect(disconnectCursor(link)).toEqual({ removed: true });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const after = JSON.parse(fs.readFileSync(real, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect('northkeep' in after.mcpServers).toBe(false);
  });

  it('new file is still 0600', () => {
    const fresh = path.join(dir, 'new.json');
    connectCursor({}, fresh);
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o600);
  });
});
