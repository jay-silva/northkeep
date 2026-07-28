import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  RouteError,
  TurnError,
  classifyEndpoint,
  compareTurnCost,
  createAnthropicProvider,
  createOpenAICompatibleProvider,
  createPermissionEngine,
  createSession,
  collectMcpTools,
  enabledTools,
  type McpCollection,
  getDefaultEndpoint,
  getEndpoint,
  getEndpointKey,
  listEndpoints,
  loadRoutingPolicy,
  route,
  runTask,
  runTurn,
  suggestBetterModel,
  vaultAdapter,
  type ApprovalAnswer,
  type ApprovalRequest,
  type ConverseSession,
  type PermissionEngine,
  type PrivacyCeiling,
  type TaskEvent,
  type TaskHooks,
  type TaskResult,
  type ToolDefinition,
  type TurnOptions,
  type TurnResult,
} from '@northkeep/converse';
import { createOllamaClient } from '@northkeep/librarian';

import type { UiSession } from './session.js';

/**
 * Auto-distilled Converse memories are diverted here when the chat's scope is
 * shared to the connector. A shared scope syncs off-machine, and distillation
 * can mis-extract third-party content the user pasted (e.g. a patient report),
 * so nothing auto-created is ever allowed to land silently in a shared scope —
 * it goes to this private holding scope for the user to review and promote
 * deliberately (Jay's call, 2026-07-17). Never auto-shared.
 */
const DISTILL_INBOX_SCOPE = 'inbox';

/**
 * The Converse streaming route (M6, ADR 0007). POST /api/converse answers
 * with NDJSON: {type:'start'} → {type:'token'}* → {type:'done'} | {type:'error'}.
 * Tokens arrive in wire space (masks/pseudonyms intact — that is literally
 * what the model is seeing); 'done' carries the locally-restored reply and
 * the turn's provenance for the transparency strip.
 *
 * Conversation state (wire history + pseudonym map) lives only in this
 * process's memory, keyed by a random session id, and is evicted after
 * idle TTL — plaintext replacement maps must not linger.
 */

const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 32_000;

interface StoredConversation {
  session: ConverseSession;
  lastUsed: number;
  /**
   * The conversation's privacy ceiling RATCHETS server-side (ADR 0011: the
   * ceiling is a property of the conversation, not of a request): once
   * pinned, a request that omits the field keeps the pin — unpinning takes an
   * explicit 'bounded-allowed', which is the deliberate act the ADR requires.
   */
  ceiling: PrivacyCeiling;
  /**
   * ONE permission engine per conversation (ADR 0031 Decision 4 / ADR 0029
   * requirement): a shared engine would let a "this session" grant in one
   * conversation silently auto-allow in another. Persisted so "always" grants
   * survive; created lazily on the first tool-enabled turn.
   */
  gate?: PermissionEngine;
}

const conversations = new Map<string, StoredConversation>();

function evictStaleConversations(): void {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - conv.lastUsed > SESSION_TTL_MS) conversations.delete(id);
  }
}

/**
 * Pending tool-approval requests awaiting a browser decision (ADR 0031). Keyed
 * by an unguessable single-use approval_id. The map entry — not the promise —
 * is the settle guard: whichever of {approve POST, runTask's 5-min timeout,
 * stream abort} fires first DELETES the entry; the others find it gone and
 * no-op (a second approve POST 404s). `sessionId` binds the approval to the
 * conversation that issued it, so one conversation can never resolve another's.
 */
interface PendingApproval {
  sessionId: string;
  resolve: (answer: ApprovalAnswer) => void;
  /** Deletes the entry and denies if no one answers — so ENTRY DELETION is the
   * single-settle guard on the timeout path too (ADR 0031 Decision 3), not
   * just on approve/abort. Cleared when another path settles first. */
  timer: NodeJS.Timeout;
}
const pendingApprovals = new Map<string, PendingApproval>();

/**
 * How long an approval waits before it self-denies (ADR 0031). Matches the
 * value passed to runTask below, so the converse-layer timer (which deletes
 * the map entry) and runTask's internal backstop fire together — a late
 * approve for a timed-out id then 404s, as the spec's single-settle promises.
 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** The default 5-min timeout, or a test-only shortened one. */
