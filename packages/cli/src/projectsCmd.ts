import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  Vault,
  VaultAuthError,
  deriveMasterKey,
  listProjectViews,
  loadDeviceSecret,
  memzero,
  PROJECT_SECTION_HEADINGS,
  summarizeMirror,
  withFileLock,
  type ImportFilePlan,
  type ProjectCompactionResult,
} from '@northkeep/core';
import {
  ExportRefusal,
  GitCommandError,
  INDEX_NOT_REFRESHED,
  RENDER_FAILED,
  exportProjects,
  importProjects,
  installSchedule,
  readExportSettings,
  readExportState,
  readRemotes,
  removeSchedule,
  resolveMasterKey,
  schedulePlistPath,
  verifyMirror,
  type ExportRunResult,
  type ImportRunResult,
  type RemoteInfo,
  type VaultRunner,
} from '@northkeep/mcp-server';
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
  console.log('  Note: the previous vault state remains in vault.nkv.bak until the next write.');
}

/**
 * `northkeep projects update`: create or edit one project document from the
 * terminal. The acceptance steps for ADR 0053 create and change projects this
 * way, so the mirror can be exercised without an AI app attached.
 */
export async function projectsUpdateCmd(
  slug: string,
  options: { title?: string; whatWhy?: string; status?: string; nextActions?: string; decision?: string; log?: string },
  withVault: WithVault,
  fail: (m: string) => never,
): Promise<void> {
  const fields = {
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.whatWhy !== undefined ? { what_why: options.whatWhy } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.nextActions !== undefined ? { next_actions: options.nextActions } : {}),
    ...(options.decision !== undefined ? { decision: options.decision } : {}),
    ...(options.log !== undefined ? { log_entry: options.log } : {}),
  };
  if (Object.keys(fields).length === 0) fail('Give at least one of --title, --what-why, --status, --next-actions, --decision or --log.');
  type Outcome = { error: string } | { error?: undefined; created: boolean; revision: string };
  const outcome: Outcome = await withVault((vault): Outcome => {
    const current = listProjectViews(vault).find((s) => s.project === slug);
    if (current?.conflict) return { error: `Project ${slug} has two live documents; resolve that before editing it.` };
    try {
      const view = vault.updateProject({
        project: slug,
        expected_revision: current?.revision ?? null,
        ...fields,
        writer: { host: 'northkeep-cli', session_id: crypto.randomUUID() },
      });
      vault.save();
      return { created: current === undefined, revision: view.revision };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  if (outcome.error !== undefined) fail(outcome.error);
  console.log(`✓ ${outcome.created ? 'Created' : 'Updated'} project ${slug} (revision ${outcome.revision.slice(0, 8)}).`);
}

// ---- the local mirror (ADR 0053 M-A1) ------------------------------------------------------

export interface MirrorDeps {
  home: string;
  vaultPath: string;
  /** Opens the vault for this command; may prompt once. Never called by --scheduled or --schedule. */
  vaultRunner: () => Promise<VaultRunner>;
  /** Tests only. The launchd job leaves it unset so the export layer never prompts. */
  scheduledRunner?: VaultRunner;
  schedule?: { cliEntry: string; plistDir?: string; load?: boolean };
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface ExportCmdOptions {
  repo?: string;
  verify?: boolean;
  status?: boolean;
  schedule?: string;
  scheduled?: boolean;
  /** Test only: install or remove the plist without calling launchctl. */
  skipLaunchctl?: boolean;
  json?: boolean;
}

/** Plain text for an error from the export layer. Git's own output is never shown. */
export function describeMirrorError(err: unknown): string {
  if (err instanceof ExportRefusal) {
    if (err.code === 'bad_blob') return 'NorthKeep refused a malformed file id from git; nothing was written for it';
    return err.message;
  }
  if (err instanceof GitCommandError) {
    return `A git step (${err.verb}) ${err.reason === 'timeout' ? 'timed out' : 'failed'}. Check the mirror folder with git status, then try again`;
  }
  // A system error's message names an absolute path; only its code is shown.
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (err instanceof Error && typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    return `A file operation failed (${code}). Check the permissions of the mirror folder and the NorthKeep folder, then try again`;
  }
  return err instanceof Error ? err.message : String(err);
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function refusalText(reason: string): string {
  if (reason === 'hand edit') return 'hand edit. Move or delete the file; NorthKeep then writes it fresh.';
  if (reason === 'changed while writing') return 'the file changed while NorthKeep was writing it. Export again.';
  if (reason === RENDER_FAILED) return 'render failed. The project could not be read, so its file was left as it was.';
  if (reason === 'unreadable') return 'unreadable. Check the file permissions; NorthKeep left it as it was.';
  if (reason === 'unwritable') return 'could not be written. Check the folder permissions; NorthKeep left it as it was.';
  if (reason === 'NorthKeep refused a malformed blob id') return 'NorthKeep refused a malformed file id from git.';
  return sentence(reason);
}

const FAILURE_TEXT: Record<string, string> = {
  vault_locked: 'the vault was locked; run northkeep unlock so the schedule can open it',
  export_busy: 'another export was running on this folder',
  lock_unreadable: 'the export lock file was unreadable; see the export command for how to clear it',
  lock_lost: 'the run lost the export lock before committing',
  tree_check_failed: 'a commit that would have dropped files was refused',
  nothing_exported: 'every project file was refused; see Refused paths',
  not_configured: 'no mirror was configured',
  git_error: 'a git step failed',
};

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export async function projectsExportCmd(options: ExportCmdOptions, deps: MirrorDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const modes = [options.verify, options.status, options.schedule !== undefined, options.scheduled].filter(Boolean).length;
  if (modes > 1) {
    err('✗ Choose only one of --verify, --status and --schedule.');
    return 1;
  }
  if (options.repo !== undefined && modes > 0) {
    err('✗ --repo applies only to a plain export; later commands use the recorded folder.');
    return 1;
  }
  if (options.scheduled) return scheduledExport(deps);
  try {
    if (options.schedule !== undefined) return await scheduleCmd(options.schedule, options, deps, out, err);
    if (options.verify) return await verifyCmd(options, deps, out);
    if (options.status) return await statusCmd(options, deps, out);
    return await exportCmd(options, deps, out);
  } catch (e) {
    err(`✗ ${sentence(describeMirrorError(e))}`);
    return 1;
  }
}

/** The launchd job: no prompt, no output. A failure is recorded in the state file by the export layer. */
async function scheduledExport(deps: MirrorDeps): Promise<number> {
  try {
    const res = await exportProjects({
      home: deps.home,
      vaultPath: deps.vaultPath,
      by: 'schedule',
      ...(deps.scheduledRunner ? { withVault: deps.scheduledRunner } : {}),
    });
    return res.refused.length > 0 ? 1 : 0;
  } catch {
    return 1;
  }
}

async function exportCmd(options: ExportCmdOptions, deps: MirrorDeps, out: (l: string) => void): Promise<number> {
  const runner = await deps.vaultRunner();
  const recorded = readExportSettings(deps.home)?.repo ?? null;
  let res: ExportRunResult;
  try {
    res = await exportProjects({
      home: deps.home,
      vaultPath: deps.vaultPath,
      by: 'cli',
      withVault: runner,
      ...(options.repo !== undefined ? { repo: options.repo } : {}),
    });
  } catch (e) {
    // A new folder was named: the restore hint in the layer's wording fits an existing mirror, not this.
    if (e instanceof ExportRefusal && e.code === 'not_owned' && options.repo !== undefined && realOrSelf(options.repo) !== recorded) {
      throw new ExportRefusal(
        'not_owned',
        'A new mirror needs an empty folder after git init: nothing but .git and no commits yet. NorthKeep never takes over a folder that already has files',
      );
    }
    throw e;
  }
  if (options.json) {
    out(JSON.stringify(res, null, 2));
    return res.refused.length > 0 ? 1 : 0;
  }
  out(`Mirror folder: ${res.repo}`);
  for (const p of res.written) out(`Wrote ${p}`);
  for (const p of res.removed) out(`Removed ${p}`);
  for (const r of res.refused) out(`Refused ${r.path}: ${refusalText(r.reason)}`);
  for (const slug of res.conflicts) out(`Skipped projects/${slug}.md: two live documents, not exported.`);
  for (const p of res.oversize) out(`Note: ${p} is over 64 KB; it was exported anyway.`);
  out(res.commit ? `Committed ${res.commit}.` : 'No changes; nothing to commit.');
  if (res.note === INDEX_NOT_REFRESHED) {
    out('Note: the commit landed, but git status may show the mirror files as changed until the next export.');
  }
  if (res.refused.length > 0) {
    out(`${plural(res.refused.length, 'path')} refused; everything else was exported.`);
    return 1;
  }
  return 0;
}

async function verifyCmd(options: ExportCmdOptions, deps: MirrorDeps, out: (l: string) => void): Promise<number> {
  const runner = await deps.vaultRunner();
  const res = await verifyMirror({ home: deps.home, vaultPath: deps.vaultPath, withVault: runner });
  if (options.json) {
    out(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  out(`Mirror folder: ${res.repo}`);
  for (const e of res.entries) out(`${e.path}: ${e.status}`);
  const matching = res.entries.filter((e) => e.status === 'matches').length;
  out(res.ok ? `All ${plural(res.entries.length, 'path')} match.` : `${matching} of ${plural(res.entries.length, 'path')} match.`);
  return res.ok ? 0 : 1;
}

async function statusCmd(options: ExportCmdOptions, deps: MirrorDeps, out: (l: string) => void): Promise<number> {
  const settings = readExportSettings(deps.home);
  if (settings === null) {
    out('No mirror is configured. Run northkeep projects export --repo <folder> once to start one.');
    return 0;
  }
  const runner = await deps.vaultRunner();
  const { vaultId, summaries } = await runner((v) => ({ vaultId: v.getVaultId(), summaries: listProjectViews(v) }));
  const state = readExportState(deps.home, settings.repo, vaultId, settings.mirror_id ?? null);
  const exported = state?.projects ?? {};
  const changed = summaries
    .filter((s) => !s.conflict && s.revision !== null && exported[s.project]?.revision !== s.revision)
    .map((s) => s.project);
  let remotes: RemoteInfo[] | null = null;
  let remoteError: string | null = null;
  try {
    remotes = await readRemotes({ repo: settings.repo, home: deps.home, vaultPath: deps.vaultPath });
  } catch (e) {
    remoteError = describeMirrorError(e);
  }
  if (options.json) {
    out(JSON.stringify({ repo: settings.repo, state, changed, remotes }, null, 2));
    return 0;
  }
  const line = summarizeMirror(state ?? {}, summaries, new Date());
  out(`Mirror folder: ${settings.repo}`);
  out(line.charAt(0).toUpperCase() + line.slice(1));
  out(`Last successful export: ${state?.last_success ? `${state.last_success.at}, commit ${state.last_success.commit}` : 'never'}`);
  out(`Projects changed since: ${changed.length === 0 ? 'none' : changed.join(', ')}`);
  if (!state || state.refused.length === 0) out('Refused paths: none');
  else for (const r of state.refused) out(`Refused path: ${r.path}: ${refusalText(r.reason)}`);
  const failure = state?.last_failure;
  out(failure ? `Last failure: ${failure.at}, ${failure.code}${FAILURE_TEXT[failure.code] ? ` (${FAILURE_TEXT[failure.code]})` : ''}` : 'Last failure: none');
  if (remoteError !== null) out(`Remotes: could not be read. ${sentence(remoteError)}`);
  else if (!remotes || remotes.length === 0) out('Remotes: none');
  else for (const r of remotes) out(`Remote ${r.name}: ${r.url}`);
  out('NorthKeep never pushes; a push you make publishes the mirror.');
  return 0;
}

async function scheduleCmd(value: string, options: ExportCmdOptions, deps: MirrorDeps, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  const sched = deps.schedule;
  if (!sched) throw new Error('The export schedule is not available from here');
  // The launchd job cannot carry --vault, so it always opens the default vault.
  const defaultVault = path.join(deps.home, 'vault.nkv');
  if (value !== 'off' && path.resolve(deps.vaultPath) !== defaultVault) {
    err(`✗ The schedule exports only the default vault (${defaultVault}). Run --schedule without --vault.`);
    return 1;
  }
  const load = options.skipLaunchctl ? false : sched.load;
  const where = { ...(sched.plistDir !== undefined ? { plistDir: sched.plistDir } : {}), ...(load !== undefined ? { load } : {}) };
  if (value === 'off') {
    const file = schedulePlistPath(sched.plistDir);
    out((await removeSchedule(where)) ? `Removed the export schedule (${file}).` : 'No export schedule was installed.');
    return 0;
  }
  if (value !== 'hourly' && value !== 'daily') {
    err('✗ --schedule takes hourly, daily or off.');
    return 1;
  }
  const settings = readExportSettings(deps.home);
  if (settings === null) {
    err('✗ No mirror is configured. Run northkeep projects export --repo <folder> once, then set the schedule.');
    return 1;
  }
  const file = await installSchedule(value, { cliEntry: sched.cliEntry, ...where });
  out(`Installed the ${value} export schedule: ${file}`);
  out(`It runs northkeep projects export ${value === 'hourly' ? 'every hour' : 'every day at 03:00'} and commits to ${settings.repo}. It never pushes.`);
  out('The job needs a stored key from northkeep unlock. While the vault is locked, each run records a failure that --status shows.');
  out('Turn it off with northkeep projects export --schedule off.');
  return 0;
}

// ---- import (ADR 0053 Decision 10) ---------------------------------------------------------

const KNOWN_SECTIONS = new Set<string>([...PROJECT_SECTION_HEADINGS, 'Open Questions', 'Files']);

function planLine(p: ImportFilePlan): string {
  const bytes = Buffer.byteLength(p.document, 'utf8').toLocaleString('en-US');
  const parts = [
    `${bytes} bytes`,
    plural(p.archives.length, 'log archive'),
    p.overflow_parts.length === 0 ? 'no overflow' : plural(p.overflow_parts.length, 'overflow part'),
  ];
  for (const s of p.sections) if (s.from !== s.to) parts.push(`${s.from} stored as ${s.to}`);
  // Unknown headings are shown so a heading split out of a code fence is visible before --write.
  const docLines = p.document.split('\n');
  const other = p.sections.filter(
    (s, i) => s.from === s.to && !KNOWN_SECTIONS.has(s.to) && !(i === 0 && docLines.includes(`# ${s.from}`)),
  );
  if (other.length > 0) parts.push(`other sections: ${other.map((s) => s.from).join(', ')}`);
  if (p.overflow_sections.length > 0) parts.push(`moved to overflow: ${p.overflow_sections.join(', ')}`);
  if (p.log_files.length > 0) parts.push(`log files: ${p.log_files.join(', ')}`);
  return parts.join(', ');
}

export async function projectsImportCmd(
  options: { from: string; write?: boolean; json?: boolean },
  deps: Pick<MirrorDeps, 'vaultPath' | 'vaultRunner' | 'out' | 'err'>,
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  let isDir = false;
  try {
    isDir = fs.statSync(options.from).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    err('✗ The import folder does not exist or is not a folder.');
    return 1;
  }
  const write = options.write === true;
  let res: ImportRunResult;
  try {
    // A dry run never opens the vault; the stand-in runner proves it.
    const runner: VaultRunner = write
      ? await deps.vaultRunner()
      : async () => {
          throw new Error('A dry run does not open the vault');
        };
    res = await importProjects(options.from, { write, vaultPath: deps.vaultPath, withVault: runner });
  } catch (e) {
    err(`✗ ${sentence(describeMirrorError(e))}`);
    return 1;
  }
  const refused = res.files.filter((f) => f.status === 'refused').length;
  if (options.json) {
    out(JSON.stringify(res, null, 2));
    return refused > 0 ? 1 : 0;
  }
  const plans = new Map(res.plan.projects.map((p) => [p.name, p]));
  for (const f of res.files) {
    const plan = plans.get(f.name);
    if (f.status === 'skipped') out(`Skip ${f.name}: ${sentence(f.reason ?? 'not importable')}`);
    else if (f.status === 'refused') out(`Refused ${f.name} (${f.slug}): ${sentence(f.reason ?? 'import failed')}`);
    else out(`${f.status === 'imported' ? 'Imported' : 'Would import'} ${f.name} as ${f.slug}: ${plan ? planLine(plan) : ''}`);
  }
  const skipped = res.files.filter((f) => f.status === 'skipped').length;
  if (!write) {
    out(`Dry run: ${plural(res.plan.projects.length, 'file')} would be imported and ${skipped} skipped. Nothing was written; add --write to import.`);
    return 0;
  }
  const imported = res.files.filter((f) => f.status === 'imported').length;
  out(`Imported ${plural(imported, 'project')}; ${refused} refused, ${skipped} skipped.`);
  return refused > 0 ? 1 : 0;
}

/**
 * One key for the whole command: resolved from the environment or Keychain,
 * or one passphrase prompt, checked with a single open. Resolving here, before
 * the export layer runs, keeps a human typing from holding the export lock and
 * keeps import from asking once per file.
 */
export async function promptOnceRunner(
  vaultPath: string,
  getPassphrase: (prompt: string) => Promise<string>,
): Promise<{ runner: VaultRunner; keyForPush: Buffer | null; dispose: () => void }> {
  const resolved = resolveMasterKey(vaultPath);
  let key: Buffer;
  if (resolved !== null) {
    key = resolved.key;
  } else {
    const passphrase = await getPassphrase('Passphrase: ');
    const header = Vault.readHeader(vaultPath);
    key = deriveMasterKey(passphrase, loadDeviceSecret(), header.salt, header.kdf);
  }
  const open = (): Vault => {
    try {
      return Vault.openWithKey(vaultPath, Buffer.from(key));
    } catch (e) {
      if (e instanceof VaultAuthError && resolved?.source === 'keychain') {
        throw new VaultAuthError(
          'The stored background-access key no longer matches this vault. ' +
            'Run "northkeep unlock" again (or "northkeep lock" to clear it).',
        );
      }
      throw e;
    }
  };
  try {
    await withFileLock(vaultPath, () => open().close());
  } catch (e) {
    memzero(key);
    throw e;
  }
  const runner: VaultRunner = <T>(fn: (vault: Vault) => T | Promise<T>): Promise<T> =>
    withFileLock(vaultPath, async () => {
      const vault = open();
      try {
        return await fn(vault);
      } finally {
        vault.close();
      }
    });
  return { runner, keyForPush: resolved !== null ? Buffer.from(key) : null, dispose: () => memzero(key) };
}
