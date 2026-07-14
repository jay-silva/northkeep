import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  Vault,
  VaultAuthError,
  deviceSecretPath,
  ensureDeviceSecret,
  isMemoryType,
  MEMORY_TYPES,
  loadDeviceSecret,
  memzero,
  northkeepHome,
  type MemoryType,
} from '@northkeep/core';
import {
  checkoutUrl,
  deriveSyncCreds,
  loadSyncConfig,
  portalUrl,
  pullVault,
  pushVault,
  setSyncServer,
  subscriptionStatus,
  SubscriptionRequiredError,
  syncState,
} from '@northkeep/sync';
import {
  parseChatgptExport,
  parseClaudeExport,
  parsePasteFile,
  type ImportedConversation,
  type MemoryCandidate,
} from '@northkeep/importers';
import { EXTRACT_MODEL, createOllamaClient, createOllamaEmbedder, dedupeCandidates, ollamaState, runImport } from '@northkeep/librarian';
import {
  auditAsCsv,
  claudeCodeAvailable,
  connect,
  connectStatus,
  disconnect,
  keychainAvailable,
  keychainDeleteMasterKey,
  keychainSetMasterKey,
  readCallLog,
  type ConnectTarget,
} from '@northkeep/mcp-server';
import { redact, restore, type Replacement } from '@northkeep/redact';
import {
  addEndpoint,
  EndpointExistsError,
  classifyEndpoint,
  createAnthropicProvider,
  createOpenAICompatibleProvider,
  detectHardware,
  getEndpoint,
  getEndpointKey,
  isRoutingRule,
  KNOWN_PROVIDERS,
  listEndpoints,
  loadRoutingPolicy,
  lookupModel,
  recommendLocalModel,
  removeEndpoint,
  saveRoutingPolicy,
  setDefaultEndpoint,
  getDefaultEndpoint,
} from '@northkeep/converse';
import { LockedError, type UiSession } from './session.js';

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

interface ImportJob {
  id: string;
  createdAt: number;
  source: 'chatgpt' | 'claude' | 'paste';
  status: 'extracting' | 'ready' | 'committed' | 'failed';
  total: number;
  done: number;
  degraded: boolean;
  error?: string;
  candidates: MemoryCandidate[];
  conflicts: Array<{ candidate: string; existing: string }>;
  duplicatesDropped: number;
}

const jobs = new Map<string, ImportJob>();
const JOB_TTL_MS = 30 * 60 * 1000;

/** Evict old jobs so extracted plaintext candidates don't linger in memory. */
function evictStaleJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      job.candidates = [];
      jobs.delete(id);
    }
  }
}

// --- Local-model pull jobs (M9c). Same fire-and-forget + poll shape as the
// import jobs above: POST starts a background Ollama pull, the client polls
// progress, and on success the model is auto-added as a loopback endpoint. No
// secrets flow through these jobs (a local Ollama pull needs no API key).
interface PullJob {
  id: string;
  createdAt: number;
  model: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error?: string;
}
const pullJobs = new Map<string, PullJob>();

function evictStalePullJobs(): void {
  const now = Date.now();
  for (const [id, job] of pullJobs) {
    if (now - job.createdAt > JOB_TTL_MS) pullJobs.delete(id);
  }
}

