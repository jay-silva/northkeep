import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';

/**
 * The ADR-0030 (decision 4) tool-spend budget (M10d). A costed tool
 * (`costPerCallUsd` set — today only web_search over Brave) is bounded by a
 * PERSISTED daily call-count cap plus a small per-conversation cap. The
 * genuinely uncovered risk is CUMULATIVE spend/quota across many
 * conversations: a single conversation is already bounded by the agent loop's
 * step limit, so a count that survives process restarts is the honest guard.
 * A count, not a dollar estimate, is the honest unit for Brave's free tier
 * (2,000 queries/month ≈ 66/day at $0) and still bounds spend on a paid tier;
 * a true dollar ledger is future work (KNOWN-LIMITS).
 *
 * Storage: ~/.northkeep/budget.json, same file idiom as permissions.json
 * (policy.ts) and tools.json (registry.ts): version field, 0600 writes with a
 * chmod on EVERY write, tolerant loader, strict writer. Two cleanly separated
 * sections in the file:
 *   - `tools`: the configured caps (settings the user sets/inspects).
 *   - `spend`: the day-keyed ledger the harness increments as calls execute.
 *
 * FAIL-CLOSED DIRECTION — note this is INVERTED from policy.ts. There, an
 * unreadable file means "no grant" = ask = safe. Here, an unreadable file
 * must mean "no configured caps, zero spend so far" — which ALLOWS a first
 * call but never an unbounded run, because `getToolBudget` still returns
 * DEFAULT_TOOL_BUDGET when a tool has no explicit entry, and `withinDailyCap`
 * always measures against that default cap. So a corrupt file degrades to the
 * conservative default cap (50/day), never to "no cap." Failing the other way
 * (a corrupt file bricking every costed tool to zero) would be a silent denial
 * of a paid feature the user turned on — worse than the bounded default.
 */

/** One tool's caps. `dailyCap` persists across conversations; `perConversationCap`
 * is enforced by the caller (runTask holds the live per-conversation count). */
export interface ToolBudget {
  dailyCap: number;
  perConversationCap: number;
}

export interface BudgetConfig {
  version: 1;
  tools: Record<string, ToolBudget>;
}

/**
 * Sensible defaults for a tool with no explicit config. Brave's free tier is
 * ~66 queries/day (2,000/month); we sit conservatively under that so the
 * default never blows a free quota, and the small per-conversation cap is a
 * fast local bound on a runaway loop before the daily count even matters.
 */
export const DEFAULT_TOOL_BUDGET: ToolBudget = { dailyCap: 50, perConversationCap: 5 };

/** The full on-disk shape: caps and the day-keyed spend ledger, kept apart. */
interface BudgetFile extends BudgetConfig {
  spend: Record<string, Record<string, number>>;
}

/** Safe defaults for an absent/corrupt file: no caps (→ defaults apply), zero spend. */
const EMPTY: BudgetFile = { version: 1, tools: {}, spend: {} };

export function budgetPath(): string {
  return path.join(northkeepHome(), 'budget.json');
}

/** The UTC calendar date of `now` as the ledger key. Injected `now` (never
 * Date.now()) keeps "which day is it" deterministic for tests and for the
 * loop, which redacts/audits against a single clock. */
const dayKey = (now: Date): string => now.toISOString().slice(0, 10);

/** A cap value is a finite, non-negative integer. Anything else is not a cap. */
const isCap = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isInteger(v);

/** Per-entry validation for the tolerant loader: both caps must be well-formed
 * numbers or the whole tool entry is dropped (→ that tool falls back to the
 * default cap, which is the safe, bounded outcome). */
function isToolBudget(entry: unknown): entry is ToolBudget {
  if (entry === null || typeof entry !== 'object') return false;
  const b = entry as Record<string, unknown>;
  return isCap(b.dailyCap) && isCap(b.perConversationCap);
}

/**
 * Read the whole file tolerantly. Any malformation — missing file, unparseable
 * JSON, wrong version, wrong shape — yields EMPTY (no caps, zero spend). We
 * never honor a `version` we did not write: a schema we do not understand
 * could misencode a cap or a count, and guessing is how a "0/day" gets read as
 * "unbounded." Dropping to defaults is the safe fail here (see file header).
 */
