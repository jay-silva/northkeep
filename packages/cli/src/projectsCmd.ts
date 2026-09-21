import fs from 'node:fs';
import type { ProjectCompactionResult } from '@northkeep/core';
import type { WithVault } from './shareCmd.js';

/**
 * `northkeep projects compact`: free the space old project revisions take up
 * (ADR 0051). A run without --yes reports what would go and changes nothing,
 * because the text of those revisions is not recoverable afterwards.
 */

const COLUMNS = [24, 12, 6, 10, 14] as const;

function row(cells: readonly string[]): string {
  return cells.map((cell, i) => (i === 0 ? cell.padEnd(COLUMNS[i]!) : cell.padStart(COLUMNS[i]!))).join('');
}

function printTable(result: ProjectCompactionResult): void {
  console.log(row(['Project', 'Revisions', 'Kept', 'To blank', 'Bytes']));
  for (const p of result.projects) {
    console.log(row([p.project, String(p.candidates), String(p.kept), String(p.blanked), p.bytes_freed.toLocaleString('en-US')]));
  }
  console.log(row(['Total', '', '', String(result.blanked), result.bytes_freed.toLocaleString('en-US')]));
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function projectsCompactCmd(
  options: { project?: string; keep?: string; yes?: boolean },
  withVault: WithVault,
  fail: (m: string) => never,
): Promise<void> {
  let keep: number | undefined;
  if (options.keep !== undefined) {
    keep = Number(options.keep);
    if (!Number.isInteger(keep) || keep < 1 || keep > 1000) fail('Keep must be a whole number between 1 and 1000.');
  }
  const request = { ...(options.project !== undefined ? { project: options.project } : {}), ...(keep !== undefined ? { keep } : {}) };
  const dryRun = options.yes !== true;

  type Outcome = { error: string } | { error?: undefined; result: ProjectCompactionResult; fileBytes: number | null };
  const outcome: Outcome = await withVault((vault): Outcome => {
    let result: ProjectCompactionResult;
    try {
      result = vault.compactProjectHistory({ ...request, dryRun });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (dryRun || result.blanked === 0) return { result, fileBytes: null };
    vault.save();
    return { result, fileBytes: fs.statSync(vault.path).size };
  });
  if (outcome.error !== undefined) fail(outcome.error);

  printTable(outcome.result);
  console.log('');
  if (dryRun) {
    console.log('Dry run: nothing changed. Add --yes to compact.');
    return;
  }
  if (outcome.result.blanked === 0) {
    console.log('Nothing to compact. Every project revision is either recent or still referenced.');
    return;
  }
  console.log(
    `✓ Blanked ${outcome.result.blanked} old project ${outcome.result.blanked === 1 ? 'revision' : 'revisions'}, ` +
      `freeing ${outcome.result.bytes_freed.toLocaleString('en-US')} bytes of text.`,
  );
  console.log(`  Vault file is now ${megabytes(outcome.fileBytes!)}.`);
  console.log('  The live document, its log archives and the newest revisions are untouched.');
}
