import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  TurnError,
  classifyEndpoint,
  createAnthropicProvider,
  createOpenAICompatibleProvider,
  createSession,
  getEndpoint,
  getEndpointKey,
  runTurn,
  vaultAdapter,
  type ConverseSession,
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
  endpoint_id?: string;
  message?: string;
  tier?: number;
  scope?: string;
  /** M7a quick-switch: override the endpoint's configured model for this turn. */
  model?: string;
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

  const endpoint = req.endpoint_id ? getEndpoint(req.endpoint_id) : null;
  if (!endpoint) return jsonError(res, 400, 'Unknown endpoint — configure one under Providers.');
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

  evictStaleConversations();
  const sessionId =
    req.session_id && conversations.has(req.session_id) ? req.session_id : randomUUID();
  const stored = conversations.get(sessionId) ?? { session: createSession(), lastUsed: 0 };
  stored.lastUsed = Date.now();
  conversations.set(sessionId, stored);

  const apiKey = getEndpointKey(endpoint.id) ?? undefined;
  if (endpoint.kind === 'anthropic' && !apiKey) {
    return jsonError(res, 400, 'No API key stored for this Anthropic endpoint.');
  }
  const provider =
    endpoint.kind === 'anthropic'
      ? createAnthropicProvider({ apiKey: apiKey as string, baseUrl: endpoint.baseUrl })
      : createOpenAICompatibleProvider({ baseUrl: endpoint.baseUrl, apiKey });
  const { tier: privacy, host } = classifyEndpoint(endpoint.baseUrl);
  const model = modelOverride || endpoint.model;

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  send(res, { type: 'start', session_id: sessionId, privacy, endpoint_host: host, model });

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
      onToken: (token) => send(res, { type: 'token', text: token }),
    });
    send(res, {
      type: 'done',
      session_id: sessionId,
      reply: result.reply,
      privacy: result.privacy,
      endpoint_host: result.endpointHost,
      model: result.model,
      tier_applied: result.tierApplied,
      tier2_degraded: result.tier2Degraded,
      distill_mode: result.distillMode,
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
