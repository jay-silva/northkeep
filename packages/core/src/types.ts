export const MEMORY_TYPES = [
  'episodic',
  'semantic',
  'procedural',
  'working',
  'identity',
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  scope: string;
  source: string;
  source_model: string | null;
  confidence: number;
  created_at: string;
  valid_from: string | null;
  superseded_at: string | null;
  superseded_by: string | null;
  forgotten_at: string | null;
  prev_hash: string;
  entry_hash: string;
  metadata: Record<string, unknown> | null;
}

export interface RememberInput {
  content: string;
  type: MemoryType;
  scope?: string;
  source?: string;
  sourceModel?: string | null;
  confidence?: number;
  metadata?: Record<string, unknown> | null;
}

export interface ListFilter {
  type?: MemoryType;
  scope?: string;
  /** Include tombstoned (forgotten) entries. Default false. */
  includeForgotten?: boolean;
  /** Capability allowlist: if set, ONLY these scopes are visible, regardless
   * of any `scope` filter. Undefined = full access (the vault owner). This is
   * the enforcement point for scoped connections (M4). */
  allowedScopes?: string[];
}

export interface RetrieveOptions {
  type?: MemoryType;
  scope?: string;
  limit?: number;
  /** Capability allowlist — see ListFilter.allowedScopes. */
  allowedScopes?: string[];
}

/** True when `scope` is permitted by an allowlist (undefined allowlist = all). */
export function scopeAllowed(scope: string, allowedScopes: string[] | undefined): boolean {
  return allowedScopes === undefined || allowedScopes.includes(scope);
}

export interface ScoredEntry {
  entry: MemoryEntry;
  score: number;
}

export interface ExportedMemory {
  id: string;
  type: MemoryType;
  content: string;
  scope: string;
  provenance: {
    source: string;
    source_model: string | null;
    confidence: number;
    created_at: string;
    prev_hash: string;
    entry_hash: string;
  };
  validity: {
    valid_from: string | null;
    superseded_at: string | null;
    superseded_by: string | null;
    forgotten_at: string | null;
  };
  metadata: Record<string, unknown> | null;
}

export interface VaultExport {
  northkeep_export: {
    schema_version: string;
    vault_id: string;
    exported_at: string;
    chain_head: string;
  };
  memories: ExportedMemory[];
}

export const SCHEMA_VERSION = '0.2';
export const GENESIS_HASH = '0'.repeat(64);
