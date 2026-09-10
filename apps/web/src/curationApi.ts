/** Token-gated by server.ts and unlock-gated here. Guided consolidation API, ADR 0047. */
import { isProjectScope, isMemoryType, type MemoryEntry } from '@northkeep/core';
import {
  createOllamaClient,
  resolveReviewModel,
  selectConsolidationEntries,
  suggestConsolidations,
  type OllamaClient,
} from '@northkeep/librarian';
import type { UiSession } from './session.js';

export interface CurationApiResponse { status: number; body: unknown }
export interface CurationApiDeps {
  resolveModel: () => Promise<string>;
  generator: () => Pick<OllamaClient, 'generateJson'>;
}

const defaults: CurationApiDeps = { resolveModel: resolveReviewModel, generator: createOllamaClient };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BODY = 256 * 1024;
const MAX_CONTENT = 20_000;

class InputError extends Error {}
class StaleError extends Error {}
const response = (status: number, body: unknown): CurationApiResponse => ({ status, body });
const error = (status: number, message: string): CurationApiResponse => response(status, { error: message });

function parse(body: Buffer): Record<string, unknown> {
  if (body.length > MAX_BODY) throw new InputError('Request body is too large.');
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('JSON body must be an object.');
    return value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof InputError) throw err;
    throw new InputError('Invalid JSON body.');
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new InputError(`Body must contain exactly: ${keys.join(', ')}.`);
  }
}

function memory(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Partial<MemoryEntry>;
  return typeof e.id === 'string' && UUID.test(e.id) && typeof e.type === 'string' && isMemoryType(e.type) &&
    typeof e.content === 'string' && e.content.length <= MAX_CONTENT && typeof e.scope === 'string' && e.scope.length > 0 &&
    typeof e.source === 'string' && (e.source_model === null || typeof e.source_model === 'string') &&
    typeof e.confidence === 'number' && Number.isFinite(e.confidence) && typeof e.created_at === 'string' &&
    (e.valid_from === null || typeof e.valid_from === 'string') && (e.superseded_at === null || typeof e.superseded_at === 'string') &&
    (e.superseded_by === null || typeof e.superseded_by === 'string') && (e.forgotten_at === null || typeof e.forgotten_at === 'string') &&
    typeof e.prev_hash === 'string' && typeof e.entry_hash === 'string' && (e.metadata === null || (typeof e.metadata === 'object' && !Array.isArray(e.metadata)));
}

function memories(value: unknown, field: string): MemoryEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || !value.every(memory)) throw new InputError(`${field} must contain 1-8 full memory snapshots.`);
  if (new Set(value.map((entry) => entry.id)).size !== value.length) throw new InputError(`${field} contains duplicate IDs.`);
  return value;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !OPERATION_UUID.test(value)) throw new InputError(`${field} must be a lowercase UUID version 1-5.`);
}