function loadFile(): BudgetFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(budgetPath(), 'utf8')) as unknown;
  } catch {
    return structuredClone(EMPTY); // missing or corrupt → defaults, zero spend
  }
  if (parsed === null || typeof parsed !== 'object') return structuredClone(EMPTY);
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1) return structuredClone(EMPTY);

  const out = structuredClone(EMPTY);

  // Caps: keep only well-formed per-tool entries; a bad entry simply does not
  // exist, so that tool uses DEFAULT_TOOL_BUDGET (bounded, never unbounded).
  // Tool NAMES are not allowlisted on read (registry.ts's KNOWN_TOOL_NAMES is
  // deliberately not consulted): web_search may not be registered in this
  // build yet, and a cap the user set for it must survive a reload.
  if (raw.tools !== null && typeof raw.tools === 'object') {
    for (const [tool, entry] of Object.entries(raw.tools as Record<string, unknown>)) {
      if (isToolBudget(entry)) {
        out.tools[tool] = { dailyCap: entry.dailyCap, perConversationCap: entry.perConversationCap };
      }
    }
  }

  // Spend ledger: { tool: { "YYYY-MM-DD": count } }. Drop any non-object tool
  // bucket and any non-integer/negative count. A dropped count reads as zero,
  // which errs toward ALLOWING a call — acceptable, since the daily cap still
  // applies to whatever real counts survived (fail toward a first call, never
  // toward an unbounded one).
  if (raw.spend !== null && typeof raw.spend === 'object') {
    for (const [tool, days] of Object.entries(raw.spend as Record<string, unknown>)) {
      if (days === null || typeof days !== 'object') continue;
      const bucket: Record<string, number> = {};
      for (const [day, count] of Object.entries(days as Record<string, unknown>)) {
        if (isCap(count)) bucket[day] = count;
      }
      if (Object.keys(bucket).length > 0) out.spend[tool] = bucket;
    }
  }
  return out;
}

/** Public loader: exposes only the caps section (the spend ledger is internal
 * bookkeeping, read via daySpend). Mirrors loadPermissions/loadToolsConfig. */
export function loadBudget(): BudgetConfig {
  const file = loadFile();
  return { version: 1, tools: file.tools };
}

function saveFile(file: BudgetFile): void {
  const target = budgetPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's `mode` applies only when it CREATES the file; a
  // pre-existing budget.json (older version, a loose umask, or an attacker
  // pre-creating it world-readable) keeps its old perms. chmod every write so
  // 0600 is guaranteed, not incidental (G1 review, mirrors policy.ts).
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // best-effort: a filesystem without POSIX perms (some mounts) is not a
    // reason to fail the write; the budget file holds no secrets, only counts.
  }
}

/** The caps for a tool: its explicit config, or DEFAULT_TOOL_BUDGET. Returns a
 * fresh object so callers cannot mutate the shared default constant. */
export function getToolBudget(tool: string): ToolBudget {
  const explicit = loadFile().tools[tool];
  return explicit !== undefined ? { ...explicit } : { ...DEFAULT_TOOL_BUDGET };
}

/**
 * Strict writer: upsert one tool's caps. "Strict" here means validating the
 * numeric SHAPE and writing a clean, normalized entry — NOT allowlisting the
 * tool name (unlike registry.ts's setToolEnabled). web_search is the whole
 * point of M10d and may not be registered in this build yet, so any non-empty
 * tool string is accepted; a bad NUMBER is refused loudly rather than
 * persisting a value the tolerant loader would silently drop.
 *
 * `budget` is Partial so the CLI can set just `--daily` or just
 * `--per-conversation`; unset fields inherit the tool's current caps (explicit
 * or default). The spend ledger is left UNTOUCHED — configuring a cap must
 * never move the count (pruning happens only on recordSpend).
 */
export function setToolBudget(tool: string, budget: Partial<ToolBudget>): void {
  if (typeof tool !== 'string' || tool.length === 0) {
    throw new Error('Tool name is required.');
  }
  const current = getToolBudget(tool);
  const next: ToolBudget = {
    dailyCap: budget.dailyCap ?? current.dailyCap,
    perConversationCap: budget.perConversationCap ?? current.perConversationCap,
  };
  if (!isCap(next.dailyCap)) {
    throw new Error(`dailyCap must be a non-negative integer, got: ${String(budget.dailyCap)}`);
  }
  if (!isCap(next.perConversationCap)) {
    throw new Error(
      `perConversationCap must be a non-negative integer, got: ${String(budget.perConversationCap)}`,
    );
  }
  const file = loadFile();
  file.tools[tool] = next;
  saveFile(file);
}

/**
 * Today's persisted spend count for a tool. "Day" = the UTC calendar date of
 * `now`; a count stored under any other date is a prior day and reads as 0
 * (the loop's first costed call on a new day starts fresh). Never touches disk
 * beyond the read, so it is safe to call on the hot path before every call.
 */
export function daySpend(tool: string, now: Date): number {
  return loadFile().spend[tool]?.[dayKey(now)] ?? 0;
}

