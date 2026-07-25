import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enabledTools,
  loadToolsConfig,
  saveToolsConfig,
  setToolEnabled,
  toolsConfigPath,
} from '../src/index.js';

/**
 * M10b — the tool registry (~/.northkeep/tools.json, ADR 0028). Config
 * enables tools, never the model; anything unreadable fails CLOSED to
 * everything-disabled; the file idiom matches routing.json (0600, tolerant
 * loader, strict writer).
 */

describe('tools registry', () => {
  let home: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-tools-'));
    priorHome = process.env.NORTHKEEP_HOME;
    process.env.NORTHKEEP_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
    else process.env.NORTHKEEP_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('defaults to everything DISABLED when no config exists', () => {
    expect(loadToolsConfig()).toEqual({
      version: 1,
      tools: { web_fetch: { enabled: false }, web_search: { enabled: false } },
    });
    expect(enabledTools()).toEqual([]);
  });

  it('enable/disable round-trips through the file, 0600', () => {
    setToolEnabled('web_fetch', true);
    expect(loadToolsConfig().tools['web_fetch']!.enabled).toBe(true);
    const tools = enabledTools();
    expect(tools.map((t) => t.name)).toEqual(['web_fetch']);
    const mode = fs.statSync(toolsConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);

    setToolEnabled('web_fetch', false);
    expect(enabledTools()).toEqual([]);
  });

  it('refuses to enable an unknown tool, loudly', () => {
    expect(() => setToolEnabled('shell_exec', true)).toThrow(/Unknown tool/);
  });

  it('fails CLOSED on unreadable/invalid config (garbage → disabled)', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(toolsConfigPath(), 'not json at all {{{');
    expect(loadToolsConfig().tools['web_fetch']!.enabled).toBe(false);
    fs.writeFileSync(toolsConfigPath(), JSON.stringify({ tools: { web_fetch: { enabled: 'yes' } } }));
    expect(loadToolsConfig().tools['web_fetch']!.enabled).toBe(false); // non-boolean ignored
  });

  it('ignores unknown keys and unknown tools on read (tolerant loader)', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      toolsConfigPath(),
      JSON.stringify({
        version: 1,
        future_field: { x: 1 },
        tools: { web_fetch: { enabled: true }, shell_exec: { enabled: true } },
        webFetch: { maxBytes: 1024, timeoutMs: 5000, junk: 'ignored' },
      }),
    );
    const config = loadToolsConfig();
    expect(config.tools['web_fetch']!.enabled).toBe(true);
    expect(config.tools['shell_exec']).toBeUndefined(); // unknown tool never constructed
    expect(config.webFetch).toEqual({ maxBytes: 1024, timeoutMs: 5000 });
    expect(enabledTools().map((t) => t.name)).toEqual(['web_fetch']);
  });

  it('rejects nonsensical webFetch numbers on read', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      toolsConfigPath(),
      JSON.stringify({ version: 1, tools: {}, webFetch: { maxBytes: -5, timeoutMs: 'fast' } }),
    );
    expect(loadToolsConfig().webFetch).toBeUndefined();
  });

  it('saveToolsConfig writes what loadToolsConfig reads back', () => {
    saveToolsConfig({ version: 1, tools: { web_fetch: { enabled: true } }, webFetch: { maxBytes: 2048 } });
    expect(loadToolsConfig()).toEqual({
      version: 1,
      // web_search falls back to its disabled default (the loader overlays the
      // file onto DEFAULTS, so a tool absent from the file stays disabled).
      tools: { web_fetch: { enabled: true }, web_search: { enabled: false } },
      webFetch: { maxBytes: 2048 },
    });
  });
});
