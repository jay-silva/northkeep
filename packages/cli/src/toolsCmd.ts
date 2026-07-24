import {
  clearGrants,
  KNOWN_TOOL_NAMES,
  listGrants,
  loadToolsConfig,
  permissionsPath,
  removeGrant,
  setToolEnabled,
  toolsConfigPath,
} from '@northkeep/converse';
import { DIM, GREEN, RED, RESET, YELLOW } from './ui.js';

/**
 * `northkeep tools` — the agent-tool switchboard (M10b, ADR 0028). Tools ship
 * DISABLED; only this config enables them (never the model, never a flag on a
 * request). Same command style as `northkeep routing`.
 *
 * `grants` / `revoke` (M10c, ADR 0029) manage remembered per-(tool, host)
 * approvals. There is deliberately NO `grant` command: grants are created
 * only at a live approval prompt, where the user is looking at the exact
 * restored arguments of the exact call being approved. A CLI grant command
 * would create blanket permissions sight-unseen — precisely the quiet
 * standing consent this product refuses (invariant #1: sharing/consent is
 * explicit, loudly confirmed, and reversible). Revocation, by contrast, only
 * ever narrows, so it belongs here.
 */

export function toolsList(): void {
  const config = loadToolsConfig();
  for (const name of KNOWN_TOOL_NAMES) {
    const enabled = config.tools[name]?.enabled === true;
    console.log(
      `  ${name.padEnd(12)} ${enabled ? `${GREEN}enabled${RESET}` : `${DIM}disabled${RESET}`}`,
    );
  }
  console.log(`\n${DIM}Stored in ${toolsConfigPath()} (settings only — no secrets, no content).${RESET}`);
  console.log(`${DIM}Enable with: northkeep tools enable <name> · use with: northkeep converse --tools${RESET}`);
  if (KNOWN_TOOL_NAMES.some((n) => config.tools[n]?.enabled)) {
    console.log(
      `${YELLOW}Note:${RESET} every tool call still asks for your approval before it runs (M10b placeholder gate).`,
    );
  }
}

export function toolsEnable(name: string, fail: (m: string) => never): void {
  try {
    setToolEnabled(name, true);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`✓ ${name} enabled. Use it with: northkeep converse --tools`);
  console.log('  Every call shows you the exact URL/arguments and waits for your yes.');
}

export function toolsDisable(name: string, fail: (m: string) => never): void {
  try {
    setToolEnabled(name, false);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`✓ ${name} disabled.`);
}

export function toolsGrants(): void {
  const grants = listGrants();
  if (grants.length === 0) {
    console.log('No remembered approvals.');
    console.log(
      `${DIM}Grants are created only at a live approval prompt ("always allow this site"), never from the CLI.${RESET}`,
    );
    return;
  }
  for (const g of grants) {
    const scope = g.scope === 'never' ? `${RED}never${RESET}` : `${GREEN}always${RESET}`;
    console.log(
      `  ${g.tool.padEnd(12)} ${g.host.padEnd(28)} ${scope} · granted ${g.createdAt.slice(0, 10)}`,
    );
  }
  console.log(`\n${DIM}Stored in ${permissionsPath()} (settings only — no secrets, no content).${RESET}`);
  console.log(
    `${DIM}Revoke with: northkeep tools revoke <tool> <host> · everything: northkeep tools revoke --all${RESET}`,
  );
}

export function toolsRevoke(
  tool: string | undefined,
  host: string | undefined,
  all: boolean,
  fail: (m: string) => never,
): void {
  // Consent is reversible and its reversal is loudly confirmed (invariant #1):
  // say exactly what was removed, or exactly why nothing was.
  if (all) {
    if (tool !== undefined || host !== undefined) {
      fail('Use either "revoke <tool> <host>" or "revoke --all", not both.');
    }
    const removed = clearGrants();
    if (removed === 0) {
      console.log('No remembered approvals to revoke.');
      return;
    }
    console.log(
      `✓ Revoked ${removed} remembered approval${removed === 1 ? '' : 's'}. Every tool call asks again.`,
    );
    return;
  }
  if (tool === undefined || host === undefined) {
    fail('Usage: northkeep tools revoke <tool> <host> (or: northkeep tools revoke --all)');
  }
  if (!removeGrant(tool, host)) {
    fail(`No such grant: ${tool} ${host}. See what exists with: northkeep tools grants`);
  }
  console.log(`✓ Revoked: ${tool} ${host}. Calls there ask again.`);
}
