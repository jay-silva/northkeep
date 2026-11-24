// Runs one headless Claude Code session, cut off from this machine's own
// settings, memory, MCP servers and shell variables, and returns what it said
// and which tools it called. Other agents can be added beside this one with
// the same result shape.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Only what the `claude` command needs to start and sign in. */
function cleanEnv() {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
  return Object.fromEntries(keep.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
}

/**
 * `app` is "chat" (a bare assistant whose only tools are the MCP server's) or
 * "coding" (Claude Code's own system prompt and tools, with the notes added).
 *
 * @returns {Promise<{answer: string, tool_calls: {name: string, input: unknown}[], servers: Record<string,string>,
 *   cost_usd: number|null, error: string|null}>}
 */
export function runClaude({ prompt, systemPrompt, model, mcpConfig = null, app = 'chat', timeoutMs = 240_000 }) {
  // An empty working directory with project-only settings: no user CLAUDE.md, hooks, plugins or memory.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bench-cwd-'));
  const serverNames = Object.keys(mcpConfig?.mcpServers ?? {});
  const args = [
    '-p', prompt,
    app === 'coding' ? '--append-system-prompt' : '--system-prompt', systemPrompt,
    '--model', model,
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (app !== 'coding') args.push('--tools', '');
  if (mcpConfig) args.push('--mcp-config', JSON.stringify(mcpConfig), '--allowedTools', serverNames.map((name) => `mcp__${name}`).join(','));

  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      const result = { answer: '', tool_calls: [], servers: {}, cost_usd: null, error: null };
      let tools = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'system' && event.subtype === 'init') {
          for (const s of event.mcp_servers ?? []) result.servers[s.name] = s.status;
          tools = event.tools ?? [];
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
      const fail = (message) => { if (!result.error) result.error = message; };
      if (code !== 0) fail(`claude exited ${code}: ${stderr.slice(0, 300)}`);
      if (!result.answer) fail('no answer');
      // The session must see exactly the servers it was given, and in a chat app no other tool.
      const seen = Object.keys(result.servers).sort().join(',');
      if (seen !== [...serverNames].sort().join(',')) fail(`expected MCP servers [${serverNames}], the session had [${seen}]`);
      for (const name of serverNames) if (result.servers[name] !== 'connected') fail(`MCP server ${name} did not connect (${result.servers[name]})`);
      const stray = app === 'coding' ? [] : tools.filter((tool) => !serverNames.some((name) => tool.startsWith(`mcp__${name}__`)));
      if (stray.length > 0) fail(`the session had tools it should not: ${stray.slice(0, 5).join(', ')}`);
      resolve(result);
    });
  });
}
