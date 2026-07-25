import {
  budgetPath,
  clearGrants,
  daySpend,
  getToolBudget,
  KNOWN_TOOL_NAMES,
  listBudgetedTools,
  listGrants,
  loadToolsConfig,
  permissionsPath,
  removeGrant,
  setToolBudget,
  setToolEnabled,
  toolsConfigPath,
  webSearchNeedsKey,
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
      `${YELLOW}Note:${RESET} a tool call asks for your approval before it runs, unless you have\n` +
        `      already answered "always" or "never" for that tool and site. See: northkeep tools grants`,
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
  // web_search is inert until its Brave key is stored — say so loudly rather
  // than let the model silently never see the tool (enabledTools omits it).
  if (name === 'web_search' && webSearchNeedsKey()) {
    console.log(
      `${YELLOW}  ⚠ web_search needs a Brave Search key before it can run:${RESET}\n` +
        '      echo "$BRAVE_KEY" | northkeep tools brave-key',
    );
  }
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

/**
 * `northkeep tools budget` (M10d, ADR 0030 decision 4) — the persisted spend
 * guard for COSTED tools. With no tool, it shows each tool's daily and
 * per-conversation caps beside today's used count; with a tool it sets the
 * caps (a strict write, loudly confirmed — a spend limit the user cannot see
 * change would be the kind of silent policy shift this product refuses).
 *
 * A count, not a dollar estimate, is the unit (ADR 0030): honest for Brave's
 * free tier, still a hard bound on a paid one. Free tools never appear here —
 * only tools with a configured cap or with spend today.
 */
export function toolsBudget(
  tool: string | undefined,
  daily: string | undefined,
  perConversation: string | undefined,
  fail: (m: string) => never,
): void {
  const now = new Date();

  // No tool → inspect mode: show the union of configured + spent-today tools.
  if (tool === undefined) {
    if (daily !== undefined || perConversation !== undefined) {
      fail('Set caps with: northkeep tools budget <tool> --daily <n> --per-conversation <n>');
    }
    const names = listBudgetedTools(now);
    if (names.length === 0) {
      console.log('No tool budgets configured and nothing spent today.');
      console.log(
        `${DIM}Costed tools fall back to a conservative default cap until you set one.${RESET}`,
      );
      console.log(
        `${DIM}Set one with: northkeep tools budget <tool> --daily <n> --per-conversation <n>${RESET}`,
      );
      return;
    }
    for (const name of names) {
      const b = getToolBudget(name);
      const used = daySpend(name, now);
      // Colour the used count yellow once today's spend reaches the cap: the
      // next call will be denied (budget_exceeded), so make it visible.
      const usage = used >= b.dailyCap ? `${YELLOW}${used}/${b.dailyCap}${RESET}` : `${used}/${b.dailyCap}`;
      console.log(
        `  ${name.padEnd(12)} used ${usage} today · ${b.perConversationCap}/conversation`,
      );
    }
    console.log(`\n${DIM}Stored in ${budgetPath()} (settings only — no secrets, no content).${RESET}`);
    console.log(
      `${DIM}Change with: northkeep tools budget <tool> --daily <n> --per-conversation <n>${RESET}`,
    );
    return;
  }

  // Tool given → set mode: at least one cap must be provided.
  if (daily === undefined && perConversation === undefined) {
    fail('Usage: northkeep tools budget <tool> --daily <n> --per-conversation <n> (set at least one)');
  }

  // Parse loudly: a spend cap is security policy, so a garbled number is a
  // hard error, never a silently-dropped or coerced value.
  const parseCap = (label: string, raw: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      fail(`${label} must be a non-negative whole number, got: ${raw}`);
    }
    return n;
  };

  const patch: { dailyCap?: number; perConversationCap?: number } = {};
  if (daily !== undefined) patch.dailyCap = parseCap('--daily', daily);
  if (perConversation !== undefined) {
    patch.perConversationCap = parseCap('--per-conversation', perConversation);
  }

  try {
    setToolBudget(tool, patch);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const b = getToolBudget(tool);
  console.log(
    `✓ Budget for ${GREEN}${tool}${RESET}: ${b.dailyCap}/day · ${b.perConversationCap}/conversation.`,
  );
  console.log(`  ${DIM}Costed calls beyond the daily cap are denied and shown in the transcript.${RESET}`);
}