function sameSnapshot(a: MemoryEntry[], b: MemoryEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Returns null when the route is not part of the curation API. */
export async function handleCurationApi(
  session: UiSession, method: string, route: string, body: Buffer, deps: CurationApiDeps = defaults,
): Promise<CurationApiResponse | null> {
  if (!route.startsWith('/api/curation/')) return null;
  try {
    if (!session.isUnlocked()) return error(423, 'Vault is locked.');
    if (method === 'GET' && route === '/api/curation/collections') {
      return response(200, await session.withVault((vault) => {
        const shared = new Set(vault.sharedScopes());
        const counts = new Map<string, number>();
        let excludedShared = 0;
        let excludedProjects = 0;
        for (const entry of vault.list()) {
          if (isProjectScope(entry.scope)) { excludedProjects += 1; continue; }
          if (shared.has(entry.scope)) { excludedShared += 1; continue; }
          counts.set(entry.scope, (counts.get(entry.scope) ?? 0) + 1);
        }
        return { collections: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([scope, count]) => ({ scope, count })), excluded_shared: excludedShared, excluded_projects: excludedProjects };
      }));
    }

    if (method === 'POST' && route === '/api/curation/suggest') {
      const request = parse(body); exactKeys(request, ['scope', 'instruction']);
      if (typeof request.scope !== 'string' || !request.scope.trim() || isProjectScope(request.scope)) throw new InputError('scope must name a private, non-project collection.');
      if (typeof request.instruction !== 'string' || request.instruction.length > 2_000) throw new InputError('instruction must be at most 2,000 characters.');
      const snapshot = await session.withVault((vault) => {
        const selected = selectConsolidationEntries(vault.list(), request.scope as string, vault.sharedScopes());
        if (selected.length < 2) throw new InputError('That private collection needs at least two memories.');
        return { vaultId: vault.getVaultId(), selected };
      });
      const model = await deps.resolveModel();
      const result = await suggestConsolidations(snapshot.selected, request.instruction, deps.generator(), { model });
      await session.withVault((vault) => {
        if (vault.getVaultId() !== snapshot.vaultId || vault.sharedScopes().includes(request.scope as string)) throw new StaleError('Vault or sharing changed while suggestions were generated.');
        const current = selectConsolidationEntries(vault.list(), request.scope as string, vault.sharedScopes());
        if (!sameSnapshot(current, snapshot.selected)) throw new StaleError('Memories changed while suggestions were generated.');
      });
      return response(200, { vault_id: snapshot.vaultId, scope: request.scope, groups: result.groups, coverage: result.coverage, model: result.model });
    }

    if (method === 'GET' && route === '/api/curation/history') {
      return response(200, await session.withVault((vault) => ({ vault_id: vault.getVaultId(), items: vault.consolidationHistory() })));
    }

    if (method === 'POST' && route === '/api/curation/apply') {
      const request = parse(body); exactKeys(request, ['vault_id', 'operation_id', 'sources', 'content']);
      if (typeof request.vault_id !== 'string' || !request.vault_id) throw new InputError('vault_id is required.');
      assertUuid(request.operation_id, 'operation_id');
      const sources = memories(request.sources, 'sources');
      if (sources.length < 2) throw new InputError('sources must contain 2-8 memories.');
      if (typeof request.content !== 'string' || !request.content.trim() || request.content.length > MAX_CONTENT) throw new InputError('content must be 1-20,000 characters.');
      const vaultId = request.vault_id;
      const operationId = request.operation_id;
      const content = request.content;
      return response(200, await session.withVault((vault) => {
        if (vault.getVaultId() !== vaultId) throw new StaleError('This request belongs to a different vault.');
        const before = vault.list({ includeForgotten: true, includeSuperseded: true }).length;
        const result = vault.consolidateMemories({ vault_id: vaultId, operation_id: operationId, sources, content });
        if (vault.list({ includeForgotten: true, includeSuperseded: true }).length !== before) vault.save();
        return result;
      }));
    }

    if (method === 'POST' && route === '/api/curation/restore') {
      const request = parse(body); exactKeys(request, ['vault_id', 'operation_id', 'result_id', 'expected_result']);
      if (typeof request.vault_id !== 'string' || !request.vault_id) throw new InputError('vault_id is required.');
      assertUuid(request.operation_id, 'operation_id');
      if (typeof request.result_id !== 'string' || !request.result_id) throw new InputError('result_id is required.');
      if (!memory(request.expected_result)) throw new InputError('expected_result must be a full memory snapshot.');
      const vaultId = request.vault_id;
      const operationId = request.operation_id;
      const resultId = request.result_id;
      const expectedResult = request.expected_result;
      return response(200, await session.withVault((vault) => {
        if (vault.getVaultId() !== vaultId) throw new StaleError('This request belongs to a different vault.');
        const before = vault.list({ includeForgotten: true, includeSuperseded: true }).length;
        const result = vault.restoreConsolidation({ vault_id: vaultId, operation_id: operationId, result_id: resultId, expected_result: expectedResult });
        if (vault.list({ includeForgotten: true, includeSuperseded: true }).length !== before) vault.save();
        return result;
      }));
    }
    return error(404, 'Unknown curation route.');
  } catch (err) {
    if (err instanceof InputError) return error(400, err.message);
    if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string') return error(500, err.message);
    if (err instanceof StaleError || (err instanceof Error && /stale|changed|different vault|already|snapshot|private|shared|project|operation/i.test(err.message))) return error(409, err instanceof Error ? err.message : String(err));
    if (err instanceof Error && /must|requires|invalid|unique|one (?:scope|type)|reserved key|too (?:large|long)|does not match/i.test(err.message)) return error(400, err.message);
    if (err instanceof Error && err.name === 'LockedError') return error(423, 'Vault is locked.');
    return error(500, err instanceof Error ? err.message : String(err));
  }
}