export interface ApiResponse {
  status: number;
  body: unknown;
  /** When set (e.g. text/csv), body is sent as a raw string, not JSON. */
  contentType?: string;
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

function bad(status: number, message: string): ApiResponse {
  return { status, body: { error: message } };
}

export async function handleApi(
  session: UiSession,
  method: string,
  route: string,
  query: URLSearchParams,
  body: Buffer,
): Promise<ApiResponse> {
  try {
    return await dispatch(session, method, route, query, body);
  } catch (err) {
    if (err instanceof LockedError) return bad(423, 'Vault is locked.');
    if (err instanceof VaultAuthError) return bad(401, err.message);
    if (err instanceof SubscriptionRequiredError)
      return bad(402, 'A $10/month subscription is required to sync on this server.');
    if (err instanceof DeviceSecretError || err instanceof SyncRequestError) return bad(400, err.message);
    return bad(500, err instanceof Error ? err.message : String(err));
  }
}

async function dispatch(
  session: UiSession,
  method: string,
  route: string,
  query: URLSearchParams,
  body: Buffer,
): Promise<ApiResponse> {
  if (method === 'GET' && route === '/api/status') {
    const unlocked = session.isUnlocked();
    let counts: Record<string, number> = {};
    let total = 0;
    if (unlocked) {
      await session.withVault((vault) => {
        for (const entry of vault.list()) {
          counts[entry.type] = (counts[entry.type] ?? 0) + 1;
          total += 1;
        }
      });
    }
    const ollama = await createOllamaClient().available().catch(() => false);
    return ok({
      unlocked,
      total,
      counts,
      // First-run detection (M7d): no vault on disk → the page shows the
      // setup wizard instead of the unlock dialog.
      vault_exists: fs.existsSync(session.vaultPath),
      vault_path: session.vaultPath,
      ollama_available: ollama,
      extract_model: EXTRACT_MODEL,
      keychain_available: keychainAvailable(),
      env_grant: session.hasEnvGrant(),
    });
  }

  // --- First-run setup (M7d). Creates the device secret + vault exactly the
  // way `northkeep init` does, then unlocks the session via the same derive-
  // and-verify path as POST /api/unlock. Refuses when a vault already exists,
  // so this route can never overwrite or re-key anything. The passphrase and
  // derived key are never returned or logged.
  if (method === 'POST' && route === '/api/setup/create') {
    if (fs.existsSync(session.vaultPath)) {
      return bad(409, 'A vault already exists — unlock it instead.');
    }
    const { passphrase, confirm } = parseJson<{ passphrase?: string; confirm?: string }>(body);
    if (typeof passphrase !== 'string' || passphrase.length < 8) {
      return bad(400, 'Passphrase must be at least 8 characters.');
    }
    if (confirm !== undefined && confirm !== passphrase) {
      return bad(400, 'Passphrases do not match.');
    }
    const { secret, created } = ensureDeviceSecret();
    Vault.create({ path: session.vaultPath, passphrase, deviceSecret: secret }).close();
    await session.unlock(passphrase);
    return ok({
      created: true,
      unlocked: true,
      vault_path: session.vaultPath,
      device_secret_path: deviceSecretPath(),
      device_secret_created: created,
    });
  }

  if (method === 'POST' && route === '/api/unlock') {
    const { passphrase, remember } = parseJson<{ passphrase?: string; remember?: boolean }>(body);
    if (!passphrase) return bad(400, 'Passphrase required.');
    await session.unlock(passphrase);
    if (remember === true && keychainAvailable()) {
      keychainSetMasterKey(session.keyHex());
    }
    return ok({ unlocked: true });
  }

  if (method === 'POST' && route === '/api/lock') {
    const { forgetKeychain } = parseJson<{ forgetKeychain?: boolean }>(body);
    session.lock();
    let keychainCleared = false;
    if (forgetKeychain === true && keychainAvailable()) {
      keychainCleared = keychainDeleteMasterKey() === 'removed';
    }
    // Report the TRUE post-lock state, not a hardcoded value. An env-var grant
    // the in-app lock cannot revoke keeps the vault open — say so.
    return ok({ unlocked: session.isUnlocked(), keychainCleared, envGrant: session.hasEnvGrant() });
  }

  if (method === 'GET' && route === '/api/memories') {
    const q = query.get('q')?.trim() ?? '';
    const typeParam = query.get('type') ?? undefined;
    const type = typeParam && isMemoryType(typeParam) ? (typeParam as MemoryType) : undefined;
    const scope = query.get('scope') ?? undefined;
    return ok(
      await session.withVault(async (vault) => {
        if (q.length > 0) {
          // Semantic search when the local embedder is up; retrieveSemantic
          // degrades to keyword on its own and tells us which happened, so the
          // UI can say so (invariant #6 — never silently worse).
          const r = await vault.retrieveSemantic(q, createOllamaEmbedder(), {
            type,
            scope,
            limit: 50,
          });
          return {
            search_mode: r.mode,
            ...(r.mode === 'keyword' ? { semantic_reason: r.reason } : {}),
            memories: r.results.map((s) => ({
              ...publicEntry(s.entry),
              relevance: Number(s.score.toFixed(3)),
            })),
          };
        }
        return { memories: vault.list({ type, scope }).map(publicEntry).reverse() };
      }),
    );
  }

  // Add a memory straight from the GUI. Scope is an EXPLICIT label the user
  // sets here — never inferred — so it's validated against the same charset the
  // import/converse routes use. Requires the vault unlocked (withVault throws
  // LockedError → 423). source is 'manual' to distinguish it from cli/import.
  if (method === 'POST' && route === '/api/memories') {
    const { content, type, scope } = parseJson<{ content?: string; type?: string; scope?: string }>(body);
    const trimmed = typeof content === 'string' ? content.trim() : '';
    if (trimmed.length === 0) return bad(400, 'Memory content must not be empty.');
    if (trimmed.length > 8000) return bad(400, 'Memory content is too long (8000 characters max).');
    if (typeof type !== 'string' || !isMemoryType(type)) {
      return bad(400, `type must be one of: ${MEMORY_TYPES.join(', ')}.`);
    }
    const targetScope = (scope ?? 'personal').trim() || 'personal';
    if (!/^[a-z0-9:_.-]{1,64}$/i.test(targetScope)) return bad(400, 'Invalid scope.');
    return ok(
      await session.withVault((vault) => {
        const entry = vault.remember({
          content: trimmed,
          type,
          scope: targetScope,
          source: 'manual',
          sourceModel: null,
          confidence: 1.0,
        });
        vault.save();
        return { memory: publicEntry(entry) };
      }),
    );
  }

  if (method === 'GET' && route === '/api/scopes') {
    return ok(
      await session.withVault((vault) => {
        const scopes = new Set<string>();
        for (const entry of vault.list()) scopes.add(entry.scope);
        return { scopes: [...scopes].sort() };
      }),
    );
  }

  if (method === 'POST' && route === '/api/forget') {
    const { id } = parseJson<{ id?: string }>(body);
    if (!id || !/^[0-9a-f-]{8,36}$/i.test(id)) return bad(400, 'A memory id is required.');
    return ok(
      await session.withVault((vault) => {
        const tombstone = vault.forget(id);
        vault.save();
        return { forgotten: tombstone.id, forgotten_at: tombstone.forgotten_at };
      }),
    );
  }

  // Edit a memory's scope. The vault is append-only, so this supersedes the
  // entry with a copy in the new scope rather than mutating it in place — the
  // new memory carries a new id, which the client swaps in. Scope is validated
  // against the same charset as add/import.
  if (method === 'POST' && route === '/api/memories/rescope') {
    const { id, scope } = parseJson<{ id?: string; scope?: string }>(body);
    if (!id || !/^[0-9a-f-]{8,36}$/i.test(id)) return bad(400, 'A memory id is required.');
    const targetScope = typeof scope === 'string' ? scope.trim() : '';
    if (!/^[a-z0-9:_.-]{1,64}$/i.test(targetScope)) return bad(400, 'Invalid scope.');
    return ok(
      await session.withVault((vault) => {
        const moved = vault.rescope(id, targetScope);
        vault.save();
        return { memory: publicEntry(moved) };
      }),
    );
  }

  // Edit a memory's content / scope / type. Append-only supersession (like
  // rescope) — the edited memory carries a new id, which the client swaps in.
  // Send only the fields to change.
  if (method === 'POST' && route === '/api/memories/edit') {
    const { id, content, scope, type } = parseJson<{
      id?: string;
      content?: string;
      scope?: string;
      type?: string;
    }>(body);
    if (!id || !/^[0-9a-f-]{8,36}$/i.test(id)) return bad(400, 'A memory id is required.');
    const patch: { content?: string; scope?: string; type?: MemoryType } = {};
    if (content !== undefined) {
      const trimmed = typeof content === 'string' ? content.trim() : '';
      if (trimmed.length === 0) return bad(400, 'Memory content must not be empty.');
      if (trimmed.length > 8000) return bad(400, 'Memory content is too long (8000 characters max).');
      patch.content = trimmed;
    }
    if (scope !== undefined) {
      const s = typeof scope === 'string' ? scope.trim() : '';
      if (!/^[a-z0-9:_.-]{1,64}$/i.test(s)) return bad(400, 'Invalid scope.');
      patch.scope = s;
    }
    if (type !== undefined) {
      if (typeof type !== 'string' || !isMemoryType(type)) {
        return bad(400, `type must be one of: ${MEMORY_TYPES.join(', ')}.`);
      }
      patch.type = type;
    }
    if (patch.content === undefined && patch.scope === undefined && patch.type === undefined) {
      return bad(400, 'Provide at least one of content, scope, or type to edit.');
    }
    return ok(
      await session.withVault((vault) => {
        const edited = vault.editMemory(id, patch);
        vault.save();
        return { memory: publicEntry(edited) };
      }),
    );
  }

  if (method === 'GET' && route === '/api/log') {
    return ok({ calls: readCallLog(200).reverse() });
  }

  if (method === 'GET' && route === '/api/audit.csv') {
    return { status: 200, body: auditAsCsv(), contentType: 'text/csv' };
  }

  // Redaction is stateless and doesn't touch the vault — no unlock required.
  if (method === 'POST' && route === '/api/redact') {
    const { text, tier } = parseJson<{ text?: string; tier?: number }>(body);
    if (typeof text !== 'string' || text.length === 0) return bad(400, 'Text required.');
    if (text.length > 100_000) return bad(413, 'Text too large (100 KB max).');
    const result = await redact(text, { tier: tier === 2 ? 2 : 1 });
    return ok(result);
  }

  if (method === 'POST' && route === '/api/restore') {
    const { text, replacements } = parseJson<{ text?: string; replacements?: Replacement[] }>(body);
    if (typeof text !== 'string') return bad(400, 'Text required.');
    if (!Array.isArray(replacements)) return bad(400, 'replacements required.');
    return ok({ restored: restore(text, replacements) });
  }

  if (method === 'GET' && route === '/api/export') {
    const doc = await session.withVault((vault) => {
      const chain = vault.verifyChain();
      if (!chain.ok) throw new Error(`Refusing to export a broken chain: ${chain.error}`);
      return vault.export();
    });
    return ok(doc);
  }

  // --- Sync (M5). Outbound runs here in Node (the page CSP is connect-src
  // 'self'). The sync token is derived from the device secret on demand and
  // NEVER returned; the server only ever receives ciphertext. ---

  if (method === 'GET' && route === '/api/sync/status') {
    const deviceSecret = deviceSecretOrError();
    const config = loadSyncConfig();
    if (!config) return ok({ configured: false });
    const s = await syncState({ vaultPath: session.vaultPath, deviceSecret });
    return ok({ configured: true, server_url: config.serverUrl, ...s });
  }

  if (method === 'POST' && route === '/api/sync/config') {
    const { server_url } = parseJson<{ server_url?: string }>(body);
    if (!server_url?.trim()) return bad(400, 'server_url is required.');
    const deviceSecret = deviceSecretOrError();
    const { accountId } = deriveSyncCreds(deviceSecret);
    let config;
    try {
      config = setSyncServer(server_url, accountId); // throws on non-https/non-loopback
    } catch (err) {
      throw new SyncRequestError(err instanceof Error ? err.message : 'Invalid sync server URL.');
    }
    return ok({ server_url: config.serverUrl, account_id: accountId });
  }

  if (method === 'POST' && route === '/api/sync/push') {
    const deviceSecret = deviceSecretOrError();
    if (!loadSyncConfig()) return bad(400, 'Sync is not configured.');
    const result = await pushVault({ vaultPath: session.vaultPath, deviceSecret });
    return ok(result);
  }

  if (method === 'POST' && route === '/api/sync/pull') {
    const deviceSecret = deviceSecretOrError();
    if (!loadSyncConfig()) return bad(400, 'Sync is not configured.');
    // A local vault always exists here → the pulled blob must open with the
    // held key before it can replace it, so the session must be unlocked.
    if (!session.isUnlocked()) return bad(423, 'Unlock the vault before pulling (needed to verify the download).');
    const masterKey = Buffer.from(session.keyHex(), 'hex');
    try {
      const result = await pullVault({ vaultPath: session.vaultPath, deviceSecret, masterKey });
      return ok(result);
    } finally {
      memzero(masterKey);
    }
  }

  // --- Billing (M5b). The web server calls the sync server in Node and returns
  // only the Stripe-hosted URL; the card is entered on Stripe, never here. A
  // server without billing simply reports inactive / errors on checkout. ---

  if (method === 'GET' && route === '/api/sync/subscription') {
    const deviceSecret = deviceSecretOrError();
    if (!loadSyncConfig()) return ok({ configured: false });
    try {
      const sub = await subscriptionStatus({ deviceSecret });
      return ok({ configured: true, ...sub });
    } catch {
      // Older/self-hosted servers may not expose the endpoint → billing off.
      return ok({ configured: true, billing: false, active: false, status: 'none', currentPeriodEnd: null });
    }
  }

  if (method === 'POST' && route === '/api/sync/subscribe') {
    const deviceSecret = deviceSecretOrError();
    if (!loadSyncConfig()) return bad(400, 'Sync is not configured.');
    try {
      const url = await checkoutUrl({ deviceSecret });
      return ok({ url });
    } catch {
      return bad(400, 'This sync server does not offer subscriptions.');
    }
  }

  if (method === 'POST' && route === '/api/sync/billing') {
    const deviceSecret = deviceSecretOrError();
    if (!loadSyncConfig()) return bad(400, 'Sync is not configured.');
    try {
      const url = await portalUrl({ deviceSecret });
      if (!url) return bad(404, 'No subscription found for this account.');
      return ok({ url });
    } catch {
      return bad(400, 'This sync server does not offer subscriptions.');
    }
  }

  // --- Routing policy (M7b). Rules only — no secrets, no content. ---

  if (method === 'GET' && route === '/api/routing') {
    return ok({ rules: loadRoutingPolicy().rules });
  }

  if (method === 'PUT' && route === '/api/routing') {
    const { rules } = parseJson<{ rules?: unknown }>(body);
    if (!Array.isArray(rules)) return bad(400, 'rules must be an array.');
    // routing.json is re-read on every auto turn; keep it small by construction.
    if (rules.length > 100) return bad(400, 'Too many rules (max 100).');
    // Reject anything the loader would silently drop — a 200 must mean every
    // submitted rule is live (isRoutingRule is the SAME validator the loader
    // filters with, so write and read can never disagree). Persist only the
    // known fields; extra keys are not written to disk.
    const endpointIds = new Set(listEndpoints().map((e) => e.id));
    const normalized = [];
    for (const r of rules) {
      if (!isRoutingRule(r)) {
        return bad(400, 'Each rule needs a known task kind, an endpointId, and (optionally) a string model.');
      }
      if (!endpointIds.has(r.endpointId)) {
        return bad(400, `Unknown endpoint in rule: ${r.endpointId}`);
      }
      normalized.push({ task: r.task, endpointId: r.endpointId, ...(r.model ? { model: r.model } : {}) });
    }
    saveRoutingPolicy({ rules: normalized });
    return ok({ rules: loadRoutingPolicy().rules });
  }

  // --- Converse endpoint management (M6). API keys go straight to the
  // Keychain and are NEVER present in any response from these routes. ---

  if (method === 'GET' && route === '/api/providers') {
    return ok({
      endpoints: listEndpoints().map(withBadge),
      default_id: getDefaultEndpoint()?.id ?? null,
    });
  }

  // --- Guided onboarding (M9b). The curated known-provider registry that
  // drives the "Connect a model" wizard. PUBLIC METADATA ONLY — base URLs,
  // key-page links, curated model ids, rough cost tiers. No secrets, no keys.
  if (method === 'GET' && route === '/api/provider-catalog') {
    return ok({ providers: KNOWN_PROVIDERS });
  }

  if (method === 'POST' && route === '/api/providers') {
    const { label, base_url, model, api_key, kind } = parseJson<{
      label?: string;
      base_url?: string;
      model?: string;
      api_key?: string;
      kind?: string;
    }>(body);
    if (!label?.trim() || !base_url?.trim() || !model?.trim()) {
      return bad(400, 'label, base_url, and model are required.');
    }
    if (kind !== undefined && kind !== 'openai-compatible' && kind !== 'anthropic') {
      return bad(400, 'kind must be openai-compatible or anthropic.');
    }
    let endpoint;
    try {
      endpoint = addEndpoint({
        label,
        baseUrl: base_url,
        model,
        ...(kind ? { kind } : {}),
        ...(api_key ? { apiKey: api_key } : {}),
      });
    } catch (err) {
      if (err instanceof EndpointExistsError) return bad(409, err.message);
      throw err;
    }
    return ok({ endpoint: withBadge(endpoint) });
  }

  const providerMatch = /^\/api\/providers\/([a-z0-9-]{1,40})(\/default)?$/.exec(route);
  if (providerMatch) {
    const id = providerMatch[1]!;
    if (method === 'DELETE' && !providerMatch[2]) {
      return removeEndpoint(id) ? ok({ removed: id }) : bad(404, 'Unknown endpoint.');
    }
    if (method === 'POST' && providerMatch[2]) {
      setDefaultEndpoint(id);
      return ok({ default_id: id });
    }
  }

  if (method === 'GET' && route === '/api/models') {
    const endpointId = query.get('endpoint');
    const base = query.get('base');
    let baseUrl: string;
    let apiKey: string | undefined;
    let kind = 'openai-compatible';
    if (endpointId) {
      const endpoint = getEndpoint(endpointId);
      if (!endpoint) return bad(404, 'Unknown endpoint.');
      baseUrl = endpoint.baseUrl;
      kind = endpoint.kind;
      apiKey = getEndpointKey(endpointId) ?? undefined;
    } else if (base) {
      baseUrl = base; // pre-add discovery; no stored key for it yet
    } else {
      return bad(400, 'endpoint or base required.');
    }
    const provider =
      kind === 'anthropic' && apiKey
        ? createAnthropicProvider({ apiKey, baseUrl })
        : createOpenAICompatibleProvider({ baseUrl, ...(apiKey ? { apiKey } : {}) });
    try {
      const models = await provider.listModels();
      // Rough cost tier per catalogued model, so the GUI can show a $/$$ hint
      // next to each option. Unknown models simply carry no cost (omitted).
      const costs: Record<string, string> = {};
      for (const m of models) {
        const tier = lookupModel(m)?.costTier;
        if (tier) costs[m] = tier;
      }
      return ok({ models, tier: classifyEndpoint(baseUrl).tier, costs });
    } catch {
      return bad(502, 'Could not list models from that endpoint — is it running?');
    }
  }

  // --- Local models (M9c). Guided Ollama install + a hardware-matched 1-click
  // pull. Loopback-only (the OllamaClient reuses ollamaUrl()); carries no
  // secrets. `status` tells the GUI whether to show "install Ollama first" or
  // the recommended model + Install button.
  if (method === 'GET' && route === '/api/local/status') {
    const state = await ollamaState().catch(() => 'not-installed' as const);
    return ok({ state, recommended: recommendLocalModel(), hardware: detectHardware() });
  }

  if (method === 'POST' && route === '/api/local/pull') {
    const { model } = parseJson<{ model?: string }>(body);
    if (typeof model !== 'string' || !/^[a-z0-9._:-]{1,64}$/i.test(model)) {
      return bad(400, 'A valid Ollama model tag is required.');
    }
    evictStalePullJobs();
    const job: PullJob = {
      id: randomUUID(),
      createdAt: Date.now(),
      model,
      status: 'starting',
      completed: 0,
      total: 0,
      done: false,
    };
    pullJobs.set(job.id, job);
    // Fire and let the client poll. On success, auto-add the pulled model as a
    // loopback endpoint so it's immediately usable in chat.
    void createOllamaClient()
      .pull(model, (p) => {
        job.status = p.status;
        if (typeof p.completedBytes === 'number') job.completed = p.completedBytes;
        if (typeof p.totalBytes === 'number') job.total = p.totalBytes;
      })
      .then(() => {
        try {
          // Don't add a duplicate endpoint if this local model is already
          // configured (re-pull / double-click Install). One entry per model.
          const already = listEndpoints().some(
            (e) => e.model === model && e.baseUrl === 'http://127.0.0.1:11434',
          );
          if (!already) {
            addEndpoint({
              label: 'This Mac — ' + model,
              baseUrl: 'http://127.0.0.1:11434',
              model,
              kind: 'openai-compatible',
            });
          }
          job.status = 'success';
        } catch (err) {
          job.error = 'Model pulled, but adding the endpoint failed: ' + (err instanceof Error ? err.message : String(err));
        }
        job.done = true;
      })
      .catch((err: unknown) => {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        job.done = true;
      });
    return ok({ job_id: job.id });
  }

  const pullMatch = /^\/api\/local\/pull\/([0-9a-f-]{36})\/progress$/.exec(route);
  if (method === 'GET' && pullMatch) {
    const job = pullJobs.get(pullMatch[1]!);
    if (!job) return bad(404, 'Unknown pull job.');
    return ok({
      status: job.status,
      completed: job.completed,
      total: job.total,
      done: job.done,
      error: job.error,
    });
  }

  if (method === 'POST' && route === '/api/converse/undo') {
    const { ids } = parseJson<{ ids?: string[] }>(body);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50) {
      return bad(400, 'ids must be a non-empty array.');
    }
    if (!ids.every((id) => typeof id === 'string' && /^[0-9a-f-]{8,36}$/i.test(id))) {
      return bad(400, 'Invalid memory id.');
    }
    return ok(
      await session.withVault((vault) => {
        const forgotten: string[] = [];
        for (const id of ids) {
          try {
            forgotten.push(vault.forget(id).id);
          } catch {
            // already forgotten or unknown — undo is best-effort per id
          }
        }
        if (forgotten.length > 0) vault.save();
        return { forgotten };
      }),
    );
  }

