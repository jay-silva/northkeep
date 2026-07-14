import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  RouteError,
  TurnError,
  classifyEndpoint,
  compareTurnCost,
  createAnthropicProvider,
  createOpenAICompatibleProvider,
  createSession,
  getDefaultEndpoint,
  getEndpoint,
  getEndpointKey,
  listEndpoints,
  loadRoutingPolicy,
  route,
  runTurn,
  suggestBetterModel,
  vaultAdapter,
  type ConverseSession,
  type PrivacyCeiling,
} from '@northkeep/converse';
import { createOllamaClient } from '@northkeep/librarian';
import type { UiSession } from './session.js';

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
}

const conversations = new Map<string, StoredConversation>();

function evictStaleConversations(): void {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - conv.lastUsed > SESSION_TTL_MS) conversations.delete(id);
  }
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
}

/**
 * Model ids across runtimes: "llama3.2:3b", "claude-opus-4-8", "org/model".
 * `..` is rejected outright — no current code builds paths from a model id,
 * but a traversal-shaped id must never survive validation (defense in depth).
 */
const MODEL_ID_RE = /^[\w.:/-]{1,128}$/;
const validModelId = (id: string): boolean => MODEL_ID_RE.test(id) && !id.includes('..');

export async function handleConverseStream(
  uiSession: UiSession,
  body: Buffer,
  res: ServerResponse,
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
  const tier = req.tier === 0 || req.tier === 1 || req.tier === 2 ? req.tier : 1;
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
  const provider =
    endpoint.kind === 'anthropic'
      ? createAnthropicProvider({ apiKey: apiKey as string, baseUrl: endpoint.baseUrl })
      : createOpenAICompatibleProvider({ baseUrl: endpoint.baseUrl, apiKey });
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

  const ollama = createOllamaClient();
  const distillOllama = (await ollama.available().catch(() => false)) ? ollama : null;

  try {
    const result = await runTurn({
      message,
      session: stored.session,
      provider,
      model,
      vault: vaultAdapter((fn) => uiSession.withVault(fn)),
      redactTier: tier,
      memoryScope: scope,
      distillOllama,
      routeReason,
      onToken: (token) => send(res, { type: 'token', text: token }),
    });
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
    res.end();
  }
}

function send(res: ServerResponse, event: Record<string, unknown>): void {
  res.write(`${JSON.stringify(event)}\n`);
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}
