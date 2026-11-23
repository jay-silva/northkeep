// Runs one headless Claude Code session, cut off from this machine's own
// settings, memory and MCP servers, and returns what it said and which tools
// it called. Other agents can be added beside this one with the same result shape.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @returns {Promise<{answer: string, tool_calls: {name: string, input: unknown}[], servers: Record<string,string>,
 *   cost_usd: number|null, error: string|null}>}
 */
export function runClaude({ prompt, systemPrompt, model, mcpConfig = null, timeoutMs = 240_000 }) {
  // An empty working directory with project-only settings: no user CLAUDE.md, hooks, plugins or memory.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bench-cwd-'));
  const args = [
    '-p', prompt,
    '--system-prompt', systemPrompt,
    '--model', model,
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--tools', '',
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (mcpConfig) args.push('--mcp-config', JSON.stringify(mcpConfig), '--allowedTools', Object.keys(mcpConfig.mcpServers).map((name) => `mcp__${name}`).join(','));

  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      const result = { answer: '', tool_calls: [], servers: {}, cost_usd: null, error: null };
      for (const line of stdout.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'system' && event.subtype === 'init') {
          for (const s of event.mcp_servers ?? []) result.servers[s.name] = s.status;
        } else if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_use') result.tool_calls.push({ name: block.name, input: block.input });
          }
        } else if (event.type === 'result') {
          result.answer = typeof event.result === 'string' ? event.result : '';
          result.cost_usd = event.total_cost_usd ?? null;
          if (event.is_error) result.error = `agent error: ${String(event.result ?? event.subtype).slice(0, 300)}`;
        }
      }
      if (!result.error && code !== 0) result.error = `claude exited ${code}: ${stderr.slice(0, 300)}`;
      if (!result.error && !result.answer) result.error = 'no answer';
      for (const name of Object.keys(mcpConfig?.mcpServers ?? {})) {
        if (!result.error && result.servers[name] !== 'connected') result.error = `MCP server ${name} did not connect (${result.servers[name] ?? 'missing'})`;
      }
      resolve(result);
    });
  });
}
