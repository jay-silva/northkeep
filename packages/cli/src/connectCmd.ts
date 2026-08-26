import {
  chatgptStatus,
  claudeCodeAvailable,
  claudeCodeStatus,
  claudeDesktopStatus,
  connect,
  cursorStatus,
  disconnect,
  resolveMcpCommand,
  type ConnectResult,
  type ConnectTarget,
} from '@northkeep/mcp-server';

/**
 * `northkeep connect` — M8 one-click Connect (ADR 0013, ChatGPT ADR 0021,
 * Cursor ADR 0041). Registers the MCP server that ships inside NorthKeep with
 * Claude Desktop, Claude Code, ChatGPT, or Cursor, under a scope preset the
 * user chooses. The writers live in @northkeep/mcp-server; this is just the
 * CLI skin.
 *
 * Mode-2 honesty (ADR Decision 4): Connect hands that app your OWNED, portable
 * memory under the scope you pick — it does NOT redact what you type into that
 * app. For a redaction firewall over your chat, use `northkeep converse`.
 */

const TARGET_LABEL: Record<ConnectTarget, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
};

function connectRestartHint(target: ConnectTarget): string {
  switch (target) {
    case 'claude-desktop':
      return '⚠  Restart Claude Desktop to load it (it reads MCP config only at launch).';
    case 'claude-code':
      return '⚠  Open a new Claude Code session to load it (registered at "user" scope).';
    case 'chatgpt':
      return '⚠  Restart ChatGPT to load it (it reads Codex MCP config only at launch).';
    case 'cursor':
      return '⚠  Restart Cursor, or toggle the server in Cursor Settings → MCP.';
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unhandled Connect target: ${String(_exhaustive)}`);
    }
  }
}

function disconnectRestartHint(target: ConnectTarget): string | null {
  switch (target) {
    case 'claude-desktop':
      return '  Restart Claude Desktop for the change to take effect.';
    case 'claude-code':
      return null;
    case 'chatgpt':
      return '  Restart ChatGPT for the change to take effect.';
    case 'cursor':
      return '  Restart Cursor, or toggle the server in Cursor Settings → MCP.';
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unhandled Connect target: ${String(_exhaustive)}`);
    }
  }
}

/** Commander collector: `--scope a,b --scope c` → ['a','b','c']. */
export function collectScopes(value: string, previous: string[]): string[] {
  return previous.concat(value.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
}

function scopeSummary(scopes: string[]): string {
  return scopes.length
    ? `scope "${scopes.join(', ')}" — the app sees ONLY memories in those scopes`
    : 'FULL access (owner) — the app sees every scope in your vault';
}

export function connectCmd(
  target: ConnectTarget,
  options: { scope: string[] },
  fail: (m: string) => never,
): void {
  const scopes = options.scope;
  let result: ConnectResult;
  try {
    result = connect(target, { scopes });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const label = TARGET_LABEL[target];
  console.log(`✓ Connected ${label} to NorthKeep (${scopeSummary(scopes)}).`);
  console.log(`  command: ${result.command}`);
  console.log(`  args:    ${result.args.join(' ')}`);
  console.log('');
  console.log(connectRestartHint(target));
  console.log('');
  console.log('Note: Connect gives that app your portable memory under the scope above. It does');
  console.log('NOT redact what you type into that app — the app still sends your chat to its');
  console.log('provider. For a redaction firewall over your chat, use "northkeep converse".');
}

export function disconnectCmd(target: ConnectTarget, fail: (m: string) => never): void {
  const label = TARGET_LABEL[target];
  let removed: boolean;
  try {
    ({ removed } = disconnect(target));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(
    removed
      ? `✓ Disconnected ${label}. Only NorthKeep's entry was removed; every other setting is untouched.`
      : `${label} was not connected — nothing to remove.`,
  );
  if (removed) {
    const hint = disconnectRestartHint(target);
    if (hint) console.log(hint);
  }
}

export function connectStatusCmd(): void {
  const { command, args } = resolveMcpCommand();
  const desktop = claudeDesktopStatus();
  console.log('NorthKeep Connect status');
  console.log(
    `  Claude Desktop: ${
      desktop.connected
        ? `connected${desktop.scopes ? ` (scopes: ${desktop.scopes.join(', ')})` : ' (full access)'}`
        : 'not connected'
    }`,
  );
  if (claudeCodeAvailable()) {
    const code = claudeCodeStatus();
    console.log(`  Claude Code:    ${code.connected ? 'connected' : 'not connected'}`);
  } else {
    console.log('  Claude Code:    the `claude` CLI is not installed (skipped)');
  }
  const chatgpt = chatgptStatus();
  console.log(
    `  ChatGPT:        ${
      chatgpt.connected
        ? `connected${chatgpt.scopes ? ` (scopes: ${chatgpt.scopes.join(', ')})` : ' (full access)'}`
        : 'not connected'
    }`,
  );
  const cursor = cursorStatus();
  console.log(
    `  Cursor:         ${
      cursor.connected
        ? `connected${cursor.scopes ? ` (scopes: ${cursor.scopes.join(', ')})` : ' (full access)'}`
        : 'not connected'
    }`,
  );
  console.log('');
  console.log('  Would register:');
  console.log(`    command: ${command}`);
  console.log(`    args:    ${args.join(' ')}`);
}
