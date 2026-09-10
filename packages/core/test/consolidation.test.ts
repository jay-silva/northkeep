import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exactCanonicalJson } from '../src/consolidation.js';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import type { MemoryEntry, VaultExport } from '../src/types.js';
import { Vault, computeEntryHash } from '../src/vault.js';

const PASSPHRASE = 'synthetic consolidation passphrase';
const OP1 = '11111111-1111-4111-8111-111111111111';
const OP2 = '22222222-2222-4222-8222-222222222222';
let directory: string;
let vaultPath: string;
let deviceSecret: Buffer;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-consolidation-'));
  vaultPath = path.join(directory, 'vault.nkv');
  deviceSecret = generateDeviceSecret();
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function createVault(): Vault {
  return Vault.create({ path: vaultPath, passphrase: PASSPHRASE, deviceSecret, kdf: KDF_INTERACTIVE });
}

function seed(vault: Vault, overrides: Partial<Parameters<Vault['remember']>[0]> = {}): MemoryEntry[] {
  return ['First exact source', 'Second exact source'].map((content, index) => vault.remember({
    content,
    type: 'semantic',
    scope: 'personal',
    confidence: 0.7 + index / 10,
    metadata: { nested: { index } },
    ...overrides,
  }));
}

function rebuildFromExport(doc: VaultExport): Vault {
  fs.rmSync(vaultPath, { force: true });
  const vault = createVault();
  const db = (vault as unknown as { db: import('better-sqlite3').Database }).db;
  const insert = db.prepare(`INSERT INTO memories
    (id, type, content, scope, source, source_model, confidence, created_at, valid_from,
     superseded_at, superseded_by, forgotten_at, prev_hash, entry_hash, metadata)
    VALUES (@id, @type, @content, @scope, @source, @source_model, @confidence, @created_at,
     @valid_from, @superseded_at, @superseded_by, @forgotten_at, @prev_hash, @entry_hash, @metadata)`);
  const transaction = db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    db.prepare('DELETE FROM memories').run();
    for (const memory of doc.memories) {
      insert.run({
        id: memory.id,
        type: memory.type,
        content: memory.content,
        scope: memory.scope,
        source: memory.provenance.source,
        source_model: memory.provenance.source_model,
        confidence: memory.provenance.confidence,
        created_at: memory.provenance.created_at,
        valid_from: memory.validity.valid_from,
        superseded_at: memory.validity.superseded_at,
        superseded_by: memory.validity.superseded_by,
        forgotten_at: memory.validity.forgotten_at,
        prev_hash: memory.provenance.prev_hash,
        entry_hash: memory.provenance.entry_hash,
        metadata: memory.metadata === null ? null : JSON.stringify(memory.metadata),
      });
    }
    db.prepare("UPDATE vault_meta SET value = ? WHERE key = 'vault_id'").run(doc.northkeep_export.vault_id);
    db.prepare("UPDATE vault_meta SET value = ? WHERE key = 'chain_head'").run(doc.northkeep_export.chain_head);
  });
  transaction();
  expect(db.pragma('foreign_key_check')).toEqual([]);
  return vault;
}

function rehashExportFrom(doc: VaultExport, start: number): void {
  for (let index = start; index < doc.memories.length; index += 1) {
    const memory = doc.memories[index]!;
    if (index > 0) memory.provenance.prev_hash = doc.memories[index - 1]!.provenance.entry_hash;
    memory.provenance.entry_hash = computeEntryHash({
      id: memory.id,
      type: memory.type,
      content: memory.content,
      scope: memory.scope,
      source: memory.provenance.source,
      source_model: memory.provenance.source_model,
      confidence: memory.provenance.confidence,
      created_at: memory.provenance.created_at,
      valid_from: memory.validity.valid_from,
      superseded_at: memory.validity.superseded_at,
      superseded_by: memory.validity.superseded_by,
      forgotten_at: memory.validity.forgotten_at,
      prev_hash: memory.provenance.prev_hash,
      entry_hash: '',
      metadata: memory.metadata,
    });
  }
  doc.northkeep_export.chain_head = doc.memories.at(-1)!.provenance.entry_hash;
}

