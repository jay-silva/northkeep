import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@northkeep/core';
import { handleCurationApi } from '../src/curationApi.js';

const ids = { a: '123e4567-e89b-12d3-a456-426614174001', b: '123e4567-e89b-12d3-a456-426614174002', s: '123e4567-e89b-12d3-a456-426614174003', p: '123e4567-e89b-12d3-a456-426614174004' };
const e = (id: string): MemoryEntry => ({ id, type: 'semantic', content: `fact ${id}`, scope: 'private', source: 'test', source_model: null,
  confidence: 1, created_at: '2026-01-01T00:00:00.000Z', valid_from: null, superseded_at: null, superseded_by: null,
  forgotten_at: null, prev_hash: 'a'.repeat(64), entry_hash: id.padEnd(64, '0'), metadata: null });

function session(vault: Record<string, unknown>) {
  return { isUnlocked: () => true, withVault: async (fn: (value: Record<string, unknown>) => unknown) => fn(vault) } as never;
}

describe('curation API', () => {
  it.each(['sharing', 'vault'])('refuses a %s change during local generation', async (change) => {
    let generated = false;
    const vault = { getVaultId: () => generated && change === 'vault' ? 'other' : 'vault', sharedScopes: () => generated && change === 'sharing' ? ['private'] : [], list: () => [e(ids.a), e(ids.b)] };
    const result = await handleCurationApi(session(vault), 'POST', '/api/curation/suggest', Buffer.from(JSON.stringify({ scope: 'private', instruction: '' })), {
      resolveModel: async () => 'local', generator: () => ({ generateJson: async () => { generated = true; return '{"groups":[]}'; } }),
    });
    expect(result?.status).toBe(409);
  });

  it('classifies a persistence error as retryable server failure', async () => {
    let entries = [e(ids.a), e(ids.b)];
    const vault = { getVaultId: () => 'vault', list: () => entries, consolidateMemories: () => { entries = [...entries, e(ids.s)]; return {}; }, save: () => { throw Object.assign(new Error('operation save failed'), { code: 'EIO' }); } };
    const body = { vault_id: 'vault', operation_id: '123e4567-e89b-12d3-a456-426614174000', sources: entries, content: 'exact' };
    const result = await handleCurationApi(session(vault), 'POST', '/api/curation/apply', Buffer.from(JSON.stringify(body)));
    expect(result?.status).toBe(500);
  });
  it('returns 423 while locked and 400 for malformed input', async () => {
    const locked = { isUnlocked: () => false } as never;
    expect((await handleCurationApi(locked, 'GET', '/api/curation/collections', Buffer.alloc(0)))?.status).toBe(423);
    expect((await handleCurationApi(session({}), 'POST', '/api/curation/apply', Buffer.from('{')))?.status).toBe(400);
  });

  it('counts only eligible private collections', async () => {
    const vault = { list: () => [e(ids.a), e(ids.b), e(ids.s), e(ids.p)].map((x, i) => i === 2 ? { ...x, scope: 'shared' } : i === 3 ? { ...x, scope: 'project:x' } : x),
      sharedScopes: () => ['shared'] };
    const res = await handleCurationApi(session(vault), 'GET', '/api/curation/collections', Buffer.alloc(0));
    expect(res?.body).toEqual({ collections: [{ scope: 'private', count: 2 }], excluded_shared: 1, excluded_projects: 1 });
  });

  it('releases the vault during generation and rejects a changed snapshot', async () => {
    let calls = 0;
    const vault = { getVaultId: () => 'vault', sharedScopes: () => [], list: () => calls++ === 0 ? [e(ids.a), e(ids.b)] : [e(ids.a), { ...e(ids.b), content: 'changed' }] };
    const res = await handleCurationApi(session(vault), 'POST', '/api/curation/suggest', Buffer.from(JSON.stringify({ scope: 'private', instruction: '' })), {
      resolveModel: async () => 'local', generator: () => ({ generateJson: async () => '{"groups":[]}' }),
    });
    expect(res?.status).toBe(409);
  });

  it('applies the exact body once and saves once', async () => {
    let saved = 0; let seen: unknown;
    const result = { operation_id: 'x' };
    let entries = [e(ids.a), e(ids.b)];
    const vault = { getVaultId: () => 'vault', list: () => entries, consolidateMemories: (req: unknown) => { seen = req; entries = [...entries, e(ids.s)]; return result; }, save: () => { saved += 1; } };
    const operation = '123e4567-e89b-12d3-a456-426614174000';
    const body = { vault_id: 'vault', operation_id: operation, sources: [e(ids.a), e(ids.b)], content: 'combined' };
    const res = await handleCurationApi(session(vault), 'POST', '/api/curation/apply', Buffer.from(JSON.stringify(body)));
    expect(res).toEqual({ status: 200, body: result });
    expect(seen).toEqual({ vault_id: 'vault', operation_id: operation, sources: body.sources, content: 'combined' });
    expect(saved).toBe(1);
  });

  it('returns history with vault identity', async () => {
    const res = await handleCurationApi(session({ getVaultId: () => 'vault', consolidationHistory: () => [{ operation_id: 'op' }] }), 'GET', '/api/curation/history', Buffer.alloc(0));
    expect(res?.body).toEqual({ vault_id: 'vault', items: [{ operation_id: 'op' }] });
  });
});
