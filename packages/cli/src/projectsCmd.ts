import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BOARD_DEFAULT_STALE_DAYS,
  BOARD_MAX_STALE_DAYS,
  Vault,
  VaultAuthError,
  deriveMasterKey,
  listProjectViews,
  loadDeviceSecret,
  memzero,
  PROJECT_SECTION_HEADINGS,
  ProjectHandoffError,
  projectScope,
  summarizeMirror,
  withFileLock,
  type BoardSection,
  type ImportFilePlan,
  type ProjectBoard,
  type ProjectCompactionResult,
  PROJECT_IMPORT_PUSH_MAX_BYTES,
  PROJECT_IMPORT_ROW_MAX_BYTES,
} from '@northkeep/core';
import {
  ExportRefusal,
  GitCommandError,
  INDEX_NOT_REFRESHED,
  RENDER_FAILED,
  collectBoard,
  exportProjects,
  importProjects,
  installSchedule,
  parseScheduleTime,
  readExportSettings,
  maskProjectFields,
  readCallLogStrict,
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
  options: { title?: string; whatWhy?: string; status?: string; nextActions?: string; openQuestions?: string; decision?: string; log?: string },
  withVault: WithVault,
  fail: (m: string) => never,
): Promise<void> {
  const fields = {
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.whatWhy !== undefined ? { what_why: options.whatWhy } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.nextActions !== undefined ? { next_actions: options.nextActions } : {}),
    ...(options.openQuestions !== undefined ? { open_questions: options.openQuestions } : {}),
    ...(options.decision !== undefined ? { decision: options.decision } : {}),
    ...(options.log !== undefined ? { log_entry: options.log } : {}),
  };
  if (Object.keys(fields).length === 0) fail('Give at least one of --title, --what-why, --status, --next-actions, --open-questions, --decision or --log.');
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

function entries(n: number): string {
  return n === 1 ? '1 entry' : `${n} entries`;
}

export interface DeleteDeps {
  withVault: WithVault;
  fail: (m: string) => never;
  /** Asks one question; null when there is no terminal to ask on. */
  ask: (question: string) => Promise<string | null>;
  out?: (line: string) => void;
}

/**
 * `northkeep projects delete`: forget every live entry in a project's scope,
 * archives and overflow included, so a slug left with archives only can be
 * imported again. Asks first, outside the vault lock, unless --yes.
 */
