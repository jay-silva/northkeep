import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * M8 acceptance — one-click Connect (ADR 0013) — driven through the real CLI
 * against a TEMP Claude Desktop config (NORTHKEEP_CLAUDE_DESKTOP_CONFIG), so a
 * full end-to-end round-trip never touches the user's real config. Proves the
 * crown-jewel merge safety end-to-end:
 *  - connect writes ONLY mcpServers.northkeep, preserving every other key;
 *  - a scope preset becomes env.NORTHKEEP_SCOPES;
 *  - a backup of the pristine original is made;
 *  - disconnect removes only our entry;
 *  - an unparseable config is refused and left byte-for-byte intact.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

let home: string;
let cfg: string; // the temp Claude Desktop config

function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          NORTHKEEP_HOME: home,
          NORTHKEEP_NO_KEYCHAIN: '1',
          // The whole point: Connect edits THIS file, never the real one.
          NORTHKEEP_CLAUDE_DESKTOP_CONFIG: cfg,
        },
        encoding: 'utf8',
      },
      (err, stdout, stderr) =>
        resolve({ stdout, stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 }),
    );
  });
}

const readCfg = (): Record<string, unknown> => JSON.parse(fs.readFileSync(cfg, 'utf8'));

beforeAll(() => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-m8-'));
  cfg = path.join(home, 'claude_desktop_config.json');
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('M8 acceptance — one-click Connect', () => {
  it('connect preserves every unrelated key and adds only mcpServers.northkeep', async () => {
    // A realistic pre-existing config: unrelated top-level keys + another MCP server.
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        preferences: { dictationShortcut: 'capslock', trustedFolders: ['/tmp'] },
        mcpServers: { other: { command: 'othercmd', args: ['x'] } },
      }),
    );

    const r = await cli(['connect', 'claude-desktop', '--scope', 'personal']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/[Rr]estart Claude Desktop/);
    // Honesty note (ADR Decision 4) surfaced by the CLI.
    expect(r.stdout + r.stderr).toMatch(/redact what you type/i);

    const c = readCfg() as {
      preferences: unknown;
      mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    };
    // Every unrelated key survives, byte-faithfully.
    expect(c.preferences).toEqual({ dictationShortcut: 'capslock', trustedFolders: ['/tmp'] });
    expect(c.mcpServers.other).toEqual({ command: 'othercmd', args: ['x'] });
    // Our entry is present, points at a real command, and carries the scope.
    expect(c.mcpServers.northkeep).toBeDefined();
    expect(typeof c.mcpServers.northkeep.command).toBe('string');
    expect(c.mcpServers.northkeep.args[0]).toMatch(/mcp-server\/dist\/index\.js$/);
    expect(c.mcpServers.northkeep.env?.NORTHKEEP_SCOPES).toBe('personal');
  });

  it('backs up the pristine original before the first write', async () => {
    const bak = `${cfg}.northkeep-bak`;
    expect(fs.existsSync(bak)).toBe(true);
    const backed = JSON.parse(fs.readFileSync(bak, 'utf8')) as { mcpServers: Record<string, unknown> };
    // The backup is the PRE-NorthKeep config — no northkeep entry.
    expect(backed.mcpServers.northkeep).toBeUndefined();
    expect(backed.mcpServers.other).toBeDefined();
  });

  it('status reports connected with the scope', async () => {
    const r = await cli(['connect', 'status']);
    expect(r.stdout).toMatch(/Claude Desktop:\s*connected/i);
    expect(r.stdout).toMatch(/personal/);
  });

  it('disconnect removes only our entry, leaving the others intact', async () => {
    const r = await cli(['disconnect', 'claude-desktop']);
    expect(r.code).toBe(0);
    const c = readCfg() as { preferences: unknown; mcpServers: Record<string, unknown> };
    expect(c.mcpServers.northkeep).toBeUndefined(); // ours gone
    expect(c.mcpServers.other).toBeDefined(); // sibling untouched
    expect(c.preferences).toEqual({ dictationShortcut: 'capslock', trustedFolders: ['/tmp'] });
  });

  it('refuses an unparseable config and leaves it byte-for-byte intact', async () => {
    const garbage = '{ this is : not json ]]';
    fs.writeFileSync(cfg, garbage);
    const r = await cli(['connect', 'claude-desktop']);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/not.*valid JSON|cannot parse|Refusing/i);
    expect(fs.readFileSync(cfg, 'utf8')).toBe(garbage); // untouched
  });
});