function approvalTimeoutFor(testOptions?: ConverseTestOptions): number {
  return testOptions?.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
}

/** Settle a pending approval exactly once (delete-then-resolve). */
function settleApproval(approvalId: string, answer: ApprovalAnswer): boolean {
  const entry = pendingApprovals.get(approvalId);
  if (entry === undefined) return false;
  clearTimeout(entry.timer);
  pendingApprovals.delete(approvalId);
  entry.resolve(answer);
  return true;
}

/** Drop a pending approval without resolving (abort sweep): clear its timer
 * so no orphaned self-deny fires, then delete. runTask has already moved on
 * via the abort signal, so the promise is intentionally left unresolved. */
function sweepApproval(approvalId: string): void {
  const entry = pendingApprovals.get(approvalId);
  if (entry === undefined) return;
  clearTimeout(entry.timer);
  pendingApprovals.delete(approvalId);
}

interface ConverseRequest {
  session_id?: string;
  /** An endpoint id, or 'auto' to let the concierge route this turn (M7b). */
  endpoint_id?: string;
  message?: string;
  tier?: number;
  scope?: string;
  /** M7a quick-switch: override the endpoint's configured model for this turn. */
  model?: string;
  /** Per-conversation privacy ceiling (M7b). Default: bounded-allowed. */
  ceiling?: string;
  /** Opt IN to the agent tools for this turn (M10e) — mirrors CLI --tools.
   * Runs runTask (the tool loop) instead of runTurn; registry-enabled tools
   * only, every call gated by the approval prompt. */
  tools?: boolean;
}

/**
 * Model ids across runtimes: "llama3.2:3b", "claude-opus-4-8", "org/model".
 * `..` is rejected outright — no current code builds paths from a model id,
 * but a traversal-shaped id must never survive validation (defense in depth).
 */
const MODEL_ID_RE = /^[\w.:/-]{1,128}$/;
const validModelId = (id: string): boolean => MODEL_ID_RE.test(id) && !id.includes('..');

/**
 * TEST-ONLY seam. Production (server.ts) never passes it, so the tools come
 * from the registry (enabledTools). Tests inject a tool built with the net
 * test-overrides (a loopback fake), because the registry constructs the real
 * SSRF-guarded tool which cannot reach a local fixture.
 */
export interface ConverseTestOptions {
  toolsOverride?: ToolDefinition[];
  /** TEST-ONLY: shorten the 5-minute approval timeout so the timeout path is
   * testable in ms. Production never sets it. */
  approvalTimeoutMs?: number;
}