/**
 * Would one more call be within the DAILY cap? Measured against
 * getToolBudget(tool).dailyCap — the explicit-or-DEFAULT cap — never a
 * literal, so a corrupt file (no explicit entry) still enforces the default 50
 * rather than bricking the tool to 0 or leaving it unbounded. The
 * per-conversation cap is NOT checked here: the caller holds the live
 * conversation count and enforces that half separately.
 */
export function withinDailyCap(tool: string, now: Date): boolean {
  return daySpend(tool, now) < getToolBudget(tool).dailyCap;
}

/**
 * The tools worth SHOWING in `northkeep tools budget`: the union of tools with
 * an explicit cap and tools that have spent something today. We deliberately do
 * NOT derive this from registry.ts's KNOWN_TOOL_NAMES — a costed tool
 * (web_search) may not be registered in this build yet, and a free tool
 * (web_fetch) never touches the budget, so neither the registry list nor a
 * hardcoded name is the right source. Sorted for stable CLI output.
 */
export function listBudgetedTools(now: Date): string[] {
  const file = loadFile();
  const today = dayKey(now);
  const names = new Set<string>(Object.keys(file.tools));
  for (const [tool, days] of Object.entries(file.spend)) {
    if ((days[today] ?? 0) > 0) names.add(tool);
  }
  return [...names].sort();
}

/**
 * Record one executed costed call against today's persisted count. Called by
 * runTask AFTER a costed tool actually runs, so the ledger reflects real
 * spend. Prunes every ledger entry that is not today's on the way out: only
 * today's counts are ever consulted, so old-day entries are dead weight, and
 * pruning keeps the file bounded no matter how many days the vault has run.
 */
export function recordSpend(tool: string, now: Date): void {
  const today = dayKey(now);
  const file = loadFile();
  // Prune: for every tool, keep only today's entry. Old days are meaningless
  // (never read) and would grow the file without bound.
  for (const [t, days] of Object.entries(file.spend)) {
    const kept = days[today];
    if (kept !== undefined) file.spend[t] = { [today]: kept };
    else delete file.spend[t];
  }
  const bucket = file.spend[tool] ?? {};
  bucket[today] = (bucket[today] ?? 0) + 1;
  file.spend[tool] = bucket;
  saveFile(file);
}

/**
 * Atomically reserve one daily call for `tool`: if today's persisted count is
 * below the tool's daily cap, increment it and return true; otherwise return
 * false and change nothing. ONE synchronous read-check-increment-write (no
 * await between read and write) so two concurrent runTask calls in single-
 * threaded Node cannot both reserve the last slot — the first completes and
 * increments, the second reads the incremented count and fails. This is the
 * authority for the daily cap (ADR 0031 Decision 5); recordSpend remains for
 * the unconditional-increment callers.
 *
 * WHY this is the authority, not withinDailyCap: the GUI (M10e) makes
 * concurrent conversations real, so M10d's check→execute→record TOCTOU
 * (KNOWN-LIMITS, G5) is now reachable — two runTask calls could each pass an
 * advisory withinDailyCap for the last slot, then both execute. Folding the
 * check and the increment into a single synchronous critical section closes
 * that race: because nothing yields between the spend read and the spend
 * write, the first call runs to completion (count now at cap) before the
 * second's read happens, and the second reads the incremented count and
 * returns false. There is deliberately NO release path (ADR 0031 Decision 5):
 * reserve-at-execute has no non-execute exits to unwind, so no missed release
 * can ever drift the count up until midnight.
 *
 * Fail-closed like the rest of the file: a corrupt/absent budget.json loads as
 * zero spend (loadFile → EMPTY), so a first reserve succeeds against the
 * explicit-or-DEFAULT cap — a bounded first call, never an unbounded pass.
 */
export function reserveDailySpend(tool: string, now: Date): boolean {
  const today = dayKey(now);
  const cap = getToolBudget(tool).dailyCap;
  // Single synchronous read: the count we check and the file we write must come
  // from the SAME load, so no interleaving call can slip a write in between.
  const file = loadFile();
  const current = file.spend[tool]?.[today] ?? 0;
  if (current >= cap) return false; // at/over cap → deny, write nothing.
  // Under cap → same on-disk write path as recordSpend: prune every non-today
  // entry (only today's count is ever read), then increment today's, then the
  // 0600 write. No await anywhere between the read above and this write.
  for (const [t, days] of Object.entries(file.spend)) {
    const kept = days[today];
    if (kept !== undefined) file.spend[t] = { [today]: kept };
    else delete file.spend[t];
  }
  const bucket = file.spend[tool] ?? {};
  bucket[today] = (bucket[today] ?? 0) + 1;
  file.spend[tool] = bucket;
  saveFile(file);
  return true;
}
