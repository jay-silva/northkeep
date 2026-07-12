import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeCodeAvailable,
  claudeCodeStatus,
  claudeDesktopStatus,
  connectClaudeDesktop,
  disconnectClaudeDesktop,
  mcpEntryLooksValid,
  resolveMcpCommand,
} from '../src/connect.js';

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-connect-'));
  configPath = path.join(dir, 'nested', 'claude_desktop_config.json');
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