export async function handleConverseStream(
  uiSession: UiSession,
  body: Buffer,
  res: ServerResponse,
  testOptions?: ConverseTestOptions,
): Promise<void> {
  let req: ConverseRequest;
  try {
    req = JSON.parse(body.toString('utf8')) as ConverseRequest;
  } catch {
    jsonError(res, 400, 'Invalid JSON body.');
    return;
  }
  const message = typeof req.message === 'string' ? req.message.trim() : '';
  if (message.length === 0) return jsonError(res, 400, 'A message is required.');
  if (message.length > MAX_MESSAGE_CHARS) return jsonError(res, 413, 'Message too long.');
  if (!uiSession.isUnlocked()) return jsonError(res, 423, 'Vault is locked.');

  // The ceiling is load-bearing: an unrecognized value must be a LOUD 400,
  // never a silent fail-open to bounded (adversarial review M-2).
  if (req.ceiling !== undefined && req.ceiling !== 'private-only' && req.ceiling !== 'bounded-allowed') {
    return jsonError(res, 400, "ceiling must be 'private-only' or 'bounded-allowed'.");
  }

  // Resolve the conversation FIRST: the ceiling is a property of the
  // conversation and RATCHETS (adversarial review M-3) — an explicit value
  // sets it; an omitted field keeps whatever the conversation already has.
  evictStaleConversations();
  const sessionId =
    req.session_id && conversations.has(req.session_id) ? req.session_id : randomUUID();
  const stored =
    conversations.get(sessionId) ??
    ({ session: createSession(), lastUsed: 0, ceiling: 'bounded-allowed' } as StoredConversation);
  stored.lastUsed = Date.now();
  conversations.set(sessionId, stored);
  if (req.ceiling !== undefined) stored.ceiling = req.ceiling as PrivacyCeiling;
  const ceiling = stored.ceiling;

  // Resolve the endpoint: explicit id, or 'auto' → the concierge picks (M7b).
  // Routing happens strictly BEFORE the turn; the send path is unchanged.
  let routeReason: string | undefined;
  let routedModel: string | undefined;
  let endpoint = null;
  if (req.endpoint_id === 'auto') {
    try {
      const decision = route({
        message,
        endpoints: listEndpoints(),
        policy: loadRoutingPolicy(),
        ceiling,
        defaultEndpointId: getDefaultEndpoint()?.id ?? null,
      });
      endpoint = getEndpoint(decision.endpointId);
      routedModel = decision.model;
      routeReason = decision.reason;
    } catch (err) {
      return jsonError(res, 400, err instanceof RouteError ? err.message : 'Routing failed.');
    }
  } else {
    endpoint = req.endpoint_id ? getEndpoint(req.endpoint_id) : null;
  }
  if (!endpoint) return jsonError(res, 400, 'Unknown endpoint — configure one under Providers.');

  // A pinned-private conversation may not reach a bounded endpoint by ANY
  // path — the pin is a promise, and it binds manual picks too (a user who
  // wants to escalate unpins first, which is the explicit act ADR 0011 asks).
  if (ceiling === 'private-only' && classifyEndpoint(endpoint.baseUrl).tier !== 'private') {
    return jsonError(
      res,
      400,
      'This conversation is pinned private — that endpoint would leave the machine. Unpin to use it.',
    );
  }
  const tier =
    req.tier === 0 || req.tier === 1 || req.tier === 2 || req.tier === 3 ? req.tier : 1;
  const scope = (req.scope ?? 'personal').trim() || 'personal';
  if (!/^[a-z0-9:_.-]{1,64}$/i.test(scope)) return jsonError(res, 400, 'Invalid scope.');
  // Per-turn model override (M7a). Switching model/endpoint mid-conversation is
  // safe by design: history is plaintext and the WHOLE prompt is re-redacted at
  // the new endpoint's effective tier on every turn (ADR 0007).
  const modelOverride = typeof req.model === 'string' ? req.model.trim() : '';
  if (modelOverride && !validModelId(modelOverride)) {
    return jsonError(res, 400, 'Invalid model id.');
  }
  // Under auto the concierge owns the model choice — a rider override would
  // make route_reason lie about what was asked for (review INFO).
  if (modelOverride && req.endpoint_id === 'auto') {
    return jsonError(res, 400, 'model cannot be combined with endpoint_id "auto".');
  }

  const apiKey = getEndpointKey(endpoint.id) ?? undefined;
  if (endpoint.kind === 'anthropic' && !apiKey) {
    return jsonError(res, 400, 'No API key stored for this Anthropic endpoint.');
  }
  const baseProvider =
    endpoint.kind === 'anthropic'
      ? createAnthropicProvider({ apiKey: apiKey as string, baseUrl: endpoint.baseUrl })
      : createOpenAICompatibleProvider({ baseUrl: endpoint.baseUrl, apiKey });
  // "What was sent" proof: snapshot the EXACT messages handed to the provider —
  // this is the post-redaction wire prompt (masks/pseudonyms already applied).
  // Body only: the API key rides in headers INSIDE baseProvider and never
  // appears here. Kept in memory for this turn's 'done' event only; it is NEVER
  // written to the content-free call log (invariant #5).
  //
  // M10b widening (M10a review carry-forward): when a tool-bearing wire goes
  // out, the snapshot captures the assistant `toolCalls` (RAW argument JSON —
  // arguments egress exactly like content), each tool result's `toolCallId`,
  // and the `tools` array offered to the model. The "what left this device"
  // proof must never under-report what actually left.
  interface SentWireMessage {
    role: string;
    content: string;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    toolCallId?: string;
  }
  let sentWire: SentWireMessage[] | null = null;
  let sentTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> | null =
    null;
  // Snapshot lives on chatTurn — the one wire path (M10a: every provider's
  // chat() is a thin wrapper over chatTurn, and the agent loop calls
  // chatTurn directly). The proxy's chat() routes through THIS wrapper (not
  // baseProvider.chat, whose delegation would reach the base's own chatTurn
  // and skip the snapshot), so both entry points are covered by one capture.
  const chatTurnCapturing = (
    messages: Parameters<typeof baseProvider.chatTurn>[0],
    options: Parameters<typeof baseProvider.chatTurn>[1],
  ) => {
    sentWire = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCalls !== undefined && m.toolCalls.length > 0
        ? { toolCalls: m.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) }
        : {}),
      ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
    }));
    sentTools =
      options.tools !== undefined && options.tools.length > 0
        ? options.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          }))
        : null;
    return baseProvider.chatTurn(messages, options);
  };
  const provider = {
    kind: baseProvider.kind,
    baseUrl: baseProvider.baseUrl,
    listModels: () => baseProvider.listModels(),
    chatTurn: chatTurnCapturing,
    chat: (
      messages: Parameters<typeof baseProvider.chat>[0],
      options: Parameters<typeof baseProvider.chat>[1],
    ) => chatTurnCapturing(messages, options).then((r) => r.text),
  } as typeof baseProvider;
  const { tier: privacy, host } = classifyEndpoint(endpoint.baseUrl);
  const model = modelOverride || routedModel || endpoint.model;

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  send(res, {
    type: 'start',
    session_id: sessionId,
    privacy,
    endpoint_host: host,
    model,
    ...(routeReason ? { route_reason: routeReason, endpoint_label: endpoint.label } : {}),
  });

  // --- Agent tools (M10e, ADR 0031). Opt-in per turn; registry-enabled tools
  // only. Nothing here runs unless the request set tools:true.
  const wantsTools = req.tools === true;
  // Registry tools are synchronous; MCP servers are child processes we must
  // connect and later reap, so they are gathered below once the stream is open
  // (a failing server should be reported IN the transcript, not as a 500).
  const taskTools: ToolDefinition[] = wantsTools
    ? (testOptions?.toolsOverride ?? enabledTools())
    : [];
  let mcp: McpCollection | null = null;
  const approvalTimeoutMs = approvalTimeoutFor(testOptions);
  // AbortController wired to the response: if the browser disconnects mid-turn
  // (navigate away / reload), abort the loop AND sweep this turn's pending
  // approvals so no resolver leaks (ADR 0031 Decision 3).
  const controller = new AbortController();
  const localApprovalIds = new Set<string>();
  let responseComplete = false;
  res.on('close', () => {
    if (!responseComplete) controller.abort();
    for (const id of localApprovalIds) sweepApproval(id);
  });

  // M11 (ADR 0033): configured MCP servers contribute namespaced tools. Only
  // when the caller did not inject tools (tests) and only when tools are on.
  if (wantsTools && testOptions?.toolsOverride === undefined) {
    mcp = await collectMcpTools({ signal: controller.signal });
    taskTools.push(...mcp.tools);
    // Degrade LOUDLY (invariant #6): a server that is unreviewed, changed, or
    // unreachable contributes nothing, and the user must see why rather than
    // wonder why the model ignored a tool.
    for (const u of mcp.unavailable) {
      send(res, {
        type: 'tool_notice',
        server: u.serverId,
        message: u.reason,
        ...(u.detail !== undefined ? { detail: u.detail } : {}),
        needs_review: u.needsReview,
      });
    }
    for (const s2 of mcp.skipped) {
      send(res, {
        type: 'tool_notice',
        server: s2.serverId,
        message: `Ignored ${s2.reasons.length} tool definition(s) this server offered: ${s2.reasons.join('; ')}`,
        needs_review: false,
      });
    }
  }

  // The per-conversation permission engine (ADR 0031 Decision 4). Created once
  // and reused across this conversation's turns so "this session" grants last
  // the conversation — never shared with another conversation.
  if (wantsTools && stored.gate === undefined) {
    stored.gate = createPermissionEngine({ persist: true });
  }

  const taskHooks: TaskHooks = {
    onEvent: (e: TaskEvent) => {
      if (e.type === 'step') {
        if (e.n > 1) send(res, { type: 'tool_step', n: e.n });
      } else if (e.type === 'tool_call') {
        send(res, {
          type: 'tool_call',
          name: e.name,
          ...(e.host !== undefined ? { host: e.host } : {}),
          ...(e.egressTier !== undefined ? { egress_tier: e.egressTier } : {}),
        });
      } else if (e.type === 'permission') {
        send(res, {
          type: 'permission',
          name: e.name,
          decision: e.decision,
          ...(e.via !== undefined ? { via: e.via } : {}),
          ...(e.reasons !== undefined ? { reasons: e.reasons } : {}),
        });
      } else if (e.type === 'tool_result') {
        send(res, {
          type: 'tool_result',
          name: e.name,
          ok: e.ok,
          bytes: e.bytes,
          truncated: e.truncated,
          ...(e.host !== undefined ? { host: e.host } : {}),
          ...(e.error !== undefined ? { error: e.error } : {}),
        });
      }
    },
    requestApproval: (approvalReq: ApprovalRequest): Promise<ApprovalAnswer> => {
      const approvalId = randomUUID();
      // Show the query for web_search (never the raw Brave URL/token); the raw
      // restored args otherwise. argsPlain is what the CLI gate shows too.
      let query: string | null = null;
      try {
        const parsed = JSON.parse(approvalReq.argsPlain) as { query?: unknown };
        if (typeof parsed.query === 'string') query = parsed.query;
      } catch {
        query = null;
      }
      // ADR 0033 Decision 4: an ALLOW scope needs a subject and a clean
      // safe-read call; a NEVER is offered for anything with a subject.
      const hasSubject = approvalReq.egress !== null || approvalReq.server !== undefined;
      const offerScopes =
        hasSubject && approvalReq.risk === 'safe-read' && approvalReq.warnings.length === 0;
      const offerNever = hasSubject;
      return new Promise<ApprovalAnswer>((resolve) => {
        // Self-deny by DELETION on timeout so a late approve 404s (Decision 3);
        // unref so a pending prompt never keeps the process alive.
        const timer = setTimeout(() => settleApproval(approvalId, 'deny'), approvalTimeoutMs);
        timer.unref();
        pendingApprovals.set(approvalId, { sessionId, resolve, timer });
        localApprovalIds.add(approvalId);
        send(res, {
          type: 'approval_request',
          approval_id: approvalId,
          tool: approvalReq.tool,
          ...(approvalReq.tool === 'web_search' && query !== null
            ? { query }
            : { args_plain: approvalReq.argsPlain }),
          egress: approvalReq.egress,
          risk: approvalReq.risk,
          warnings: approvalReq.warnings,
          offer_scopes: offerScopes,
          offer_never: offerNever,
          ...(approvalReq.server !== undefined ? { mcp_server: approvalReq.server } : {}),
          // Remote servers only. Its absence says nothing left the machine.
          ...(approvalReq.serverOrigin !== undefined ? { mcp_origin: approvalReq.serverOrigin } : {}),
        });
      });
    },
  };

  const ollama = createOllamaClient();
  const distillOllama = (await ollama.available().catch(() => false)) ? ollama : null;

  // Containment (PHI): never let auto-distillation write into a scope that is
  // shared to the connector. If the chat's scope is shared, divert new memories
  // to the private inbox; if even the inbox is shared, skip distillation rather
  // than leak. Everything the model was ASKED about still flows normally — only
  // the auto-created memory target is contained.
  //
  // The shared list lives in the vault (ADR 0038). A conversation always has
  // the vault open (retrieval needs it), so this read is authoritative; if it
  // fails anyway, fail CLOSED — treat every scope as shared and skip
  // distillation — because guessing "not shared" is the leak direction.
  const sharedScopes = await uiSession
    .withVault((vault) => new Set(vault.sharedScopes()))
    .catch(() => new Set([scope, DISTILL_INBOX_SCOPE]));
  let distillScope = scope;
  let distillDiverted = false;
  let distillSkipped = false;
  // An attached file is a document the user is working WITH (a report, a
  // patient record), not facts about the user — never auto-memorize it. The
  // composer prepends this exact marker.
  if (/^\[Attached file: /.test(message)) {
    distillSkipped = true;
  } else if (sharedScopes.has(scope)) {
    if (!sharedScopes.has(DISTILL_INBOX_SCOPE)) {
      distillScope = DISTILL_INBOX_SCOPE;
      distillDiverted = true;
    } else {
      distillSkipped = true;
    }
  }

  try {
    const turnArgs: TurnOptions = {
      message,
      session: stored.session,
      provider,
      model,
      vault: vaultAdapter((fn) => uiSession.withVault(fn)),
      redactTier: tier,
      memoryScope: distillScope,
      distill: !distillSkipped,
      distillOllama,
      ...(routeReason !== undefined ? { routeReason } : {}),
      onToken: (token: string) => send(res, { type: 'token', text: token }),
    };
    // --tools rides runTask (the agent loop); otherwise the exact runTurn path.
    let taskResult: TaskResult | null = null;
    let result: TurnResult;
    if (taskTools.length > 0) {
      taskResult = await runTask({
        ...turnArgs,
        tools: taskTools,
        hooks: taskHooks,
        // ADR 0035 Decision 3 (option B): a private-pinned conversation
        // refuses remote MCP tools. Web tools still ask and still work.
        ceiling,
        ...(stored.gate !== undefined ? { gate: stored.gate } : {}),
        signal: controller.signal,
        // Same value the converse-layer timer uses, so the two settle together.
        approvalTimeoutMs,
      });
      result = taskResult;
    } else {
      result = await runTurn(turnArgs);
    }
    // The "what left this device" proof for a tool turn: the restored URLs/
    // queries that actually egressed (ADR 0031 Decision 6). Content, like
    // `sent` — never the token, streamed once, never persisted.
    const toolEgress = (taskResult?.toolCallsMade ?? [])
      .filter((c) => c.egress !== undefined || c.argsSent !== undefined)
      .map((c) => ({
        name: c.name,
        ...(c.host !== undefined ? { host: c.host } : {}),
        ...(c.egress !== undefined ? { url: c.egress } : {}),
        // An MCP call names its server and shows the masked arguments it sent,
        // since it has no URL to name and may have been auto-allowed by a
        // standing grant, in which case no prompt ever displayed them.
        ...(c.mcpServer !== undefined ? { mcp_server: c.mcpServer } : {}),
        ...(c.mcpOrigin !== undefined ? { mcp_origin: c.mcpOrigin } : {}),
        ...(c.argsSent !== undefined ? { args_sent: c.argsSent } : {}),
      }));
    // Concierge tip (M9d): a stronger model the user hasn't connected would
    // suit this message better. PURELY advisory — isolated in its own try so a
    // fault here can never turn a successful turn into an error response.
    let suggestion: string | undefined;
    try {
      suggestion = suggestBetterModel(message, listEndpoints())?.reason;
    } catch {
      suggestion = undefined;
    }
    send(res, {
      type: 'done',
      session_id: sessionId,
      ...(routeReason ? { route_reason: routeReason, endpoint_label: endpoint.label } : {}),
      ...(suggestion ? { suggestion } : {}),
      // Distill containment (PHI): tell the UI when a memory was kept out of the
      // shared scope so it can say so instead of silently relocating it.
      ...(distillDiverted ? { distill_diverted: true, distill_scope: distillScope, requested_scope: scope } : {}),
      ...(distillSkipped ? { distill_skipped: true } : {}),
      // Ephemeral privacy proof: exactly what left the machine this turn,
      // redacted (masks visible), plus the list of what was masked (real →
      // placeholder). Streamed once; never persisted (the call log is content-free).
      // M10b: includes toolCalls/toolCallId on messages and the offered tools
      // array whenever a tool-bearing wire went out (never under-report).
      ...(sentWire ? { sent: sentWire } : {}),
      ...(sentTools ? { sent_tools: sentTools } : {}),
      ...(toolEgress.length > 0 ? { tool_egress: toolEgress } : {}),
      redactions: result.redactions,
      reply: result.reply,
      privacy: result.privacy,
      endpoint_host: result.endpointHost,
      model: result.model,
      tier_applied: result.tierApplied,
      tier2_degraded: result.tier2Degraded,
      distill_mode: result.distillMode,
      // Approximate, on-device cost of this turn + what your other connected
      // models would have cost (cheapest-first). Pure local computation.
      ...(result.cost ? { cost: result.cost } : {}),
      ...(result.usage ? { cost_compare: compareTurnCost(result.usage, listEndpoints()) } : {}),
      memories_used: result.memoriesUsed,
      memories_created: result.memoriesCreated.map((m) => ({
        id: m.id,
        type: m.type,
        content: m.content,
      })),
    });
  } catch (err) {
    if (err instanceof TurnError) {
      send(res, { type: 'error', code: err.code, message: err.message });
    } else {
      send(res, {
        type: 'error',
        message: err instanceof Error ? err.message : 'The turn failed.',
      });
    }
  } finally {
    // Mark complete BEFORE end so the 'close' handler doesn't read a normal
    // finish as a disconnect-abort. Sweep any stragglers (defensive: runTask
    // settles all approvals before returning, but a throw could skip that).
    responseComplete = true;
    for (const id of localApprovalIds) sweepApproval(id);
    // Stdio MCP servers are child processes owned by THIS turn. Reap them on
    // every exit path — normal finish, throw, or browser disconnect — or the
    // GUI would accumulate orphans holding vault handles.
    if (mcp !== null) await mcp.close().catch(() => {});
    res.end();
  }
}

