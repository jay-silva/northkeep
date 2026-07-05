import {
  PASTE_PROMPT,
  parseChatgptExport,
  parseClaudeExport,
  parsePasteFile,
  type ImportSource,
  type MemoryCandidate,
} from '@northkeep/importers';
import { EXTRACT_MODEL, dedupeCandidates, runImport } from '@northkeep/librarian';
import type { MemoryEntry, Vault } from '@northkeep/core';
import { promptLine } from './prompt.js';

export interface ImportCmdOptions {
  scope: string;
  yes: boolean;
  dryRun: boolean;
  limit?: number;
}

export interface ImportOutcome {
  approved: MemoryCandidate[];
  source: ImportSource;
  model: string;
}

/**
 * Phases 1–3 of an import: parse → extract → dedupe → review. Runs WITHOUT
 * the vault open or locked (extraction takes minutes, review takes human
 * time). The caller writes the approved candidates in a short locked window.
 */
export async function prepareImport(
  source: string,
  filePath: string | undefined,
  existing: MemoryEntry[],
  options: ImportCmdOptions,
): Promise<ImportOutcome | null> {
  if (!['chatgpt', 'claude', 'paste'].includes(source)) {
    throw new Error(`Unknown import source "${source}". Use: chatgpt | claude | paste | prompt.`);
  }
  if (!filePath) throw new Error(`Usage: northkeep import ${source} <file>`);

  let candidates: MemoryCandidate[];
  let degraded = false;
  let duplicatesDropped = 0;
  let conflicts: Array<{ candidate: string; existing: string }> = [];
  let model = EXTRACT_MODEL;

  if (source === 'paste') {
    const parsed = parsePasteFile(filePath);
    if (parsed.length === 0) {
      throw new Error(
        'No memory lines found. The file should contain lines like "- [semantic] The user ..." — ' +
          'run "northkeep import prompt" to get the prompt that produces them.',
      );
    }
    const deduped = dedupeCandidates(parsed, existing);
    candidates = deduped.unique;
    duplicatesDropped = deduped.duplicatesDropped;
    conflicts = deduped.conflicts;
    model = 'paste';
  } else {
    const conversations =
      source === 'chatgpt' ? parseChatgptExport(filePath) : parseClaudeExport(filePath);
    if (conversations.length === 0) throw new Error('No conversations found in that file.');
    console.log(`Found ${conversations.length} conversations.`);

    const result = await runImport(conversations, {
      existing,
      limit: options.limit,
      onProgress: (done, total, mode) => {
        if (done % 10 === 0 || done === total) {
          process.stderr.write(`\r  extracting ${done}/${total} (${mode})   `);
        }
      },
    });
    process.stderr.write('\n');
    candidates = result.candidates;
    degraded = result.degraded;
    duplicatesDropped = result.duplicatesDropped;
    conflicts = result.conflicts;
    if (result.degraded) model = 'heuristic';
  }

  if (degraded) {
    console.log('');
    console.log('⚠  DEGRADED EXTRACTION — Ollama (local AI) is not available.');
    console.log(`   Using conservative pattern matching instead of ${EXTRACT_MODEL}.`);
    console.log('   Results will be rougher and less complete. To fix:');
    console.log('   brew install ollama && brew services start ollama && ollama pull llama3.2:3b');
    console.log('');
  }

  printSummary(candidates, duplicatesDropped, conflicts);
  if (candidates.length === 0) return null;

  if (options.dryRun) {
    console.log('Dry run — nothing was written. Re-run without --dry-run to import.');
    return null;
  }

  let approved: MemoryCandidate[];
  if (options.yes) {
    approved = candidates;
  } else {
    if (!process.stdin.isTTY) {
      throw new Error('No terminal for the review step. Use --yes to accept all, or run interactively.');
    }
    approved = await review(candidates);
  }
  if (approved.length === 0) {
    console.log('Nothing approved — vault untouched.');
    return null;
  }
  return { approved, source: source as ImportSource, model };
}

/** Phase 4: write approved candidates. Called inside the vault lock. */
export function writeApproved(vault: Vault, outcome: ImportOutcome, scope: string): number {
  for (const candidate of outcome.approved) {
    vault.remember({
      content: candidate.content,
      type: candidate.type,
      scope,
      source: `import:${outcome.source}`,
      sourceModel: outcome.model,
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
  return outcome.approved.length;
}

function printSummary(
  candidates: MemoryCandidate[],
  duplicatesDropped: number,
  conflicts: Array<{ candidate: string; existing: string }>,
): void {
  const byType = new Map<string, number>();
  for (const candidate of candidates) {
    byType.set(candidate.type, (byType.get(candidate.type) ?? 0) + 1);
  }
  console.log(`\n${candidates.length} memory candidates` +
    (duplicatesDropped > 0 ? ` (${duplicatesDropped} duplicates dropped)` : '') + ':');
  for (const [type, count] of [...byType.entries()].sort()) {
    console.log(`  ${type}: ${count}`);
  }
  if (conflicts.length > 0) {
    console.log(`\n⚠  ${conflicts.length} possible conflicts with what the vault already knows` +
      ' (imported anyway if approved — review these):');
    for (const conflict of conflicts.slice(0, 10)) {
      console.log(`  new:      ${truncate(conflict.candidate)}`);
      console.log(`  existing: ${truncate(conflict.existing)}`);
    }
  }
  if (candidates.length > 0) {
    console.log('\nSample:');
    for (const candidate of candidates.slice(0, 5)) {
      console.log(`  [${candidate.type} ${candidate.confidence.toFixed(1)}] ${truncate(candidate.content)}`);
    }
    console.log('');
  }
}

async function review(candidates: MemoryCandidate[]): Promise<MemoryCandidate[]> {
  const choice = await promptLine(
    `Import all ${candidates.length}, review each, or quit? [a/r/q] `,
  );
  if (choice.toLowerCase() === 'a') return candidates;
  if (choice.toLowerCase() !== 'r') return [];
  const approved: MemoryCandidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    console.log(`\n(${index + 1}/${candidates.length}) [${candidate.type} ${candidate.confidence.toFixed(1)}]`);
    console.log(`  ${candidate.content}`);
    const answer = await promptLine('  keep? [y/n/q] ');
    if (answer.toLowerCase() === 'q') break;
    if (answer.toLowerCase() === 'y') approved.push(candidate);
  }
  return approved;
}

function truncate(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export { PASTE_PROMPT };
