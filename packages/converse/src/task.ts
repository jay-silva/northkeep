import crypto from 'node:crypto';
import type { MemoryEntry } from '@northkeep/core';
import { applyTier1, redact, restore, type Replacement } from '@northkeep/redact';
import { appendCallLog, type CallLogEntry } from '@northkeep/mcp-server';
import type {
  ChatMessage,
  ChatTurnResult,
  PrivacyTier,
  ToolCallRequest,
  ToolSpec,
} from './provider.js';
import { classifyEndpoint } from './provider.js';
import {
  audit,
  distillExchange,
  recordDisclosedMemory,
  resolveUsage,
  retrieveAndAssemble,
  TurnError,
  type TurnOptions,
  type TurnResult,
} from './turn.js';
import { estimateTurnCost, loadCatalog, lookupModel, type TokenUsage } from './catalog.js';
import { redactJsonLeaves, restoreJsonLeaves } from './jsonLeaves.js';
import type { ToolDefinition, ToolResult } from './tools/types.js';
import { placeholderGate, type PermissionGate } from './tools/gate.js';
import { describeFlag, screenArguments, type ExfilFlag } from './tools/exfil.js';
import { getServer as getMcpServer } from './tools/mcp/config.js';
import { getToolBudget, reserveDailySpend, withinDailyCap } from './tools/budget.js';
import { newFenceNonce, untrustedSystemLine, wrapUntrusted } from './tools/untrusted.js';

/**
 * runTask — the agent loop (M10b, ADR 0027/0028): model → tool → model → …
 * with bounded iterations, built on chatTurn. runTurn stays untouched for
 * plain chat; this file owns its OWN wire assembly because tool fields
 * (assistant toolCalls, tool results) must ride through redaction, which
 * runTurn's text-only rebuild would strip.
 *
 * The governing principle (ADR 0027 decision 1): everything crossing the
 * harness boundary arrives as plaintext, is stored as plaintext in the
 * session, and is redacted PER DESTINATION at send time. Concretely, every
 * step of the loop:
 *   - re-redacts the ENTIRE prompt (system + full history, including tool
 *     results and tool-call arguments) at the effective tier before the
 *     provider call — nothing captured at a weaker tier ever rides along;
 *   - restores the model's text AND its tool-call argument string leaves to
 *     plaintext locally (bounded models emit pseudonyms/masks — the tool
 *     needs real values, and the permission gate must show real values);
 *   - re-redacts tool-bound arguments at the TOOL's egress tier before
 *     execute (ADR 0028 §egress seam) — never a raw restore onto the wire.
 */

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_RESULT_CHARS = 20_000;

/**
 * Secret kinds that HARD-DENY a tool call when the exfil screens find one in
 * the arguments (ADR 0029 decision 2): kinds with no legitimate reason to
 * ride an egress URL and catastrophic-if-leaked semantics. Every OTHER
 * screen hit (email, phone, record ids, addresses, protected names, memory
 * overlap) escalates to a warned, grant-bypassing prompt instead — those
 * have legitimate uses (searching your own email) and false positives, so
 * the human decides. Widening this set is cheap; narrowing it is a review.
 */
const HARD_DENY_SECRET_KINDS = new Set(['ssn', 'credit_card', 'iban', 'api_key']);

/** Content-free progress events for the driving surface (CLI now, web M10e). */
export type TaskEvent =
  | { type: 'step'; n: number; model: string; endpointHost: string; privacy: PrivacyTier }
  | { type: 'tool_call'; name: string; host?: string; egressTier?: PrivacyTier }
  | {
      type: 'permission';
      name: string;
      decision: 'approved' | 'denied' | 'timeout';
      /** Decision provenance (M10c, ADR 0029; M10d adds 'budget'): 'user'
       * answered a prompt, 'grant' means the engine decided from a stored
       * grant (auto-allow OR never-deny), 'screen' means the exfil screens
       * hard-denied, 'budget' means the spend cap refused it. */
      via?: 'user' | 'grant' | 'screen' | 'budget';
      /** Content-free warning sentences, present on screen denials so the
       * surface can say WHY (invariant #6: loud, never silent). */
      reasons?: string[];
    }
  | {
      type: 'tool_result';
      name: string;
      ok: boolean;
      bytes: number;
      truncated: boolean;
      host?: string;
      /** On a FAILED call, the tool's own one-line guidance (M10d) — content-
       * free by construction (structured {error, guidance}, never page/query
       * text), so the driving surface can tell the user WHY, not just "error". */
      error?: string;
    };

export interface ApprovalRequest {
  tool: string;
  /** RESTORED plaintext arguments — exactly what will execute (ADR 0027). */
  argsPlain: string;
  risk: 'safe-read' | 'consequential';
  egress: { host: string; tier: PrivacyTier } | null;
  /**
   * The configured MCP server this call belongs to, when it is an MCP tool
   * (M11, ADR 0033). Surfaces use it to name what a remembered answer would
   * apply to, since such a call has no host to name.
   */
  server?: string;
  /** Exfil-screen warnings (ADR 0029), one plain sentence each, content-free.
   * Non-empty means grants were bypassed and a human MUST see this call. */
  warnings: string[];
}

