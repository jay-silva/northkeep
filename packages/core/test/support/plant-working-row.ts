/**
 * Test only. Writes a working row straight into a project scope, the way an
 * older build, another device or a hand edit can leave one, without the checks
 * every NorthKeep door now runs (ADR 0065). Fixtures use it to plant broken,
 * duplicate or legacy project documents. Touches the vault's private writer on
 * purpose: no product code may do this.
 */
interface Planted { id: string; type: string; content: string; scope: string; created_at: string; entry_hash: string; metadata: Record<string, unknown> | null }

export function plantWorkingRow(
  vault: unknown,
  input: { content: string; scope: string; type?: string; source?: string; metadata?: Record<string, unknown> | null; confidence?: number; sourceModel?: string | null },
): Planted {
  const v = vault as {
    makeProjectEntry(type: string, content: string, scope: string, source: string, metadata: Record<string, unknown> | null, prevHash: string, now: string): Planted;
    prepareEntryInsert(): { run(params: unknown): unknown };
    entryParams(entry: Planted): unknown;
    getMeta(key: string): string;
    setMeta(key: string, value: string): void;
  };
  const entry = v.makeProjectEntry('working', input.content, input.scope.trim(), input.source?.trim() || 'cli', input.metadata ?? null, v.getMeta('chain_head'), new Date().toISOString());
  v.prepareEntryInsert().run(v.entryParams(entry));
  v.setMeta('chain_head', entry.entry_hash);
  return entry;
}