  // --- Connect (M8, ADR 0013). Register the MCP server that ships *inside*
  // NorthKeep with the consumer Claude apps. Connect/disconnect edit files we
  // don't own (see connect.ts) and CAN throw on an unparseable config — we
  // surface that as a 400, never a crash. Status reads are side-effect-free and
  // never throw. Scope presets ride NORTHKEEP_SCOPES (M4), so they're a real,
  // enforced boundary — not a UI hint. ---

  if (method === 'GET' && route === '/api/connect') {
    // The vault yields the distinct scopes the user actually has, so the UI can
    // offer real presets. Only readable while unlocked; locked simply omits them
    // (Connect itself never needs the vault open — it only writes config).
    const scopesInVault = session.isUnlocked()
      ? await session.withVault((vault) => vault.scopes())
      : [];
    const target = (id: ConnectTarget, label: string, available: boolean) => {
      const status = connectStatus(id);
      return { id, label, available, connected: status.connected, scopes: status.scopes ?? null };
    };
    return ok({
      targets: [
        target('claude-desktop', 'Claude Desktop', true),
        target('claude-code', 'Claude Code', claudeCodeAvailable()),
      ],
      scopes_in_vault: scopesInVault,
    });
  }

  const connectMatch = /^\/api\/(connect|disconnect)\/([a-z-]+)$/.exec(route);
  if (method === 'POST' && connectMatch) {
    const target = connectMatch[2];
    if (target !== 'claude-desktop' && target !== 'claude-code') {
      return bad(400, 'Unknown target — must be claude-desktop or claude-code.');
    }
    try {
      if (connectMatch[1] === 'connect') {
        const { scopes } = parseJson<{ scopes?: string[] }>(body);
        if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string'))) {
          return bad(400, 'scopes must be an array of strings.');
        }
        return ok(connect(target, { scopes }));
      }
      return ok(disconnect(target));
    } catch (err) {
      // An unparseable target config (or a missing `claude` CLI on connect)
      // throws here — report it to the user rather than 500.
      return bad(400, err instanceof Error ? err.message : String(err));
    }
  }

  if (method === 'POST' && route === '/api/import/upload') {
    return startImport(session, query, body);
  }

  const jobMatch = /^\/api\/import\/([0-9a-f-]{36})\/(progress|candidates|commit)$/.exec(route);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]!);
    if (!job) return bad(404, 'Unknown import job.');
    if (method === 'GET' && jobMatch[2] === 'progress') {
      return ok({
        status: job.status,
        done: job.done,
        total: job.total,
        degraded: job.degraded,
        error: job.error,
        candidate_count: job.candidates.length,
      });
    }
    if (method === 'GET' && jobMatch[2] === 'candidates') {
      if (job.status !== 'ready') return bad(409, `Job is ${job.status}.`);
      return ok({
        candidates: job.candidates.map((c, index) => ({
          index,
          type: c.type,
          content: c.content,
          confidence: c.confidence,
          conversation_title: c.origin.conversation_title ?? null,
        })),
        conflicts: job.conflicts.slice(0, 25),
        duplicates_dropped: job.duplicatesDropped,
        degraded: job.degraded,
      });
    }
    if (method === 'POST' && jobMatch[2] === 'commit') {
      if (job.status !== 'ready') return bad(409, `Job is ${job.status}.`);
      const { approved, scope } = parseJson<{ approved?: number[]; scope?: string }>(body);
      if (!Array.isArray(approved)) return bad(400, 'approved must be an array of candidate indexes.');
      const targetScope = (scope ?? 'personal').trim() || 'personal';
      if (!/^[a-z0-9:_.-]{1,64}$/i.test(targetScope)) return bad(400, 'Invalid scope.');
      const chosen = approved
        .filter((i): i is number => Number.isInteger(i) && i >= 0 && i < job.candidates.length)
        .map((i) => job.candidates[i]!);
      const written = await session.withVault((vault) => {
        for (const candidate of chosen) {
          vault.remember({
            content: candidate.content,
            type: candidate.type,
            scope: targetScope,
            source: `import:${job.source}`,
            sourceModel: job.degraded ? 'heuristic' : EXTRACT_MODEL,
            confidence: candidate.confidence,
            metadata:
              candidate.origin.conversation_title !== undefined
                ? {
                    conversation_id: candidate.origin.conversation_id,
                    conversation_title: candidate.origin.conversation_title,
                  }
                : null,
          });
        }
        vault.save();
        return chosen.length;
      });
      job.candidates = [];
      jobs.delete(job.id); // done — don't retain the job (or its plaintext)
      return ok({ imported: written });
    }
  }

  return bad(404, 'Not found.');
}