/**
 * POST /api/converse/approve — the browser's answer to an approval_request
 * (ADR 0031 Decision 2). Auth is enforced by the caller (server.ts: loopback +
 * token, same as every /api call). Returns a small JSON result the server
 * relays. A missing/mismatched approval_id is a 404 the frontend treats as
 * "expired — re-ask", never a bypass: the loop's secret hard-block already ran
 * before this point, so a stale/forged allow can only land on an already-clean
 * or warned call.
 */
export function handleApprove(body: Buffer): { status: number; body: Record<string, unknown> } {
  let req: { session_id?: unknown; approval_id?: unknown; decision?: unknown };
  try {
    req = JSON.parse(body.toString('utf8')) as typeof req;
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body.' } };
  }
  const approvalId = typeof req.approval_id === 'string' ? req.approval_id : '';
  const sessionId = typeof req.session_id === 'string' ? req.session_id : '';
  const decision = typeof req.decision === 'string' ? req.decision : '';
  const VALID: ReadonlySet<string> = new Set([
    'allow',
    'allow-session',
    'allow-always',
    'deny',
    'deny-never',
  ]);
  if (!VALID.has(decision)) {
    return { status: 400, body: { error: 'Invalid decision.' } };
  }
  const entry = pendingApprovals.get(approvalId);
  // Not found OR issued for a different conversation → 404 (single-settle: an
  // already-answered/timed-out/aborted id is gone). Fail closed: the loop's
  // own 5-min timeout still denies an approval nobody ever answers.
  if (entry === undefined || entry.sessionId !== sessionId) {
    return { status: 404, body: { error: 'No pending approval for that id (it may have expired — send again).' } };
  }
  settleApproval(approvalId, decision as ApprovalAnswer);
  return { status: 200, body: { ok: true } };
}

function send(res: ServerResponse, event: Record<string, unknown>): void {
  // The agent loop keeps running until it next checks the abort signal, so a
  // send after the client disconnected would throw write-after-end and crash
  // the handler. Guard every send (ADR 0031 Decision 3).
  if (res.writableEnded) return;
  try {
    res.write(`${JSON.stringify(event)}\n`);
  } catch {
    // socket died between the check and the write — nothing more to do.
  }
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}