describe('guided consolidation core', () => {
  it('consolidates exact snapshots atomically and keeps source history', () => {
    const vault = createVault();
    const sources = seed(vault);
    const receipt = vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'Combined exact text.' });
    expect(receipt.kind).toBe('consolidate');
    expect(vault.list()).toEqual([receipt.result]);
    const history = vault.consolidationHistory()[0]!;
    expect(history.sources.map((source) => source.id)).toEqual(sources.map((source) => source.id));
    expect(history.sources.every((source) => source.superseded_by === receipt.result.id)).toBe(true);
    expect(history.can_restore).toBe(true);
    expect(vault.verifyChain()).toEqual({ ok: true });
    vault.close();
  });

  it('rolls back the insert, all supersession, and chain head on a mid-group failure', () => {
    const vault = createVault();
    const sources = seed(vault);
    const before = vault.export().northkeep_export.chain_head;
    const db = (vault as unknown as { db: { exec(sql: string): void } }).db;
    db.exec(`CREATE TRIGGER fail_second BEFORE UPDATE ON memories WHEN OLD.id = '${sources[1]!.id}' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    expect(() => vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'Combined.' })).toThrow(/synthetic failure/);
    expect(vault.list()).toEqual(sources);
    expect(vault.export().northkeep_export.chain_head).toBe(before);
    expect(vault.consolidationHistory()).toEqual([]);
    vault.close();
  });

  it('checks bounds, privacy, scope, type, snapshots, ids, and reserved metadata', () => {
    const vault = createVault();
    const sources = seed(vault);
    expect(() => vault.consolidateMemories({ vault_id: 'wrong', operation_id: OP1, sources, content: 'x' })).toThrow(/Vault id/);
    expect(() => vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', sources, content: 'x' })).toThrow(/lowercase/);
    expect(() => vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources: [sources[0]!, sources[0]!], content: 'x' })).toThrow(/unique/);
    const mixed = vault.remember({ content: 'Different type', type: 'episodic' });
    expect(() => vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources: [sources[0]!, mixed], content: 'x' })).toThrow(/one type/);
    vault.setScopeShared('personal', true);
    expect(() => vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'x' })).toThrow(/Shared|private/);
    vault.setScopeShared('personal', false);
    const altered = [{ ...sources[0]!, content: `${sources[0]!.content} ` }, sources[1]!];
    expect(() => vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources: altered, content: 'x' })).toThrow(/changed/);
    const reserved = vault.remember({ content: 'Reserved', type: 'semantic', metadata: { 'northkeep:consolidation': {} } });
    expect(() => vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources: [sources[0]!, reserved], content: 'x' })).toThrow(/Malformed reserved/);
    vault.close();
  });

  it('makes byte-exact retries durable and rejects altered or cross-kind UUID reuse', () => {
    let vault = createVault();
    const sources = seed(vault);
    const request = { vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'Cafe\u0301' };
    const first = vault.consolidateMemories(request);
    expect(vault.consolidateMemories(request).result.id).toBe(first.result.id);
    expect(() => vault.consolidateMemories({ ...request, content: 'Caf\u00e9' })).toThrow(/already used/);
    expect(() => vault.restoreConsolidation({ vault_id: vault.getVaultId(), operation_id: OP1, result_id: first.result.id, expected_result: first.result })).toThrow(/different/);
    vault.save();
    vault.close();
    vault = Vault.open({ path: vaultPath, passphrase: PASSPHRASE, deviceSecret, kdf: KDF_INTERACTIVE });
    expect(vault.consolidateMemories(request).result.id).toBe(first.result.id);
    vault.close();
  });

  it('restores complete metadata-bearing copies and makes restore retries exact', () => {
    const vault = createVault();
    const sources = seed(vault);
    const consolidated = vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'Combined.' });
    const request = { vault_id: vault.getVaultId(), operation_id: OP2, result_id: consolidated.result.id, expected_result: consolidated.result };
    const restored = vault.restoreConsolidation(request);
    expect(restored.restored_entries).toHaveLength(2);
    restored.restored_entries.forEach((entry, index) => {
      expect(entry.content).toBe(sources[index]!.content);
      expect(entry.type).toBe(sources[index]!.type);
      expect(entry.scope).toBe(sources[index]!.scope);
      expect(entry.confidence).toBe(sources[index]!.confidence);
      expect(entry.valid_from).toBe(sources[index]!.valid_from);
      expect(entry.metadata?.nested).toEqual(sources[index]!.metadata?.nested);
      expect((entry.metadata?.['northkeep:consolidation'] as { restored_ids: string[] }).restored_ids).toEqual(restored.restored_entries.map((item) => item.id));
    });
    expect(vault.restoreConsolidation(request).restored_entries.map((entry) => entry.id)).toEqual(restored.restored_entries.map((entry) => entry.id));
    expect(vault.consolidationHistory()[0]!.can_restore).toBe(false);
    expect(vault.verifyChain()).toEqual({ ok: true });
    vault.close();
  });

  it('allows authenticated restored entries to participate in later curation', () => {
    const vault = createVault();
    const sources = seed(vault);
    const consolidated = vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'Combined.' });
    const restored = vault.restoreConsolidation({ vault_id: vault.getVaultId(), operation_id: OP2, result_id: consolidated.result.id, expected_result: consolidated.result });
    const third = vault.remember({ content: 'Third exact source', type: 'semantic' });
    const again = vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: '33333333-3333-4333-8333-333333333333', sources: [restored.restored_entries[0]!, third], content: 'Curated again.' });
    expect(again.result.content).toBe('Curated again.');
    expect(vault.verifyChain()).toEqual({ ok: true });
    vault.close();
  });

  it('keeps history readable when a restored copy is later forgotten', () => {
    const vault = createVault();
    const sources = seed(vault);
    const consolidated = vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'Combined.' });
    const restored = vault.restoreConsolidation({ vault_id: vault.getVaultId(), operation_id: OP2, result_id: consolidated.result.id, expected_result: consolidated.result });
    vault.forget(restored.restored_entries[0]!.id);
    const history = vault.consolidationHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.can_restore).toBe(false);
    expect(history[0]!.restored_entries).toHaveLength(1);
    vault.close();
  });

  it('keeps unrelated history visible after legitimate source deletion and restored-copy editing', () => {
    const vault = createVault();
    const firstSources = seed(vault);
    const first = vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources: firstSources, content: 'First group.' });
    const restored = vault.restoreConsolidation({ vault_id: vault.getVaultId(), operation_id: OP2, result_id: first.result.id, expected_result: first.result });
    vault.editMemory(restored.restored_entries[0]!.id, { content: 'Legitimate later edit.' });
    vault.forget(firstSources[1]!.id);
    const secondSources = seed(vault, { scope: 'work' });
    vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: '33333333-3333-4333-8333-333333333333', sources: secondSources, content: 'Second group.' });
    const history = vault.consolidationHistory();
    expect(history).toHaveLength(2);
    expect(history.find((item) => item.operation_id === OP1)?.can_restore).toBe(false);
    expect(history.find((item) => item.operation_id === '33333333-3333-4333-8333-333333333333')?.can_restore).toBe(true);
    vault.close();
  });

  it('preserves history and exact apply/restore retries through a complete text export rebuild', () => {
    let vault = createVault();
    const sources = seed(vault);
    const applyRequest = { vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'Portable combined text.' };
    const consolidated = vault.consolidateMemories(applyRequest);
    const appliedExport = JSON.parse(JSON.stringify(vault.export())) as VaultExport;
    vault.close();

    vault = rebuildFromExport(appliedExport);
    expect(vault.verifyChain()).toEqual({ ok: true });
    expect(vault.consolidationHistory()).toHaveLength(1);
    expect(vault.consolidateMemories(applyRequest).result.id).toBe(consolidated.result.id);
    const restoreRequest = { vault_id: vault.getVaultId(), operation_id: OP2, result_id: consolidated.result.id, expected_result: consolidated.result };
    const restored = vault.restoreConsolidation(restoreRequest);
    const restoredExport = JSON.parse(JSON.stringify(vault.export())) as VaultExport;
    vault.close();

    vault = rebuildFromExport(restoredExport);
    expect(vault.verifyChain()).toEqual({ ok: true });
    expect(vault.restoreConsolidation(restoreRequest).restored_entries.map((entry) => entry.id)).toEqual(restored.restored_entries.map((entry) => entry.id));
    expect(vault.consolidationHistory()[0]!.restored_entries).toHaveLength(2);
    vault.close();
  });

  it('replicates an encrypted vault as one complete group and rejects a partial replica', () => {
    const vault = createVault();
    const sources = seed(vault);
    vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'Replicated group.' });
    vault.save();
    vault.close();
    const replicaPath = path.join(directory, 'replica.nkv');
    fs.copyFileSync(vaultPath, replicaPath);
    const replica = Vault.open({ path: replicaPath, passphrase: PASSPHRASE, deviceSecret, kdf: KDF_INTERACTIVE });
    expect(replica.consolidationHistory()[0]!.sources).toHaveLength(2);
    expect(replica.verifyChain()).toEqual({ ok: true });
    replica.close();
    const bytes = fs.readFileSync(vaultPath);
    fs.writeFileSync(replicaPath, bytes.subarray(0, bytes.length - 17));
    expect(() => Vault.open({ path: replicaPath, passphrase: PASSPHRASE, deviceSecret, kdf: KDF_INTERACTIVE })).toThrow();
  });

  it('refuses chain-valid imported consolidation results with altered semantics', () => {
    const vault = createVault();
    const sources = seed(vault);
    const request = { vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'Original result.' };
    vault.consolidateMemories(request);
    const exported = vault.export();
    vault.close();
    const resultIndex = exported.memories.length - 1;
    const mutations: Array<(memory: VaultExport['memories'][number]) => void> = [
      (memory) => { memory.content = 'Injected result.'; },
      (memory) => { memory.type = 'episodic'; },
      (memory) => { memory.scope = 'other'; },
      (memory) => { memory.provenance.source = 'import:spoof'; },
      (memory) => { memory.provenance.confidence = 0.2; },
      (memory) => { memory.validity.valid_from = '2020-01-01T00:00:00.000Z'; },
    ];
    for (const mutate of mutations) {
      const attacked = structuredClone(exported);
      mutate(attacked.memories[resultIndex]!);
      rehashExportFrom(attacked, resultIndex);
      const rebuilt = rebuildFromExport(attacked);
      expect(rebuilt.verifyChain()).toEqual({ ok: true });
      expect(() => rebuilt.consolidateMemories(request)).toThrow(/invalid|does not match/);
      rebuilt.close();
    }
  });

  it('rejects imported consolidation lineage with a duplicated source identity', () => {
    const vault = createVault();
    const sources = seed(vault);
    const consolidated = vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'Combined.' });
    const attacked = vault.export();
    vault.close();
    const resultIndex = attacked.memories.length - 1;
    const marker = attacked.memories[resultIndex]!.metadata?.['northkeep:consolidation'] as {
      source_ids: string[];
      source_hashes: string[];
      source_snapshot_hashes: string[];
    };
    marker.source_ids[1] = marker.source_ids[0]!;
    marker.source_hashes[1] = marker.source_hashes[0]!;
    marker.source_snapshot_hashes[1] = marker.source_snapshot_hashes[0]!;
    rehashExportFrom(attacked, resultIndex);
    const rebuilt = rebuildFromExport(attacked);
    expect(rebuilt.verifyChain()).toEqual({ ok: true });
    expect(() => rebuilt.consolidationHistory()).toThrow(/Malformed reserved/);
    const importedResult = rebuilt.list({ includeSuperseded: true }).find((entry) => entry.id === consolidated.result.id)!;
    expect(() => rebuilt.restoreConsolidation({ vault_id: rebuilt.getVaultId(), operation_id: OP2, result_id: importedResult.id, expected_result: importedResult })).toThrow(/Malformed reserved/);
    rebuilt.close();
  });

  it('refuses chain-valid imported restores whose copies or ordered metadata were altered', () => {
    const vault = createVault();
    const sources = seed(vault);
    const consolidated = vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources, content: 'Combined.' });
    const request = { vault_id: vault.getVaultId(), operation_id: OP2, result_id: consolidated.result.id, expected_result: consolidated.result };
    vault.restoreConsolidation(request);
    const exported = vault.export();
    vault.close();
    const restoredIndex = exported.memories.length - 2;
    const mutations: Array<(memory: VaultExport['memories'][number]) => void> = [
      (memory) => { memory.content = 'Injected copy.'; },
      (memory) => { memory.provenance.source = 'import:spoof'; },
      (memory) => { memory.provenance.confidence = 0.1; },
      (memory) => { const marker = memory.metadata?.['northkeep:consolidation'] as { original_metadata: unknown }; marker.original_metadata = { injected: true }; },
      (memory) => { const marker = memory.metadata?.['northkeep:consolidation'] as { restored_ids: string[] }; marker.restored_ids.reverse(); },
    ];
    for (const mutate of mutations) {
      const attacked = structuredClone(exported);
      mutate(attacked.memories[restoredIndex]!);
      rehashExportFrom(attacked, restoredIndex);
      const rebuilt = rebuildFromExport(attacked);
      expect(rebuilt.verifyChain()).toEqual({ ok: true });
      expect(() => rebuilt.restoreConsolidation(request)).toThrow();
      expect(() => rebuilt.consolidationHistory()).toThrow();
      rebuilt.close();
    }
  });

  it('sorts hostile object keys without Unicode normalization or prototype loss', () => {
    const value = JSON.parse('{"z":"Café","__proto__":{"polluted":true},"a":"Café"}') as object;
    const encoded = exactCanonicalJson(value);
    expect(encoded).toBe('{"__proto__":{"polluted":true},"a":"Café","z":"Café"}');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(() => exactCanonicalJson({ value: Number.NaN })).toThrow(/non-finite/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => exactCanonicalJson(cyclic)).toThrow(/cycle/);
    expect(() => exactCanonicalJson({ value: undefined })).toThrow(/non-JSON/);
    expect(() => exactCanonicalJson({ value: () => undefined })).toThrow(/non-JSON/);
    expect(() => exactCanonicalJson({ value: Symbol('x') })).toThrow(/non-JSON/);
    expect(() => exactCanonicalJson(new Array(2))).toThrow(/sparse array/);
    expect(() => exactCanonicalJson({ [Symbol('key')]: 'value' })).toThrow(/symbol key/);
  });
});