async function startImport(
  session: UiSession,
  query: URLSearchParams,
  body: Buffer,
): Promise<ApiResponse> {
  const source = query.get('source');
  if (source !== 'chatgpt' && source !== 'claude' && source !== 'paste') {
    return bad(400, 'source must be chatgpt | claude | paste.');
  }
  const filename = (query.get('filename') ?? 'upload').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (body.length === 0) return bad(400, 'Empty upload.');
  if (body.length > MAX_UPLOAD_BYTES) return bad(413, 'Upload too large (512 MB max).');

  // Snapshot existing entries BEFORE the long extraction (same 4-phase
  // pattern as the CLI): the write at commit time is the only locked window.
  const existing = await session.withVault((vault) => vault.list({ includeForgotten: true }));

  // The parsers read files; hold the upload on disk (0600, under the 0700
  // home dir) only as long as parsing takes. See ADR 0004.
  const tempPath = path.join(northkeepHome(), `.upload-${randomUUID()}-${filename}`);
  fs.mkdirSync(northkeepHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tempPath, body, { mode: 0o600 });

  evictStaleJobs();
  const job: ImportJob = {
    id: randomUUID(),
    createdAt: Date.now(),
    source,
    status: 'extracting',
    total: 0,
    done: 0,
    degraded: false,
    candidates: [],
    conflicts: [],
    duplicatesDropped: 0,
  };
  jobs.set(job.id, job);

  try {
    if (source === 'paste') {
      const parsed = parsePasteFile(tempPath);
      if (parsed.length === 0) {
        throw new Error('No "- [type] fact" lines found — is this the chatbot\'s answer to the NorthKeep prompt?');
      }
      const deduped = dedupeCandidates(parsed, existing);
      job.candidates = deduped.unique;
      job.conflicts = deduped.conflicts;
      job.duplicatesDropped = deduped.duplicatesDropped;
      job.total = parsed.length;
      job.done = parsed.length;
      job.status = 'ready';
    } else {
      const conversations: ImportedConversation[] =
        source === 'chatgpt' ? parseChatgptExport(tempPath) : parseClaudeExport(tempPath);
      if (conversations.length === 0) throw new Error('No conversations found in that file.');
      job.total = conversations.length;
      // Fire and let the client poll; errors land on the job.
      void runImport(conversations, {
        existing,
        onProgress: (done, _total, mode) => {
          job.done = done;
          if (mode === 'heuristic') job.degraded = true;
        },
      })
        .then((result) => {
          job.candidates = result.candidates;
          job.conflicts = result.conflicts;
          job.duplicatesDropped = result.duplicatesDropped;
          job.degraded = result.degraded;
          job.status = 'ready';
        })
        .catch((err: unknown) => {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
        });
    }
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  return ok({ job_id: job.id, total: job.total, status: job.status, error: job.error });
}

function publicEntry(entry: {
  id: string;
  type: string;
  content: string;
  scope: string;
  source: string;
  source_model: string | null;
  confidence: number;
  created_at: string;
}): Record<string, unknown> {
  return {
    id: entry.id,
    type: entry.type,
    content: entry.content,
    scope: entry.scope,
    source: entry.source,
    source_model: entry.source_model,
    confidence: entry.confidence,
    created_at: entry.created_at,
  };
}

/** Endpoint as sent to the GUI: config + derived privacy badge, never a key. */
function withBadge(endpoint: {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  kind: string;
  hasKey: boolean;
}): Record<string, unknown> {
  return {
    id: endpoint.id,
    label: endpoint.label,
    base_url: endpoint.baseUrl,
    model: endpoint.model,
    kind: endpoint.kind,
    has_key: endpoint.hasKey,
    tier: classifyEndpoint(endpoint.baseUrl).tier,
    // Rough cost tier (M9b) for the $/$$ hint in the endpoint list; null for
    // an uncatalogued model. Never a secret.
    cost_tier: lookupModel(endpoint.model)?.costTier ?? null,
  };
}

class DeviceSecretError extends Error {}
class SyncRequestError extends Error {}
function deviceSecretOrError(): Buffer {
  try {
    return loadDeviceSecret();
  } catch {
    throw new DeviceSecretError('No device secret found. Run "northkeep init" first.');
  }
}

function parseJson<T>(body: Buffer): T {
  if (body.length === 0) return {} as T;
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch {
    throw new Error('Invalid JSON body.');
  }
}
