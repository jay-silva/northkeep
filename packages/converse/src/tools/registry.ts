import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';
import type { ToolDefinition } from './types.js';
import { createWebFetchTool } from './webFetch.js';

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

/** The tools this build knows how to construct. web_search arrives in M10d. */
export const KNOWN_TOOL_NAMES = ['web_fetch'] as const;

export function toolsConfigPath(): string {
  return path.join(northkeepHome(), 'tools.json');
}

const DEFAULTS: ToolsConfig = { version: 1, tools: { web_fetch: { enabled: false } } };

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
  return tools;
}
