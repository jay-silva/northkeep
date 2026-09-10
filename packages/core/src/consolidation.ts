import type { MemoryEntry } from './types.js';

export interface ConsolidationRequest {
  vault_id: string;
  operation_id: string;
  sources: MemoryEntry[];
  content: string;
}

export interface RestoreConsolidationRequest {
  vault_id: string;
  operation_id: string;
  result_id: string;
  expected_result: MemoryEntry;
}

export interface ConsolidationResult {
  operation_id: string;
  kind: 'consolidate' | 'restore';
  result: MemoryEntry;
  sources: MemoryEntry[];
  restored_entries: MemoryEntry[];
}

export interface ConsolidationHistoryItem {
  operation_id: string;
  result: MemoryEntry;
  sources: MemoryEntry[];
  restored_entries: MemoryEntry[];
  can_restore: boolean;
}

export const CONSOLIDATION_METADATA_KEY = 'northkeep:consolidation';
export const CONSOLIDATION_METADATA_VERSION = 1;
export const CONSOLIDATION_CONTENT_MAX_CHARS = 20_000;
export const CONSOLIDATION_REQUEST_MAX_BYTES = 256 * 1024;

export function exactCanonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value, new Set(), 0));
}

function sortKeys(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error('Consolidation request contains a non-JSON value.');
  }
  if (depth > 100) throw new Error('Consolidation request is nested too deeply.');
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Consolidation request contains a non-finite number.');
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error('Consolidation request contains a sparse array.');
    }
    if (ancestors.has(value)) throw new Error('Consolidation request contains a cycle.');
    ancestors.add(value);
    const result = value.map((item) => sortKeys(item, ancestors, depth + 1));
    ancestors.delete(value);
    return result;
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Consolidation request contains a non-JSON object.');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error('Consolidation request contains a symbol key.');
    }
    if (ancestors.has(value)) throw new Error('Consolidation request contains a cycle.');
    ancestors.add(value);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      Object.defineProperty(result, key, {
        value: sortKeys((value as Record<string, unknown>)[key], ancestors, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    ancestors.delete(value);
    return result;
  }
  return value;
}
