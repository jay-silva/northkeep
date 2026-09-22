import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './fs-safe.js';
import { ExportRefusal, repoKey, runGit, type GitContext } from './git-plumbing.js';

/**
 * Export run state for the local mirror (ADR 0053 Decisions 3, 5, 7 and 9):
 * the write journal that decides ownership, the state file behind --status and
 * the staleness line, the settings file, and the export lock in the
 * repository's common dir. Journal, state and settings writes all require a
 * held lock, so two exports cannot race them. None of these files hold memory
 * content: only paths, blob ids, slugs, revisions and times.
 */

export const JOURNAL_DEPTH = 10;
export const EXPORT_LOCK_NAME = 'northkeep-export.lock';
export const EXPORT_LOCK_STALE_MS = 60 * 60 * 1000;
export const EXPORT_LOCK_WAIT_MS = 30_000;

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// ---- the export lock (Decision 9) ---------------------------------------------------------

export interface ExportLock {
  readonly path: string;
  /** True while the lock file still holds this acquisition's token. */
  held(): boolean;
  release(): void;
}

export interface LockOptions {
  waitMs?: number;
  staleMs?: number;
  pollMs?: number;
}

function readNoFollow(p: string): string | null {
  try {
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      return fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Unparseable owners count as alive; only age can free them. */
function ownerDead(token: string): boolean {
  let pid: unknown;
  try {
    pid = (JSON.parse(token) as { pid?: unknown }).pid;
  } catch {
    return false;
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * O_EXCL lock at `<common dir>/northkeep-export.lock`, shared by every worktree.
 * Stale only when its pid is dead or it is over an hour old; stolen by rename
 * so exactly one contender wins, and released only while it holds our token.
 */
export async function acquireExportLock(ctx: GitContext, opts: LockOptions = {}): Promise<ExportLock> {
  const r = await runGit(ctx, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const lockPath = path.join(r.stdout.replace(/\r?\n$/, ''), EXPORT_LOCK_NAME);
  const waitMs = opts.waitMs ?? EXPORT_LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? EXPORT_LOCK_STALE_MS;
  const pollMs = opts.pollMs ?? 250;
  const token = `${JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
    nonce: crypto.randomBytes(8).toString('hex'),
  })}\n`;
  const deadline = Date.now() + waitMs;
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(lockPath);
    } catch {
      continue;
    }
    const existing = readNoFollow(lockPath);
    if (Date.now() - st.mtimeMs > staleMs || (existing !== null && ownerDead(existing))) {
      const graveyard = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.renameSync(lockPath, graveyard);
        fs.rmSync(graveyard, { force: true });
      } catch {
        // another contender won the steal
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new ExportRefusal('export_busy', 'Another NorthKeep export is running on this repository; try again shortly');
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return {
    path: lockPath,
    held: () => readNoFollow(lockPath) === token,
    release: () => {
      if (readNoFollow(lockPath) === token) fs.rmSync(lockPath, { force: true });
    },
  };
}

function requireLock(lock: ExportLock): void {
  if (!lock.held()) {
    throw new ExportRefusal('lock_not_held', 'NorthKeep writes export state only while it holds the export lock');
  }
}

function exportDir(home: string): string {
  return path.join(home, 'export');
}

function ensureExportDir(home: string): void {
  fs.mkdirSync(exportDir(home), { recursive: true, mode: 0o700 });
}

// ---- the write journal (Decision 3) -------------------------------------------------------

export interface ExportJournal {
  version: 1;
  repo: string;
  vault_id: string;
  /** Per path, the last JOURNAL_DEPTH blob ids NorthKeep wrote there, newest first. */
  paths: Record<string, string[]>;
}

export function journalPath(home: string, repoReal: string): string {
  return path.join(exportDir(home), `${repoKey(repoReal)}.json`);
}

/** Unparseable, another version, repository or vault: reads as empty. */
export function readJournal(home: string, repoReal: string, vaultId: string): ExportJournal {
  const empty: ExportJournal = { version: 1, repo: repoReal, vault_id: vaultId, paths: {} };
  const v = readJson(journalPath(home, repoReal));
  if (!isRecord(v) || v.version !== 1 || v.repo !== repoReal || v.vault_id !== vaultId || !isRecord(v.paths)) {
    return empty;
  }
  const paths: Record<string, string[]> = {};
  for (const [p, list] of Object.entries(v.paths)) {
    if (!Array.isArray(list) || !list.every((b) => typeof b === 'string' && OID.test(b))) return empty;
    paths[p] = (list as string[]).slice(0, JOURNAL_DEPTH);
  }
  return { ...empty, paths };
}

/** A blob already present moves to the front, so unchanged runs never evict history. */
export function recordJournalBlob(journal: ExportJournal, rel: string, blob: string): void {
  if (!OID.test(blob)) throw new ExportRefusal('bad_blob', 'NorthKeep refused a malformed blob id');
  const prior = (journal.paths[rel] ?? []).filter((b) => b !== blob);
  journal.paths[rel] = [blob, ...prior].slice(0, JOURNAL_DEPTH);
}

export function writeJournal(home: string, journal: ExportJournal, lock: ExportLock): void {
  requireLock(lock);
  ensureExportDir(home);
  atomicWrite(journalPath(home, journal.repo), `${JSON.stringify(journal, null, 2)}\n`);
}

// ---- the state file (Decision 7) ----------------------------------------------------------

export interface ExportState {
  version: 1;
  repo: string;
  vault_id: string;
  last_success: { at: string; commit: string } | null;
  last_attempt: { at: string; by: 'cli' | 'schedule' } | null;
  last_failure: { at: string; code: string } | null;
  refused: { path: string; reason: string }[];
  projects: Record<string, { revision: string; exported_at: string }>;
  /** Every commit NorthKeep created, oldest first; ADR 0055 depends on it. */
  nk_commits: string[];
}

export function emptyExportState(repoReal: string, vaultId: string): ExportState {
  return {
    version: 1,
    repo: repoReal,
    vault_id: vaultId,
    last_success: null,
    last_attempt: null,
    last_failure: null,
    refused: [],
    projects: {},
    nk_commits: [],
  };
}

export function statePath(home: string, repoReal: string): string {
  return path.join(exportDir(home), `${repoKey(repoReal)}.state.json`);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function nullOr<T>(v: unknown, ok: (x: Record<string, unknown>) => boolean): T | null | undefined {
  if (v === null || v === undefined) return null;
  return isRecord(v) && ok(v) ? (v as T) : undefined;
}

/** Null when absent, unparseable, or for another repository or vault. */
export function readExportState(home: string, repoReal: string, vaultId: string): ExportState | null {
  const v = readJson(statePath(home, repoReal));
  if (!isRecord(v) || v.version !== 1 || v.repo !== repoReal || v.vault_id !== vaultId) return null;
  const success = nullOr<ExportState['last_success']>(v.last_success, (x) => isStr(x.at) && isStr(x.commit));
  const attempt = nullOr<ExportState['last_attempt']>(
    v.last_attempt,
    (x) => isStr(x.at) && (x.by === 'cli' || x.by === 'schedule'),
  );
  const failure = nullOr<ExportState['last_failure']>(v.last_failure, (x) => isStr(x.at) && isStr(x.code));
  if (success === undefined || attempt === undefined || failure === undefined) return null;
  const refused = v.refused ?? [];
  if (!Array.isArray(refused) || !refused.every((r) => isRecord(r) && isStr(r.path) && isStr(r.reason))) return null;
  const projects = v.projects ?? {};
  if (!isRecord(projects)) return null;
  for (const p of Object.values(projects)) {
    if (!isRecord(p) || !isStr(p.revision) || !isStr(p.exported_at)) return null;
  }
  const commits = v.nk_commits ?? [];
  if (!Array.isArray(commits) || !commits.every((c) => isStr(c) && OID.test(c))) return null;
  return {
    version: 1,
    repo: repoReal,
    vault_id: vaultId,
    last_success: success,
    last_attempt: attempt,
    last_failure: failure,
    refused: refused as ExportState['refused'],
    projects: projects as ExportState['projects'],
    nk_commits: commits as string[],
  };
}

export function writeExportState(home: string, state: ExportState, lock: ExportLock): void {
  requireLock(lock);
  ensureExportDir(home);
  atomicWrite(statePath(home, state.repo), `${JSON.stringify(state, null, 2)}\n`);
}

// ---- the settings file (Decision 5) -------------------------------------------------------

export interface ExportSettings {
  repo: string;
}

export function settingsPath(home: string): string {
  return path.join(home, 'export.json');
}

/** Missing means unconfigured (null); present but unreadable refuses the run. */
export function readExportSettings(home: string): ExportSettings | null {
  const file = settingsPath(home);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ExportRefusal('settings_unreadable', 'export.json in the NorthKeep folder is unreadable; fix or remove it', file);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    v = undefined;
  }
  if (!isRecord(v) || !isStr(v.repo) || v.repo === '' || Object.keys(v).length !== 1) {
    throw new ExportRefusal('settings_unreadable', 'export.json in the NorthKeep folder is unreadable; fix or remove it', file);
  }
  return { repo: v.repo };
}

export function writeExportSettings(home: string, settings: ExportSettings, lock: ExportLock): void {
  requireLock(lock);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  atomicWrite(settingsPath(home), `${JSON.stringify({ repo: settings.repo }, null, 2)}\n`);
}
