import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { VaultAuthError, isMemoryType, northkeepHome, type MemoryType } from '@northkeep/core';
import {
  parseChatgptExport,
  parseClaudeExport,
  parsePasteFile,
  type ImportedConversation,
  type MemoryCandidate,
} from '@northkeep/importers';
import { EXTRACT_MODEL, createOllamaClient, dedupeCandidates, runImport } from '@northkeep/librarian';
import {
  keychainAvailable,
  keychainDeleteMasterKey,
  keychainSetMasterKey,
  readCallLog,
} from '@northkeep/mcp-server';
import { redact, restore, type Replacement } from '@northkeep/redact';
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

export interface ApiResponse {
  status: number;
  body: unknown;
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
      vault_path: session.vaultPath,
      ollama_available: ollama,
      extract_model: EXTRACT_MODEL,
      keychain_available: keychainAvailable(),
      env_grant: session.hasEnvGrant(),
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
      await session.withVault((vault) => {
        if (q.length > 0) {
          return {
            memories: vault.retrieve(q, { type, scope, limit: 50 }).map((r) => ({
              ...publicEntry(r.entry),
              relevance: Number(r.score.toFixed(3)),
            })),
          };
        }
        return { memories: vault.list({ type, scope }).map(publicEntry).reverse() };
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

  if (method === 'GET' && route === '/api/log') {
    return ok({ calls: readCallLog(200).reverse() });
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
        throw new Error('No "- [type] fact" lines found — is this the chatbot\'s answer to the Northkeep prompt?');
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

function parseJson<T>(body: Buffer): T {
  if (body.length === 0) return {} as T;
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch {
    throw new Error('Invalid JSON body.');
  }
}