export async function projectsDeleteCmd(slug: string, options: { yes?: boolean }, deps: DeleteDeps): Promise<void> {
  const out = deps.out ?? ((line: string) => console.log(line));
  let scope: string;
  try {
    scope = projectScope(slug);
  } catch {
    deps.fail('Project slug is invalid: use lowercase letters, digits and hyphens.');
  }
  const live = await deps.withVault((vault) => vault.list({ scope, includeSuperseded: true }).length);
  if (live === 0) deps.fail(`Project ${slug} has no entries in this vault; nothing was deleted.`);
  if (options.yes !== true) {
    const answer = await deps.ask(
      `This forgets ${entries(live)} in project ${slug}: its document, log archives and any other notes in its scope. ` +
        'Their text cannot be recovered. Continue? [y/N] ',
    );
    if (answer === null) deps.fail('No terminal to confirm on. Add --yes to delete without asking.');
    if (!/^y(es)?$/i.test(answer.trim())) deps.fail('Cancelled. Nothing was deleted.');
  }
  type Outcome = { error: string } | { error?: undefined; count: number };
  const outcome: Outcome = await deps.withVault((vault): Outcome => {
    try {
      const count = vault.deleteProject(slug);
      vault.save();
      return { count };
    } catch (err) {
      if (err instanceof ProjectHandoffError && err.code === 'not_found') {
        return { error: `Project ${slug} has no entries in this vault; nothing was deleted.` };
      }
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  if (outcome.error !== undefined) deps.fail(outcome.error);
  out(`✓ Deleted project ${slug}: forgot ${entries(outcome.count)}.`);
  out('  Note: the previous vault state remains in vault.nkv.bak until the next write.');
}

// ---- the local mirror (ADR 0053 M-A1) ------------------------------------------------------

export interface MirrorDeps {
  home: string;
  vaultPath: string;
  /** Opens the vault for this command; may prompt once. Never called by --scheduled or --schedule. */
  vaultRunner: () => Promise<VaultRunner>;
  /** Tests only. The launchd job leaves it unset so the export layer never prompts. */
  scheduledRunner?: VaultRunner;
  /** Tests only: how long the launchd run waits for the export lock. */
  scheduledLockWaitMs?: number;
  schedule?: { cliEntry: string; plistDir?: string; load?: boolean };
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface ExportCmdOptions {
  repo?: string;
  verify?: boolean;
  status?: boolean;
  schedule?: string;
  /** With --schedule daily: the local time, HH:MM. */
  at?: string;
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
      ...(deps.scheduledLockWaitMs !== undefined ? { lockWaitMs: deps.scheduledLockWaitMs } : {}),
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

/** A stored ISO stamp in local time, e.g. "2026-09-23 12:00 EDT"; the raw text if it does not parse. */
export function localStamp(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
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
  out(`Last successful export: ${state?.last_success ? `${localStamp(state.last_success.at)}, commit ${state.last_success.commit}` : 'never'}`);
  out(`Projects changed since: ${changed.length === 0 ? 'none' : changed.join(', ')}`);
  if (!state || state.refused.length === 0) out('Refused paths: none');
  else for (const r of state.refused) out(`Refused path: ${r.path}: ${refusalText(r.reason)}`);
  const failure = state?.last_failure;
  // The record keeps the last failure after later successes; say so instead of implying it is current.
  const resolved = failure && state?.last_success && Date.parse(state.last_success.at) > Date.parse(failure.at);
  out(failure ? `Last failure: ${localStamp(failure.at)}, ${failure.code}${FAILURE_TEXT[failure.code] ? ` (${FAILURE_TEXT[failure.code]})` : ''}${resolved ? '. A later export succeeded' : ''}` : 'Last failure: none');
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
  let at: { hour: number; minute: number } | undefined;
  if (options.at !== undefined) {
    if (value !== 'daily') {
      err('✗ --at works only with --schedule daily.');
      return 1;
    }
    const parsed = parseScheduleTime(options.at);
    if (parsed === null) {
      err('✗ --at takes a 24-hour time such as 12:00.');
      return 1;
    }
    at = parsed;
  }
  const file = await installSchedule(value, { cliEntry: sched.cliEntry, ...where, ...(at ? { at } : {}) });
  const when = `${String(at?.hour ?? 3).padStart(2, '0')}:${String(at?.minute ?? 0).padStart(2, '0')}`;
  out(`Installed the ${value} export schedule: ${file}`);
  out(`It runs northkeep projects export ${value === 'hourly' ? 'every hour' : `every day at ${when}`} and commits to ${settings.repo}. It never pushes.`);
  out('The job needs a stored key from northkeep unlock. While the vault is locked, each run records a failure that --status shows.');
  out('Turn it off with northkeep projects export --schedule off.');
  return 0;
}

// ---- import (ADR 0053 Decision 10) ---------------------------------------------------------

const KNOWN_SECTIONS = new Set<string>([...PROJECT_SECTION_HEADINGS, 'Open Questions', 'Files']);

/** The summary for the file's own line, then one indented line per list, so long lists stay readable. */
function planLines(p: ImportFilePlan): { summary: string; details: string[] } {
  const bytes = Buffer.byteLength(p.document, 'utf8').toLocaleString('en-US');
  const summary = [
    `${bytes} bytes`,
    plural(p.archives.length, 'log archive'),
    p.overflow_parts.length === 0 ? 'no overflow' : plural(p.overflow_parts.length, 'overflow part'),
  ].join(', ');
  const details: string[] = [];
  const renamed = p.sections.filter((s) => s.from !== s.to).map((s) => `${s.from} stored as ${s.to}`);
  if (renamed.length > 0) details.push(`renamed: ${renamed.join(', ')}`);
  // Unknown headings are shown so a heading split out of a code fence is visible before --write.
  const docLines = p.document.split('\n');
  const other = p.sections.filter(
    (s, i) => s.from === s.to && !KNOWN_SECTIONS.has(s.to) && !(i === 0 && docLines.includes(`# ${s.from}`)),
  );
  if (other.length > 0) details.push(`other sections: ${other.map((s) => s.from).join(', ')}`);
  if (p.overflow_sections.length > 0) details.push(`moved to overflow: ${p.overflow_sections.join(', ')}`);
  if (p.log_files.length > 0) details.push(`log files: ${p.log_files.join(', ')}`);
  return { summary, details };
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
    // The dry run opens the vault too, read only, so a slug that is taken shows now rather than at --write.
    const runner: VaultRunner = await deps.vaultRunner();
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
    else if (f.status === 'refused') out(`Refused ${f.name}${f.slug ? ` (${f.slug})` : ''}: ${sentence(f.reason ?? 'import failed')}`);
    else if (f.status === 'exists') out(`Exists ${f.name} (${f.slug}): ${sentence(f.reason ?? 'the vault already has this project')}`);
    else {
      const lines = plan ? planLines(plan) : { summary: '', details: [] };
      out(`${f.status === 'imported' ? 'Imported' : 'Would import'} ${f.name} as ${f.slug}: ${lines.summary}`);
      for (const d of lines.details) out(`  ${d}`);
    }
  }
  const skipped = res.files.filter((f) => f.status === 'skipped').length;
  if (!write) {
    const would = res.files.filter((f) => f.status === 'would import').length;
    const exists = res.files.filter((f) => f.status === 'exists').length;
    const n = (x: number) => x.toLocaleString('en-US');
    out(`Largest row: ${n(res.plan.largest_row_bytes)} bytes (limit ${n(PROJECT_IMPORT_ROW_MAX_BYTES)}). Total: ${n(res.plan.total_bytes)} bytes of the ${n(PROJECT_IMPORT_PUSH_MAX_BYTES)}-byte sync limit.`);
    if (res.plan.total_bytes > PROJECT_IMPORT_PUSH_MAX_BYTES) {
      out('Note: that is more than one sync push carries. Import fewer files at a time.');
    }
    out(`Dry run: ${plural(would, 'file')} would be imported, ${exists} already in the vault, ${refused} refused, ${skipped} skipped. Nothing was written; add --write to import.`);
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

/**
 * `northkeep projects board` (ADR 0054): the owner's view of every project,
 * read-only. No connection, so no grant to narrow; no call-log row, like
 * every CLI read. Masks under NORTHKEEP_REDACT_TIER=1 the way the MCP tool does.
 */
export async function projectsBoardCmd(
  options: { staleDays?: string; json?: boolean },
  withVault: WithVault,
  fail: (m: string) => never,
  out: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  let staleDays = BOARD_DEFAULT_STALE_DAYS;
  if (options.staleDays !== undefined) {
    if (!/^\d{1,4}$/.test(options.staleDays) || Number(options.staleDays) > BOARD_MAX_STALE_DAYS) {
      fail(`Stale days must be a whole number from 0 to ${BOARD_MAX_STALE_DAYS}.`);
    }
    staleDays = Number(options.staleDays);
  }
  const board = await withVault((vault) =>
    collectBoard(vault, { granted: undefined, now: new Date(), staleDays, currentSessionId: '', readLog: readCallLogStrict }).board,
  );
  const tier = process.env.NORTHKEEP_REDACT_TIER === '1' ? 1 : 0;
  const masked = maskProjectFields(board, tier) as ProjectBoard;
  if (options.json === true) {
    out(JSON.stringify(masked, null, 2));
    return;
  }
  for (const line of renderBoard(masked)) out(line);
}

function sectionLines<T>(title: string, section: BoardSection<T>, row: (r: T) => string): string[] {
  const lines = ['', `${title} (${section.total})`];
  if (section.total === 0) lines.push('  None.');
  for (const r of section.rows) lines.push(`  ${row(r)}`);
  if (section.shown < section.total) lines.push(`  Showing ${section.shown} of ${section.total}.`);
  return lines;
}

/** Every string here is already made safe and capped by the board, so it is printed as is. */
export function renderBoard(board: ProjectBoard): string[] {
  const lines = [
    `Project board, ${board.generated_at.slice(0, 10)}. Stale means no activity for more than ${board.stale_days} ${board.stale_days === 1 ? 'day' : 'days'}.`,
    `Done rule: ${board.done_rule}`,
  ];
  lines.push(...sectionLines('Stale', board.stale, (r) => `${r.project}  ${r.activity_source} ${r.last_activity.slice(0, 10)}  ${r.status}`));
  lines.push(...sectionLines('Dated items', board.dated, (r) => `${r.date}  ${r.project}  ${r.line}`));
  if ('unavailable' in board.open_sessions) {
    lines.push('', 'Open sessions (unavailable)', `  ${board.open_sessions.unavailable}`);
  } else {
    lines.push(...sectionLines('Open sessions', board.open_sessions, (r) => `${r.project}  ${r.host}  last read ${r.last_read_at}  session ${r.session_id.slice(0, 8)}`));
  }
  lines.push(...sectionLines('Drafts', board.drafts, (r) => `${r.project}  since ${r.updated_at.slice(0, 10)}`));
  lines.push(...sectionLines('Needs repair', board.needs_repair, (r) => `${r.project}  ${r.reason === 'conflict' ? 'conflict: more than one current document' : 'unreadable: the document could not be read'}`));
  return lines;
}