/**
 * What the approval surface may answer (M10c widens M10b's allow/deny).
 * Scoped answers ('-session', '-always', '-never') are recorded with the
 * gate's engine when it supports recording and the call has an egress host;
 * they degrade to their once-only meaning otherwise — degrading TOWARD
 * asking again is the safe direction.
 */
export type ApprovalAnswer = 'allow' | 'allow-session' | 'allow-always' | 'deny' | 'deny-never';

export interface TaskHooks {
  onEvent(event: TaskEvent): void;
  requestApproval(req: ApprovalRequest): Promise<ApprovalAnswer>;
}

export interface TaskOptions extends TurnOptions {
  tools?: ToolDefinition[];
  hooks: TaskHooks;
  /** Model→tool round trips before the loop stops loudly. Default 10. */
  maxSteps?: number;
  /** Injectable for tests; defaults to the fail-closed placeholder (M10c: ADR 0029 engine). */
  gate?: PermissionGate;
  /** An unanswered approval DENIES after this long. Default 5 minutes. */
  approvalTimeoutMs?: number;
  /** Per-tool-result truncation (characters). */
  maxResultChars?: number;
  maxTokens?: number;
}

export interface TaskResult extends TurnResult {
  /** Provider round trips this task made. */
  steps: number;
  /** Per-call summary (names/hosts/decisions). `egress` is the RESTORED URL a
   * call actually sent out (web_fetch URL / Brave query URL — never the token),
   * present only on executed calls, for the "what left this device" proof (ADR
   * 0031 Decision 6). The content-free AUDIT log is written separately. */
  toolCallsMade: Array<{
    name: string;
    host?: string;
    decision: string;
    egress?: string;
    /** For an executed MCP call: the server, and the MASKED arguments it
     * received. An MCP tool has no URL, so it never appeared in the egress
     * proof — and an auto-allowed one showed its arguments nowhere at all,
     * since the audit keeps only a hash. Ephemeral, like the rest of the
     * proof: streamed once, never persisted. */
    mcpServer?: string;
    argsSent?: string;
  }>;
  /** How the loop ended — 'step-limit' and 'aborted' are visible, never silent. */
  stopped: 'done' | 'step-limit' | 'aborted';
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function truncateChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated: result exceeded ${max} characters]`;
}

/** requestApproval with the deny-on-timeout and deny-on-abort rails. */
interface ApprovalOutcome {
  decision: 'approved' | 'denied' | 'timeout';
  /** The scope the user attached to their answer, when they attached one. */
  scope?: 'session' | 'always' | 'never';
}

async function approvalWithTimeout(
  hooks: TaskHooks,
  req: ApprovalRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ApprovalOutcome> {
  // Already aborted before we even ask? Deny at once — the abort listener
  // below would attach to a signal that never fires again, stranding the call
  // until the timeout (G4 nit: defensive, effectively unreachable today).
  if (signal?.aborted === true) return { decision: 'denied' };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ApprovalOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ decision: 'timeout' }), timeoutMs);
  });
  const races: Array<Promise<ApprovalOutcome>> = [
    hooks
      .requestApproval(req)
      .then((a): ApprovalOutcome => {
        switch (a) {
          case 'allow':
            return { decision: 'approved' };
          case 'allow-session':
            return { decision: 'approved', scope: 'session' };
          case 'allow-always':
            return { decision: 'approved', scope: 'always' };
          case 'deny-never':
            return { decision: 'denied', scope: 'never' };
          default: // 'deny' — and any future unknown answer fails CLOSED
            return { decision: 'denied' };
        }
      })
      .catch((): ApprovalOutcome => ({ decision: 'denied' })), // broken surface fails CLOSED
    timeout,
  ];
  if (signal !== undefined) {
    races.push(
      new Promise<ApprovalOutcome>((resolve) => {
        signal.addEventListener('abort', () => resolve({ decision: 'denied' }), { once: true });
      }),
    );
  }
  try {
    return await Promise.race(races);
  } finally {
    clearTimeout(timer);
  }
}

export async function runTask(options: TaskOptions): Promise<TaskResult> {
  const { message, session, provider, model, vault, allowedScopes, hooks, onToken, signal } = options;
  const redactFn = options.redactFn ?? redact;
  const restoreFn = options.restoreFn ?? restore;
  const auditFn = options.auditFn ?? appendCallLog;
  const now = options.now ?? (() => new Date());
  const gate = options.gate ?? placeholderGate;
  // Scoped approvals are recorded with the gate when it can record them
  // (the ADR-0029 engine can; the placeholder and test stubs cannot).
  // Structural, not an import of policy.ts: the loop must not depend on any
  // particular gate implementation — see ADR 0029 decision 1.
  const gateRecord = (
    gate as {
      record?: (
        tool: string,
        subject: { host: string } | { server: string },
        scope: 'session' | 'always' | 'never',
      ) => void;
    }
  ).record?.bind(gate);
  const tools = options.tools ?? [];
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const toolSpecs: ToolSpec[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  // Read through a function call: TypeScript persists property narrowing on
  // `signal.aborted` across awaits, which would make later checks look dead.
  const isAborted = (): boolean => signal?.aborted === true;

  const { tier: privacy, host: endpointHost } = classifyEndpoint(provider.baseUrl);
  // Same rule as runTurn: bounded endpoints get Tier-1 minimum, always.
  const effectiveTier: 0 | 1 | 2 | 3 =
    privacy === 'bounded' && options.redactTier === 0 ? 1 : options.redactTier;

  // Retrieve → compress → assemble exactly as runTurn (shared code), plus the
  // one external-content system line when tools are enabled (ADR 0028).
  const { used, systemText: baseSystem } = await retrieveAndAssemble({
    vault,
    message,
    allowedScopes,
    memoryLimit: options.memoryLimit,
    memoryCharBudget: options.memoryCharBudget,
  });
  const fenceNonce = newFenceNonce();
  const systemText =
    tools.length > 0 ? `${baseSystem}\n\n${untrustedSystemLine(fenceNonce)}` : baseSystem;

  // NER MECHANISM — UNIFIED WITH runTurn, NOT DUPLICATED. The M10b plan
  // sketched a `nerSeen` count watermark on the session (messages below the
  // watermark replay-only, at/above run full NER). The mechanism merged into
  // turn.ts by the reconciliation — `historyTiers`, parallel to plainHistory —
  // is that same watermark GENERALIZED per message with the tier recorded:
  // a message replays only when it was already full-NER'd at >= the current
  // tier; anything first seen lower (including every restored assistant reply
  // and every tool result, recorded as 0) is re-NER'd the next time NER runs.
  // A bare count would forget WHICH tier covered a message and leak on a
  // tier swap-up mid-session, so we reuse historyTiers verbatim: one
  // mechanism, one place to reason about it, runTurn behavior unchanged, and
  // sessions interleaving runTurn and runTask stay consistent.
  session.historyTiers ??= [];
  // Conversation-wide disclosed-memory accumulator (ADR 0029, G1 blocker fix):
  // this task's freshly-retrieved memories join everything disclosed earlier
  // (by prior runTask OR runTurn turns — recordDisclosedMemory is shared), so
  // the exfil screen covers memory the model saw on a PRIOR turn even when
  // this turn's retrieval no longer surfaces it.
  recordDisclosedMemory(session, used);
  // Per-conversation spend counter (M10d, ADR 0030); `??=` tolerates a session
  // built before the field existed.
  session.toolSpend ??= {};

  // The user message enters the plaintext history up front (the loop's wire
  // is always [system, ...plainHistory]). Recorded at 0 = never NER'd; the
  // first step's redaction runs it 'on' and records the tier actually applied.
  session.plainHistory.push({ role: 'user', content: message });
  session.historyTiers.push(0);
  let appendedBeyondUser = false; // for clean unwind if step 1 fails outright

  const redactionSeen = new Map<
    string,
    { placeholder: string; original: string; kind: string; tier: 1 | 2 | 3 }
  >();
  const usageSteps: TokenUsage[] = [];
  const toolCallsMade: TaskResult['toolCallsMade'] = [];
  let steps = 0;
  let finalText = '';
  let tierAppliedLast: 0 | 1 | 2 | 3 = 0;
  let tier2DegradedAny = false;
  let stopped: TaskResult['stopped'] = 'done';

  const appendSynthetic = (calls: ToolCallRequest[], text: string): void => {
    // History must stay wire-valid: an assistant message with tool calls MUST
    // be answered by one tool result per call before any later send.
    for (const call of calls) {
      session.plainHistory.push({ role: 'tool', toolCallId: call.id, content: text });
      session.historyTiers.push(0);
    }
  };

  try {
    taskLoop: for (let step = 1; step <= maxSteps; step += 1) {
      steps = step;

      // ---- Wire assembly: FULL re-redaction at the effective tier, EVERY
      // step (ADR 0007). Message content AND the string leaves of assistant
      // toolCalls[].arguments are redacted; ids and tool NAMES pass through
      // (they are our identifiers, not user content).
      const plainPrompt: ChatMessage[] = [
        { role: 'system', content: systemText },
        ...session.plainHistory,
      ];
      let wire: ChatMessage[] = plainPrompt;
      const replacements: Replacement[] = [];
      let tier2Degraded = false;
      let tierApplied: 0 | 1 | 2 | 3 = 0;
      if (effectiveTier !== 0) {
        const redacted: ChatMessage[] = [];
        const reNerdHistory: number[] = [];
        for (let mi = 0; mi < plainPrompt.length; mi += 1) {
          const msg = plainPrompt[mi]!;
          // Per-message NER decision — the historyTiers mechanism, see above.
          // The system block (memories change per task) always runs 'on'.
          let historyIndex = -1;
          let nerMode: 'on' | 'replay-only';
          if (mi === 0) {
            nerMode = 'on';
          } else {
            historyIndex = mi - 1; // plainPrompt[mi] === session.plainHistory[mi-1]
            const seenTier = session.historyTiers[historyIndex] ?? 0;
            nerMode = seenTier < effectiveTier ? 'on' : 'replay-only';
          }
          const redactLeaf = async (text: string): Promise<string> => {
            const r = await redactFn(text, {
              tier: effectiveTier,
              pseudonyms: session.pseudonyms,
              nerMode,
            });
            if (r.tier2Degraded) tier2Degraded = true;
            replacements.push(...r.replacements);
            return r.redacted;
          };
          const out: ChatMessage = { role: msg.role, content: await redactLeaf(msg.content) };
          if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
            const calls: ToolCallRequest[] = [];
            for (const c of msg.toolCalls) {
              calls.push({
                id: c.id,
                name: c.name,
                // Parse → redact each string leaf → re-serialize; unparseable
                // argument JSON is redacted as raw text (fail closed).
                arguments: await redactJsonLeaves(c.arguments, redactLeaf),
              });
            }
            out.toolCalls = calls;
          }
          if (msg.toolCallId !== undefined) out.toolCallId = msg.toolCallId;
          redacted.push(out);
          if (historyIndex >= 0 && nerMode === 'on') reNerdHistory.push(historyIndex);
        }
        // Same refusal rule as runTurn: Tier 2's only name layer is the NER,
        // so degraded toward a bounded endpoint refuses LOUDLY (invariant #6).
        if (effectiveTier === 2 && tier2Degraded && privacy === 'bounded') {
          audit(auditFn, now, {
            ok: false,
            denied: true,
            error: 'tier2-unavailable',
            endpointHost,
            model,
            privacy,
            tier: effectiveTier,
            allowedScopes,
            message,
            used: [],
            created: [],
          });
          throw new TurnError(
            'TIER2_UNAVAILABLE',
            'Name pseudonymization needs the local model (is Ollama running?) and this endpoint is not private. Nothing was sent. Start the local model, or explicitly switch this endpoint to Tier 1.',
          );
        }
        wire = redacted;
        tierApplied = effectiveTier === 2 && tier2Degraded ? 1 : effectiveTier;
        // Record real NER coverage AFTER the refuse guard, exactly as runTurn.
        for (const idx of reNerdHistory) session.historyTiers[idx] = tierApplied;
      }
      tierAppliedLast = tierApplied;
      if (tier2Degraded) tier2DegradedAny = true;

      hooks.onEvent({ type: 'step', n: step, model, endpointHost, privacy });

      // ---- Provider call.
      let reportedUsage: { inputTokens: number; outputTokens: number } | null = null;
      let turn: ChatTurnResult;
      try {
        turn = await provider.chatTurn(wire, {
          model,
          onToken,
          signal,
          onUsage: (u) => {
            reportedUsage = u;
          },
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
        });
      } catch (err) {
        if (isAborted()) {
          // Cancelled mid-call: nothing landed in history for this step, so
          // it is already wire-valid — conclude gracefully, no error row.
          stopped = 'aborted';
          break;
        }
        audit(auditFn, now, {
          ok: false,
          error: err instanceof Error ? err.message : 'provider call failed',
          endpointHost,
          model,
          privacy,
          tier: tierApplied,
          allowedScopes,
          message,
          used: used.map((s) => s.entry),
          created: [],
        });
        // An endpoint that 400s a tools-bearing request does not speak tools:
        // loud, structured, never a prompt-parsing fallback (ADR 0027).
        if (toolSpecs.length > 0 && err instanceof Error && /HTTP 400\b/.test(err.message)) {
          throw new TurnError(
            'TOOLS_UNSUPPORTED',
            `${model} on ${endpointHost} refused the tool-enabled request. This endpoint likely has no native tool support — disable tools for it, or pick a tool-capable model.`,
          );
        }
        throw new TurnError(
          'PROVIDER_FAILED',
          err instanceof Error ? err.message : 'The model endpoint did not answer.',
        );
      }
      usageSteps.push(resolveUsage(reportedUsage, wire, turn.text));
      for (const r of replacements) {
        if (!redactionSeen.has(r.placeholder)) {
          redactionSeen.set(r.placeholder, {
            placeholder: r.placeholder,
            original: r.original,
            kind: r.kind,
            tier: r.tier,
          });
        }
      }

      // ---- Restore locally: reply text and tool-call argument leaves.
      const restoreLeaf = (text: string): string => restoreFn(text, replacements);
      const restoredText = restoreLeaf(turn.text);
      const restoredCalls: ToolCallRequest[] = turn.toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: restoreJsonLeaves(c.arguments, restoreLeaf),
      }));
      session.plainHistory.push({
        role: 'assistant',
        content: restoredText,
        ...(restoredCalls.length > 0 ? { toolCalls: restoredCalls } : {}),
      });
      session.historyTiers.push(0); // restored plaintext: re-NER on next NER run
      appendedBeyondUser = true;
      if (restoredText.length > 0) finalText = restoredText;

      // ---- Continue or stop. The loop keys on toolCalls.length, NEVER on
      // stopReason alone: a truncated or nonconforming response can carry
      // tool calls with stopReason 'end', and dropping them would desync the
      // model's view of its own actions (M10a review carry-forward).
      if (restoredCalls.length === 0) {
        stopped = 'done';
        break;
      }
      const modelRowBase = {
        ok: true,
        endpointHost,
        model,
        privacy,
        tier: tierApplied,
        allowedScopes,
        message,
        used: used.map((s) => s.entry),
        routeReason: options.routeReason,
      };
      if (isAborted()) {
        appendSynthetic(restoredCalls, 'Cancelled by the user.');
        stopped = 'aborted';
        break;
      }
      if (step === maxSteps) {
        // Step cap: stop LOUDLY (the result carries the marker), and keep
        // history wire-valid with synthetic results for the unrun calls.
        appendSynthetic(restoredCalls, 'Not executed: the task reached its step limit.');
        stopped = 'step-limit';
        break;
      }
      // A non-final model call gets its audit row now; the FINAL call's row is
      // written after distillation so it carries created_ids like runTurn's.
      audit(auditFn, now, { ...modelRowBase, created: [] });

      // ---- Execute the tool calls, one gate decision + one audit row each.
      for (let ci = 0; ci < restoredCalls.length; ci += 1) {
        const call = restoredCalls[ci]!;
        if (isAborted()) {
          appendSynthetic(restoredCalls.slice(ci), 'Cancelled by the user.');
          stopped = 'aborted';
          break taskLoop;
        }
        const tool = toolByName.get(call.name);
        // An MCP tool is namespaced `server__tool` by the adapter, so the
        // server id comes from OUR config, never from model-supplied text
        // (ADR 0033 D1). It is what a grant keys on when there is no host, and
        // what the audit row names when there is no domain.
        // STRUCTURAL, not string-parsed: `tool` was looked up in our own
        // registry, so its serverId is our config's value. Deriving this from
        // the name would let a server choose (or erase) its own identity.
        const mcpServerId = tool?.serverId;
        let decision: 'approved' | 'denied' | 'timeout' = 'denied';
        let egressUrl: string | null = null;
        let egressHost: string | undefined;
        let egressTier: PrivacyTier = 'bounded'; // fail closed: unknown = it leaves
        let execMeta: ToolResult['meta'] | null = null;
        // The masked arguments an executed tool actually received, kept for the
        // ephemeral proof only (see toolCallsMade).
        let sentArgsJson: string | undefined;
        let resultContent: string;
        // M10c (ADR 0029): screen flags, decision provenance, and the scope
        // that produced the decision — all content-free, all audited.
        let screenFlags: ExfilFlag[] = [];
        let scopeApplied:
          | 'once'
          | 'session'
          | 'always'
          | 'never'
          | 'auto'
          | 'screen'
          | 'budget'
          | undefined;
        let screenedDeny = false;

        if (tool === undefined) {
          resultContent = JSON.stringify({
            error: 'unknown_tool',
            guidance: `No tool named "${call.name}" is available. Use only the tools you were offered.`,
          });
        } else {
          let parsedArgs: unknown;
          let argsParse = true;
          try {
            parsedArgs = JSON.parse(call.arguments) as unknown;
          } catch {
            argsParse = false;
          }
          if (!argsParse) {
            resultContent = JSON.stringify({
              error: 'invalid_arguments',
              guidance: 'The tool arguments were not valid JSON. Emit one valid JSON object.',
            });
          } else {
            const egress = tool.egress(parsedArgs);
            if (egress !== null) {
              egressUrl = egress.url;
              try {
                const c = classifyEndpoint(egress.url);
                egressHost = c.host;
                egressTier = c.tier;
              } catch {
                egressHost = undefined; // unclassifiable stays 'bounded' (fail closed)
              }
            }
            hooks.onEvent({
              type: 'tool_call',
              name: call.name,
              ...(egressHost !== undefined ? { host: egressHost, egressTier } : {}),
            });
            const toolEgress =
              egressUrl !== null && egressHost !== undefined
                ? { host: egressHost, tier: egressTier }
                : null;


            // ---- EXFILTRATION SCREENS (M10c, ADR 0029 decision 1): run IN
            // THE LOOP, before the gate, over the RESTORED plaintext — the
            // gate is an injectable seam, and a security control must not
            // depend on which implementation a surface wired in (same logic
            // that put the SSRF guard inside the net client). Secret-class
            // hits hard-deny without consulting gate or user; identity/
            // memory-class hits force a human prompt with warnings.
            // The screen is pure and bounded, but a bug or an adversarial
            // input that still slips past its caps must never abort the task
            // or, worse, skip screening: a throw here FAILS CLOSED into a hard
            // deny (G3 #5), never into an unscreened execute.
            let screenThrew = false;
            try {
              screenFlags = screenArguments({
                argsPlain: call.arguments,
                egressUrl,
                // PseudonymMap keys are the lowercased REAL entity values the
                // session's redaction is actively protecting (tier2.ts).
                protectedValues: Object.keys(session.pseudonyms),
                // Conversation-wide, not this-turn (G1 blocker): see the
                // session.disclosedMemory accumulator above.
                usedMemoryContents: session.disclosedMemory,
              });
            } catch {
              screenThrew = true;
              screenFlags = [];
            }
            // Trusted-API egress (web_search → Brave): the query goes to a
            // trusted third party, not an attacker, so identity/memory and
            // warn-class flags are pure fatigue (ADR 0030 decision 2). Keep
            // ONLY the catastrophic-secret hard-block — an SSN must not reach
            // even Brave's logs — and drop the rest, so a clean search is not
            // gratuitously screened and a site grant can auto-allow it.
            if (tool.egressTrust === 'trusted-api') {
              screenFlags = screenFlags.filter(
                (f) => f.class === 'secret' && f.kind !== undefined && HARD_DENY_SECRET_KINDS.has(f.kind),
              );
            }
            // Budget check (M10d, ADR 0030 decision 4): a COSTED tool is
            // refused BEFORE the gate — no point asking the user to approve a
            // call the spend cap won't run — when either the persisted daily
            // cap or the per-conversation cap is already reached. Free tools
            // (no costPerCallUsd) never touch the budget.
            const costed = tool.costPerCallUsd !== undefined && tool.costPerCallUsd > 0;
            const convCount = session.toolSpend[call.name] ?? 0;
            const overBudget =
              costed &&
              (!withinDailyCap(call.name, now()) ||
                convCount >= getToolBudget(call.name).perConversationCap);
            const budgetReason = !withinDailyCap(call.name, now())
              ? "this tool's daily budget is used up"
              : 'this tool hit its per-conversation limit';

            const warnings = screenThrew
              ? ['the request could not be safety-screened, so it was blocked']
              : overBudget
                ? [budgetReason]
                : screenFlags.map(describeFlag);
            let via: 'user' | 'grant' | 'screen' | 'budget' = 'user';
            let budgetDeny = false;

            if (
              screenThrew ||
              screenFlags.some(
                (f) => f.class === 'secret' && f.kind !== undefined && HARD_DENY_SECRET_KINDS.has(f.kind),
              )
            ) {
              decision = 'denied';
              screenedDeny = true;
              scopeApplied = 'screen';
              via = 'screen';
            } else if (overBudget) {
              // Loud, structured, audited — never a silent stop (invariant #6).
              decision = 'denied';
              budgetDeny = true;
              scopeApplied = 'budget';
              via = 'budget';
            } else {
              const gateAnswer = await gate.evaluate({
                tool: call.name,
                argsPlain: call.arguments,
                risk: tool.risk,
                modelTier: privacy,
                toolEgress,
                ...(mcpServerId !== undefined ? { server: mcpServerId } : {}),
                screened: screenFlags.length > 0,
              });
              if (gateAnswer === 'deny') {
                // Only a stored 'never' grant produces this in v1.
                decision = 'denied';
                scopeApplied = 'never';
                via = 'grant';
              } else if (gateAnswer === 'auto-allow') {
                decision = 'approved';
                scopeApplied = 'auto';
                via = 'grant';
              } else {
                const outcome = await approvalWithTimeout(
                  hooks,
                  {
                    tool: call.name,
                    argsPlain: call.arguments,
                    risk: tool.risk,
                    egress: toolEgress,
                    ...(mcpServerId !== undefined ? { server: mcpServerId } : {}),
                    warnings,
                  },
                  approvalTimeoutMs,
                  signal,
                );
                decision = outcome.decision;
                // A scoped answer becomes a grant, gated by (G1 review):
                //  - a concrete host to key it on;
                //  - an ALLOW scope ('session'/'always') persists only for a
                //    safe-read tool with NO screen flags (a consequential or
                //    flagged call must be seen every time — G1 minor); but
                //  - a 'never' DENY always persists: a standing "no" is
                //    fail-safe and must hold even on a screened/consequential
                //    call (G1 nit).
                const recordable =
                  outcome.scope === 'never' ||
                  (tool.risk === 'safe-read' && screenFlags.length === 0);
                const grantSubject =
                  mcpServerId !== undefined
                    ? { server: mcpServerId }
                    : egressHost !== undefined
                      ? { host: egressHost }
                      : undefined;
                if (outcome.scope !== undefined && grantSubject !== undefined && recordable && gateRecord !== undefined) {
                  gateRecord(call.name, grantSubject, outcome.scope);
                  // Audit the scope actually REMEMBERED, not what was asked —
                  // a scope we declined to persist must not read as persisted
                  // in the log (G1 nit: provenance honesty).
                  scopeApplied = outcome.scope;
                } else {
                  scopeApplied = 'once';
                }
              }
            }
            hooks.onEvent({
              type: 'permission',
              name: call.name,
              decision,
              via,
              ...(screenedDeny || budgetDeny ? { reasons: warnings } : {}),
            });

            if (decision !== 'approved') {
              resultContent = JSON.stringify(
                screenedDeny
                  ? {
                      error: 'blocked_exfiltration',
                      guidance:
                        'The harness blocked this call: its arguments appear to carry a secret-shaped value, possibly hidden by encoding. Do not retry with re-encoded or restructured arguments.',
                    }
                  : budgetDeny
                    ? {
                        error: 'budget_exceeded',
                        guidance: `Not run: ${budgetReason}. Do not retry this tool now; the limit resets or can be raised by the user.`,
                      }
                    : {
                        error: 'permission_denied',
                        guidance: 'The user declined this tool call.',
                      },
              );
            } else if (costed && !reserveDailySpend(call.name, now())) {
              // ATOMIC DAILY RESERVE at execute (ADR 0031 Decision 5): the
              // authority for the daily cap. A rare concurrent call may have
              // taken the last slot AFTER this call's advisory pre-gate check
              // and approval — the approved call then does not run, and the
              // model gets a budget result (never a silent over-run).
              scopeApplied = 'budget';
              resultContent = JSON.stringify({
                error: 'budget_exceeded',
                guidance:
                  'Not run: this tool\'s daily budget was just used up by another request. Do not retry now.',
              });
              hooks.onEvent({
                type: 'tool_result',
                name: call.name,
                ok: false,
                bytes: 0,
                truncated: false,
                error: 'budget_exceeded: daily limit reached',
              });
            } else {
              // The daily slot is reserved (or the tool is free); count this
              // call against the per-conversation cap (ADR 0030).
              if (costed) session.toolSpend[call.name] = convCount + 1;
              // EGRESS-TIER SEAM (ADR 0028): arguments bound for a tool are
              // redacted at the TOOL's egress tier, not the model's. A
              // bounded destination gets the deterministic Tier-1 floor on
              // every string leaf (no Ollama in this path). The full policy
              // engine (name screens etc.) is ADR 0029, M10c — this milestone
              // ships the floor. A private destination is unreachable in v1:
              // web_fetch is always bounded, and classifyFetchTarget already
              // refused anything private.
              let egressArgs: unknown = parsedArgs;
              // M11 (ADR 0033 Decision 3): an MCP server's real destination is
              // INVISIBLE to us — it may write to disk, spawn a process, or
              // make its own network calls. So a 'strict' server (the default)
              // gets the same deterministic floor a bounded web destination
              // gets, rather than raw plaintext. 'trusted' is user-declared and
              // never inferred: the vault's own server needs the real query,
              // and masking a memory_remember would corrupt what gets stored.
              const mcpStrict =
                mcpServerId !== undefined && getMcpServer(mcpServerId)?.trust !== 'trusted';
              if (mcpStrict || (egressUrl !== null && egressTier === 'bounded')) {
                const masked = await redactJsonLeaves(
                  call.arguments,
                  (leaf) => applyTier1(leaf).text,
                );
                try {
                  egressArgs = JSON.parse(masked) as unknown;
                } catch {
                  egressArgs = parsedArgs; // unreachable: masked is re-serialized JSON
                }
              }
              let toolOut: ToolResult;
              try {
                // What the tool really received, after the egress floor. Kept
                // for the proof only; never logged, never persisted.
                sentArgsJson = JSON.stringify(egressArgs);
                toolOut = await tool.execute(egressArgs, {
                  ...(signal !== undefined ? { signal } : {}),
                  maxResultChars,
                });
              } catch (err) {
                // Tools promise not to throw; if one does anyway, the loop
                // stays alive and the failure is loud in the transcript.
                toolOut = {
                  content: JSON.stringify({
                    error: 'tool_failed',
                    detail: err instanceof Error ? err.message : String(err),
                    guidance: 'The tool failed unexpectedly. Consider a different approach.',
                  }),
                  meta: { bytes: 0, truncated: false, ok: false },
                };
              }
              execMeta = toolOut.meta;
              // Fence SUCCESSFUL tool output (attacker-authored data); our own
              // structured error JSON is not external and stays bare.
              //
              // The trigger is "a tool produced this", NOT "it has an egress
              // URL". Keying on the URL fails OPEN for any tool that egresses
              // somewhere we cannot name — exactly the shape M11's MCP tools
              // take (ADR 0033), where a stdio server has no URL at all. Both
              // tools shipped today always carry one, so this changes nothing
              // now; it means a URL-less tool cannot arrive later and quietly
              // inject unfenced attacker text into the transcript.
              resultContent = toolOut.meta.ok
                ? wrapUntrusted(
                    truncateChars(toolOut.content, maxResultChars),
                    egressUrl ?? toolOut.meta.host ?? call.name,
                    fenceNonce,
                    now,
                  )
                : truncateChars(toolOut.content, maxResultChars);
              // On failure, lift the tool's own {error, guidance} out of the
              // (unfenced) structured error content so the surface can show the
              // user WHY — content-free, never page/query text.
              let errorLine: string | undefined;
              if (!toolOut.meta.ok) {
                try {
                  const parsed = JSON.parse(toolOut.content) as { error?: unknown; guidance?: unknown };
                  const err = typeof parsed.error === 'string' ? parsed.error : undefined;
                  const guide = typeof parsed.guidance === 'string' ? parsed.guidance : undefined;
                  errorLine = [err, guide].filter(Boolean).join(': ') || undefined;
                } catch {
                  errorLine = undefined; // non-JSON content: no structured reason
                }
              }
              hooks.onEvent({
                type: 'tool_result',
                name: call.name,
                ok: toolOut.meta.ok,
                bytes: toolOut.meta.bytes,
                truncated: toolOut.meta.truncated,
                ...(toolOut.meta.host !== undefined ? { host: toolOut.meta.host } : {}),
                ...(errorLine !== undefined ? { error: errorLine } : {}),
              });
            }
          }
        }

        session.plainHistory.push({ role: 'tool', toolCallId: call.id, content: resultContent });
        session.historyTiers.push(0);
        toolCallsMade.push({
          name: call.name,
          ...(egressHost !== undefined ? { host: egressHost } : {}),
          decision,
          // The restored URL that actually left, only for a call that truly
          // EXECUTED (proof of what egressed — ADR 0031 Decision 6). Gated on
          // execMeta, NOT on decision: an approved call that then lost the
          // budget reserve race never ran, so nothing left (G4 review).
          ...(execMeta !== null && egressUrl !== null ? { egress: egressUrl } : {}),
          // An MCP call has no URL to name, so it never appeared in the egress
          // proof — and one auto-allowed by a standing grant showed its
          // arguments NOWHERE afterwards, since the audit keeps only a hash.
          // Record the server and the MASKED arguments it actually received.
          // Ephemeral like the rest of the proof: streamed once, never stored.
          ...(execMeta !== null && mcpServerId !== undefined
            ? { mcpServer: mcpServerId, ...(sentArgsJson !== undefined ? { argsSent: sentArgsJson } : {}) }
            : {}),
        });

        // One content-free audit row PER tool call, denials included
        // (invariant #5-adjacent: hashes and counts, never argument text).
        const toolRow: CallLogEntry = {
          ts: now().toISOString(),
          tool: 'tool_call',
          provider: 'northkeep-converse',
          redaction_tier: effectiveTier,
          params: {},
          ok: decision === 'approved' && (execMeta?.ok ?? false),
          ...(decision !== 'approved' ? { denied: true } : {}),
          ...(egressHost !== undefined ? { endpoint_host: egressHost } : {}),
          ...(egressUrl !== null ? { privacy: egressTier } : {}),
          tool_call: {
            name: call.name,
            ...(egressHost !== undefined ? { domain: egressHost } : {}),
            // An MCP call has no domain, so the audit names the SERVER instead
            // (ADR 0033): a row must always say WHAT was called, not just that
            // something was. The id is our own config value, never model text.
            ...(mcpServerId !== undefined ? { mcp_server: mcpServerId } : {}),
            ...(egressUrl !== null ? { url_hash: sha256(egressUrl) } : {}),
            args_hash: sha256(call.arguments),
            arg_chars: call.arguments.length,
            decision,
            // M10c provenance (ADR 0029 decision 4): scope and content-free
            // screen descriptors — flag kinds, never matched text.
            ...(scopeApplied !== undefined ? { scope: scopeApplied } : {}),
            ...(screenFlags.length > 0
              ? {
                  screen: screenFlags.map(
                    (f) =>
                      `${f.class}${f.kind !== undefined ? `:${f.kind}` : ''}:${f.where}${f.decoded ? ':decoded' : ''}`,
                  ),
                }
              : {}),
            ...(execMeta !== null ? { result_bytes: execMeta.bytes } : {}),
            ok: execMeta?.ok ?? false,
          },
        };
        try {
          auditFn(toolRow);
        } catch {
          // advisory row; enforcement already happened above
        }
      }
    }
  } catch (err) {
    if (!appendedBeyondUser) {
      // Step 1 failed before anything else landed: unwind the pushed user
      // message so a retry does not double it (runTurn parity — it pushes
      // history only after success).
      session.plainHistory.pop();
      session.historyTiers.pop();
    }
    throw err;
  }

  // ---- Finalize: distill ONCE over (user message, final assistant text).
  let memoriesCreated: MemoryEntry[] = [];
  let distillMode: TurnResult['distillMode'] = 'off';
  if (options.distill !== false && stopped !== 'aborted' && finalText.length > 0) {
    const outcome = await distillExchange({
      vault,
      allowedScopes,
      message,
      reply: finalText,
      memoryScope: options.memoryScope ?? 'personal',
      ollama: options.distillOllama ?? null,
      now,
    });
    memoriesCreated = outcome.created;
    distillMode = outcome.mode;
  }

  // Final audit row — the last model call's row, carrying created_ids
  // (same one-row-per-model-call shape as runTurn).
  audit(auditFn, now, {
    ok: true,
    endpointHost,
    model,
    privacy,
    tier: tierAppliedLast,
    allowedScopes,
    message,
    used: used.map((s) => s.entry),
    created: memoriesCreated,
    routeReason: options.routeReason,
  });

  const usage: TokenUsage = {
    inputTokens: usageSteps.reduce((n, u) => n + u.inputTokens, 0),
    outputTokens: usageSteps.reduce((n, u) => n + u.outputTokens, 0),
    estimated: usageSteps.some((u) => u.estimated),
  };
  const catalog = options.catalog ?? loadCatalog();
  const cost = estimateTurnCost(usage, lookupModel(model, catalog));

  // The step-limit stop is VISIBLE in the returned reply (never silent); the
  // marker is result-only — plainHistory keeps the model's actual words.
  const reply =
    stopped === 'step-limit'
      ? `${finalText}${finalText.length > 0 ? '\n\n' : ''}[stopped: step limit]`
      : finalText;

  return {
    reply,
    privacy,
    endpointHost,
    model,
    tierApplied: tierAppliedLast,
    tier2Degraded: tier2DegradedAny,
    redactions: [...redactionSeen.values()],
    memoriesUsed: used.map((s) => ({
      id: s.entry.id,
      type: s.entry.type,
      scope: s.entry.scope,
      content: s.entry.content,
    })),
    memoriesCreated,
    distillMode,
    usage,
    cost,
    steps,
    toolCallsMade,
    stopped,
  };
}
