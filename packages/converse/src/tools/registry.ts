import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';
import type { ToolDefinition } from './types.js';
import { createWebFetchTool } from './webFetch.js';
import { createWebSearchTool } from './webSearch.js';
import { getEndpointKey } from '../settings.js';

/**
 * web_search's Brave subscription token is stored under this pseudo-endpoint id
 * in the same Keychain/env store as model API keys (settings.ts), so it never
 * touches a file. Set it with `northkeep tools brave-key`.
 */
export const BRAVE_KEY_ID = 'brave-search';

/** The Brave key, or null when unset (web_search then stays unavailable). */
export function getBraveKey(): string | null {
  return getEndpointKey(BRAVE_KEY_ID);
}

/**
 * The tool registry (M10b, ADR 0028): ~/.northkeep/tools.json decides which
 * tools EXIST for the agent loop. The config enables tools — never the
 * model, never a request parameter — and everything ships DISABLED until the
 * user runs `northkeep tools enable <name>`. Same file idiom as routing.json
 * (route.ts): 0600, tolerant loader (invalid/missing → safe defaults, which
 * here means everything off — fail closed), strict writer.
 */

export interface ToolsConfig {
  version: 1;
  tools: Record<string, { enabled: boolean }>;
  webFetch?: { maxBytes?: number; timeoutMs?: number };
}

/** The tools this build knows how to construct (M10d adds web_search). */
export const KNOWN_TOOL_NAMES = ['web_fetch', 'web_search'] as const;

export function toolsConfigPath(): string {
  return path.join(northkeepHome(), 'tools.json');
}

const DEFAULTS: ToolsConfig = {
  version: 1,
  tools: { web_fetch: { enabled: false }, web_search: { enabled: false } },
};

export function loadToolsConfig(): ToolsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(toolsConfigPath(), 'utf8')) as unknown;
  } catch {
    return structuredClone(DEFAULTS);
  }
  if (parsed === null || typeof parsed !== 'object') return structuredClone(DEFAULTS);
  const raw = parsed as Record<string, unknown>;
  const config = structuredClone(DEFAULTS);
  // Tolerant read: only shapes we recognize are honored; unknown keys are
  // ignored; anything malformed leaves the fail-closed default (disabled).
  if (raw.tools !== null && typeof raw.tools === 'object') {
    for (const name of KNOWN_TOOL_NAMES) {
      const entry = (raw.tools as Record<string, unknown>)[name];
      if (
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { enabled?: unknown }).enabled === 'boolean'
      ) {
        config.tools[name] = { enabled: (entry as { enabled: boolean }).enabled };
      }
    }
  }
  if (raw.webFetch !== null && typeof raw.webFetch === 'object') {
    const wf = raw.webFetch as Record<string, unknown>;
    const out: { maxBytes?: number; timeoutMs?: number } = {};
    if (typeof wf.maxBytes === 'number' && Number.isFinite(wf.maxBytes) && wf.maxBytes > 0) {
      out.maxBytes = wf.maxBytes;
    }
    if (typeof wf.timeoutMs === 'number' && Number.isFinite(wf.timeoutMs) && wf.timeoutMs > 0) {
      out.timeoutMs = wf.timeoutMs;
    }
    if (Object.keys(out).length > 0) config.webFetch = out;
  }
  return config;
}

export function saveToolsConfig(config: ToolsConfig): void {
  fs.mkdirSync(path.dirname(toolsConfigPath()), { recursive: true });
  fs.writeFileSync(toolsConfigPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Strict write surface (mirrors routing.ts): an unknown tool name is refused
 * loudly instead of persisting a key the tolerant loader would silently drop.
 */
export function setToolEnabled(name: string, enabled: boolean): ToolsConfig {
  if (!(KNOWN_TOOL_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown tool "${name}". Known tools: ${KNOWN_TOOL_NAMES.join(', ')}`);
  }
  const config = loadToolsConfig();
  config.tools[name] = { enabled };
  saveToolsConfig(config);
  return config;
}

/** Construct the ToolDefinitions the config enables. Config decides — only. */
export function enabledTools(): ToolDefinition[] {
  const config = loadToolsConfig();
  const tools: ToolDefinition[] = [];
  if (config.tools['web_fetch']?.enabled === true) {
    tools.push(createWebFetchTool(config.webFetch ?? {}));
  }
  // web_search needs BOTH the enable flag AND a stored Brave key. A tool the
  // model cannot actually use must not be offered — silently omitting it (vs.
  // constructing a tool that always errors) keeps the model's tool list honest.
  // The CLI (`tools enable web_search`) tells the user when the key is missing.
  if (config.tools['web_search']?.enabled === true) {
    const braveKey = getBraveKey();
    if (braveKey !== null) {
      tools.push(createWebSearchTool({ apiKey: braveKey }));
    }
  }
  return tools;
}

/** True when web_search is enabled but its Brave key is missing (CLI hint). */
export function webSearchNeedsKey(): boolean {
  return loadToolsConfig().tools['web_search']?.enabled === true && getBraveKey() === null;
}
