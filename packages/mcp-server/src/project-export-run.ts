import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MIRROR_INDEX_PATH,
  MIRROR_MARKER_PATH,
  Vault,
  formatExportCommitMessage,
  getProjectView,
  listProjectViews,
  parseMirrorHeader,
  planImport,
  renderIndexFile,
  renderLogFile,
  renderMarkerFile,
  renderProjectFile,
  summarizeMirror,
  withFileLock,
  type ImportPlan,
  type MirrorFile,
  type MirrorHeaderKind,
  type ProjectSummary,
  type ProjectVaultReader,
} from '@northkeep/core';
import { atomicWrite, cleanStaleMirrorTemps, writeMirrorFile } from './fs-safe.js';
import {
  ExportRefusal,
  GitCommandError,
  checkTargetContainment,
  hashBytes,
  hashFile,
  hashObjectWrite,
  headBlob,
  isMirrorPath,
  plumbingCommit,
  preflightRepository,
  readHead,
  removeStaleRunIndexes,
  repoKey,
  requireCommitIdentity,
  runGit,
  type CommitEntry,
  type GitContext,
} from './git-plumbing.js';
import { resolveMasterKey } from './key.js';

/**
 * The local mirror's run layer (ADR 0053 M-A1): export, verify, import, the
 * schedule and the resume line, plus the journal, state, settings and lock
 * files they share. Export renders under the vault lock, releases it, then
 * does every git step under the export lock in the repository's common dir,
 * so git never runs while the vault is held. Journal, state and settings
 * writes require the export lock and hold no memory content: only paths,
 * blob ids, slugs, revisions and times. Verify takes no lock and writes
 * nothing. Import reads the source folder and never writes it.
 */

export const JOURNAL_DEPTH = 10;
export const EXPORT_LOCK_NAME = 'northkeep-export.lock';
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

/** Exact lock bytes, 'gone' when absent, 'unreadable' for anything else (never stolen). */
function readLockBytes(p: string): Buffer | 'gone' | 'unreadable' {
  try {
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      return fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unreadable';
  }
}

interface LockOwner {
  pid: number;
  /** Re-serialized, so no text from the lock file reaches a message. */
  startedAt: string | null;
}

function lockOwner(bytes: Buffer): LockOwner | null {
  let v: unknown;
  try {
    v = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.pid !== 'number' || !Number.isInteger(v.pid) || v.pid <= 0) return null;
  const t = typeof v.started_at === 'string' ? Date.parse(v.started_at) : Number.NaN;
  return { pid: v.pid, startedAt: Number.isNaN(t) ? null : new Date(t).toISOString() };
}

function ownerDead(owner: LockOwner): boolean {
  if (owner.pid === process.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Compare-and-steal under an O_EXCL guard: stealers run one at a time, and a
 * dead lock can only be removed by a stealer, so re-reading it under the
 * guard proves the rename moves exactly the dead bytes.
 */
function stealDeadLock(lockPath: string, seen: Buffer, token: string): 'retry' | 'busy' | 'mismatch' | 'guard_dead' {
  const guardPath = `${lockPath}.steal`;
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  try {
    const fd = fs.openSync(guardPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      fs.writeSync(fd, token);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const g = readLockBytes(guardPath);
    const gOwner = Buffer.isBuffer(g) ? lockOwner(g) : null;
    return gOwner !== null && ownerDead(gOwner) ? 'guard_dead' : 'busy';
  }
  try {
    // Read before the guard was ours: another stealer may have freed it and a contender taken it since.
    const now = readLockBytes(lockPath);
    if (!Buffer.isBuffer(now) || !now.equals(seen)) return 'retry';
    const grave = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(lockPath, grave);
    } catch {
      return 'retry';
    }
    const moved = readLockBytes(grave);
    fs.rmSync(grave, { force: true });
    return Buffer.isBuffer(moved) && moved.equals(seen) ? 'retry' : 'mismatch';
  } finally {
    if (readNoFollow(guardPath) === token) fs.rmSync(guardPath, { force: true });
  }
}

const LOCK_HINT = 'if none is, remove northkeep-export.lock from the repository\'s .git folder and try again';

/**
 * O_EXCL lock at `<common dir>/northkeep-export.lock`, shared by every worktree.
 * Never taken by age: a live or unreadable owner is waited for, then refused.
 * A dead owner's lock is taken only by compare-and-steal, so a contender's
 * fresh lock is never mistaken for the dead one. Released only while it holds our token.
 */
export async function acquireExportLock(ctx: GitContext, opts: LockOptions = {}): Promise<ExportLock> {
  const r = await runGit(ctx, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const lockPath = path.join(r.stdout.replace(/\r?\n$/, ''), EXPORT_LOCK_NAME);
  const waitMs = opts.waitMs ?? EXPORT_LOCK_WAIT_MS;
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
    const seen = readLockBytes(lockPath);
    if (seen === 'gone') continue;
    const owner = seen === 'unreadable' ? null : lockOwner(seen);
    if (owner !== null && seen !== 'unreadable' && ownerDead(owner)) {
      const stolen = stealDeadLock(lockPath, seen, token);
      if (stolen === 'retry') continue;
      if (stolen === 'mismatch') {
        // Put nothing back: restoring could clobber a newer lock, and its owner re-checks before committing.
        throw new ExportRefusal('export_busy', 'Another NorthKeep export took the export lock at the same moment; try again shortly');
      }
      if (stolen === 'guard_dead') {
        throw new ExportRefusal(
          'lock_unreadable',
          "A stale northkeep-export.lock.steal is in the repository's .git folder; once no NorthKeep export is running, remove it and try again",
        );
      }
    }
    if (Date.now() >= deadline) {
      if (owner === null) {
        throw new ExportRefusal(
          'lock_unreadable',
          "The export lock is unreadable; once no NorthKeep export is running, remove northkeep-export.lock from the repository's .git folder and try again",
        );
      }
      throw new ExportRefusal(
        'export_busy',
        owner.startedAt
          ? `Another NorthKeep export has been running since ${owner.startedAt}; ${LOCK_HINT}`
          : `Another NorthKeep export is running on this repository; ${LOCK_HINT}`,
      );
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
  /** vaultFingerprint of the vault that wrote this; lets a locked run find its own state. */
  vault_fingerprint: string | null;
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
    vault_fingerprint: null,
  };
}

/**
 * The vault file's identity without its key: a hash of the header salt, which
 * is stored in the clear. Null when the file is missing or unreadable.
 */
export function vaultFingerprint(vaultPath: string): string | null {
  try {
    const salt = Vault.readHeader(vaultPath).salt;
    return crypto.createHash('sha256').update('northkeep-mirror-vault\0').update(salt).digest('hex');
  } catch {
    return null;
  }
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
  const fp = v.vault_fingerprint ?? null;
  if (fp !== null && !(isStr(fp) && /^[0-9a-f]{64}$/.test(fp))) return null;
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
    vault_fingerprint: fp,
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

// ---- the vault snapshot -------------------------------------------------------------------

/** Runs `fn` against an open vault under the vault file lock, then closes it. */
export type VaultRunner = <T>(fn: (vault: Vault) => T | Promise<T>) => Promise<T>;

/** The background runner: env or Keychain key, never a prompt (Decision 8). */
export function defaultVaultRunner(vaultPath: string): VaultRunner {
  return async <T>(fn: (vault: Vault) => T | Promise<T>): Promise<T> => {
    const resolved = resolveMasterKey(vaultPath);
    if (resolved === null) throw new ExportRefusal('vault_locked', 'The vault is locked; run northkeep unlock, then export again');
    return withFileLock(vaultPath, async () => {
      const vault = Vault.openWithKey(vaultPath, resolved.key);
      try {
        return await fn(vault);
      } finally {
        vault.close();
      }
    });
  };
}

export const RENDER_FAILED = 'render failed';
const RENDER_FAILED_STATUS = 'render failed; not exported';

export interface SnapshotProject {
  slug: string;
  revision: string | null;
  lastWriterHost: string | null;
  state: 'ok' | 'conflict' | 'render failed';
  files: MirrorFile[];
}

/** Everything export and verify need, rendered while the vault is open so git runs after it closes. */
export interface MirrorSnapshot {
  vaultId: string;
  projects: SnapshotProject[];
  index: MirrorFile;
  marker: { path: string; bytes: Uint8Array };
}

/**
 * Per project, so one unreadable document fails alone (lead decision on
 * renderMirror). Its INDEX row says so in fixed text instead of borrowing the
 * conflict wording, which would be false.
 */
export function snapshotMirror(vault: ProjectVaultReader, allowedScopes?: string[]): MirrorSnapshot {
  const vaultId = vault.getVaultId();
  const summaries = listProjectViews(vault, allowedScopes);
  const projects: SnapshotProject[] = [];
  const indexRows: ProjectSummary[] = [];
  for (const s of summaries) {
    if (s.conflict) {
      projects.push({ slug: s.project, revision: null, lastWriterHost: null, state: 'conflict', files: [] });
      indexRows.push(s);
      continue;
    }
    try {
      const view = getProjectView(vault, s.project, allowedScopes, { history: true });
      projects.push({
        slug: s.project,
        revision: view.revision,
        lastWriterHost: view.last_writer?.host ?? null,
        state: 'ok',
        files: [renderProjectFile(view), ...renderLogFile(view)],
      });
      indexRows.push(s);
    } catch {
      projects.push({ slug: s.project, revision: s.revision, lastWriterHost: null, state: 'render failed', files: [] });
      indexRows.push({ ...s, status: RENDER_FAILED_STATUS, updated_at: null, last_writer_host: null });
    }
  }
  const marker = renderMarkerFile(vaultId);
  return { vaultId, projects, index: renderIndexFile(indexRows, vaultId), marker: { path: marker.path, bytes: marker.bytes } };
}

// ---- ownership (Decision 3) ---------------------------------------------------------------

export type TargetClass = 'missing' | 'ours' | 'hand edit';

/**
 * Ours only when the header names this vault (and this slug for a document or
 * log) and the disk blob is one NorthKeep journaled. HEAD is never an input:
 * a committed file NorthKeep did not write is still not NorthKeep's.
 */
export function classifyTarget(
  target: { bytes: Uint8Array | null; kind: MirrorHeaderKind },
  input: { diskBlob: string | null; journalBlobs: readonly string[]; vaultId: string; slug: string | null },
): TargetClass {
  if (target.bytes === null || input.diskBlob === null) return 'missing';
  const header = parseMirrorHeader(Buffer.from(target.bytes).toString('utf8'));
  if (!header || header.vaultId !== input.vaultId || header.kind !== target.kind) return 'hand edit';
  if ((target.kind === 'document' || target.kind === 'log') && header.slug !== input.slug) return 'hand edit';
  return input.journalBlobs.includes(input.diskBlob) ? 'ours' : 'hand edit';
}

// ---- export (Decisions 2 to 9) ------------------------------------------------------------

const PROJECT_FILE = /^projects\/([a-z0-9-]{1,40})(?:\.log\.[1-9][0-9]{0,3})?\.md$/;
const OVERSIZE_BYTES = 65_536;

export interface ExportRunOptions {
  home: string;
  vaultPath: string;
  /** Configures the mirror; otherwise export.json names it. */
  repo?: string;
  by: 'cli' | 'schedule';
  withVault?: VaultRunner;
  now?: () => Date;
  lockWaitMs?: number;
}

export interface ExportRunResult {
  repo: string;
  status: 'committed' | 'unchanged';
  commit: string | null;
  written: string[];
  removed: string[];
  refused: { path: string; reason: string }[];
  conflicts: string[];
  oversize: string[];
  /** "committed; working index not refreshed", or null. */
  note: string | null;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function readRegular(abs: string): Uint8Array | null {
  const st = lstatOrNull(abs);
  if (!st || !st.isFile()) return null;
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** True for a real projects/ folder, null when absent, false for anything else (never listed or removed through). */
function realProjectsDir(repo: string): boolean | null {
  const st = lstatOrNull(path.join(repo, 'projects'));
  if (!st) return null;
  return st.isDirectory() && !st.isSymbolicLink();
}

function resolveRepo(home: string, repo: string | undefined): string {
  const chosen = repo ?? readExportSettings(home)?.repo;
  if (!chosen) throw new ExportRefusal('not_configured', 'No mirror is configured; run northkeep projects export --repo <folder> once');
  try {
    return fs.realpathSync(chosen);
  } catch {
    throw new ExportRefusal('repo_missing', 'The mirror folder does not exist or is not a folder');
  }
}

function failureCode(err: unknown): string {
  if (err instanceof ExportRefusal) return err.code;
  if (err instanceof GitCommandError) return 'git_error';
  return 'error';
}

/**
 * Records a failed run only in this vault's own state file: matched by vault
 * id when the vault opened, else by the header fingerprint. A run that could
 * not open its vault never marks another vault's mirror as failed.
 */
function recordFailure(home: string, repo: string, vaultId: string | null, vaultPath: string, by: 'cli' | 'schedule', code: string, at: string, lock: ExportLock): void {
  const raw = readJson(statePath(home, repo));
  const owner = isRecord(raw) && isStr(raw.vault_id) ? raw.vault_id : null;
  let id: string;
  if (vaultId !== null) {
    if (owner !== null && owner !== vaultId) return;
    id = vaultId;
  } else {
    const fp = vaultFingerprint(vaultPath);
    if (owner === null || fp === null || !isRecord(raw) || raw.vault_fingerprint !== fp) return;
    id = owner;
  }
  const state = readExportState(home, repo, id) ?? emptyExportState(repo, id);
  state.last_attempt = { at, by };
  state.last_failure = { at, code };
  writeExportState(home, state, lock);
}

/** Refusals that end the whole run; everything else refuses one target. */
const RUN_FATAL = new Set(['lock_not_held', 'lock_lost', 'tree_check_failed']);

function fsErrno(err: unknown): boolean {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string' && !(err instanceof ExportRefusal);
}

async function runLocked(
  opts: ExportRunOptions,
  repo: string,
  lock: ExportLock,
  snap: MirrorSnapshot,
  at: string,
): Promise<ExportRunResult> {
  const { ctx: pctx, info } = await preflightRepository({
    repo,
    home: opts.home,
    vaultPath: opts.vaultPath,
    vaultId: snap.vaultId,
    parseMarker: (b) => parseMirrorHeader(Buffer.from(b).toString('utf8')),
  });
  await requireCommitIdentity(pctx);
  requireLock(lock);
  removeStaleRunIndexes(opts.home, repo);
  if (opts.repo !== undefined) writeExportSettings(opts.home, { repo }, lock);
  const projectsDir = path.join(repo, 'projects');
  cleanStaleMirrorTemps(repo);
  cleanStaleMirrorTemps(projectsDir);

  const journal = readJournal(opts.home, repo, snap.vaultId);
  const state = readExportState(opts.home, repo, snap.vaultId) ?? emptyExportState(repo, snap.vaultId);
  const refused: { path: string; reason: string }[] = [];
  const add: CommitEntry[] = [];
  const written: string[] = [];
  const changedSlugs = new Set<string>();
  const refusedSlugs = new Set<string>();
  const oversize: string[] = [];

  type Target = { path: string; bytes: Uint8Array; kind: MirrorHeaderKind; slug: string | null };
  const targets: Target[] = [{ path: MIRROR_MARKER_PATH, bytes: snap.marker.bytes, kind: 'marker', slug: null }];
  for (const p of snap.projects) {
    for (const f of p.files) targets.push({ path: f.path, bytes: f.bytes, kind: f.kind, slug: f.slug });
  }
  targets.push({ path: MIRROR_INDEX_PATH, bytes: snap.index.bytes, kind: 'index', slug: null });

  for (const t of targets) {
    let stage: 'read' | 'write' = 'write';
    try {
      // The marker goes first so a killed first run leaves only temps beside .git.
      if (t.path.startsWith('projects/') && !lstatOrNull(projectsDir)) fs.mkdirSync(projectsDir);
      await checkTargetContainment(pctx, t.path, info.head);
      const abs = path.join(repo, t.path);
      stage = 'read';
      const disk = readRegular(abs);
      stage = 'write';
      // Hashing the bytes already read: the same blob id, with no second read to race or fail.
      const diskBlob = disk === null ? null : await hashBytes(pctx, disk);
      const cls = classifyTarget(
        { bytes: disk, kind: t.kind },
        { diskBlob, journalBlobs: journal.paths[t.path] ?? [], vaultId: snap.vaultId, slug: t.slug },
      );
      if (cls === 'hand edit') {
        refused.push({ path: t.path, reason: 'hand edit' });
        if (t.slug) refusedSlugs.add(t.slug);
        continue;
      }
      const blob = await hashObjectWrite(pctx, t.bytes);
      recordJournalBlob(journal, t.path, blob);
      if (diskBlob !== blob) {
        writeJournal(opts.home, journal, lock);
        writeMirrorFile(abs, t.bytes);
        if ((await hashFile(pctx, abs)) !== blob) {
          refused.push({ path: t.path, reason: 'changed while writing' });
          if (t.slug) refusedSlugs.add(t.slug);
          continue;
        }
      }
      if (t.bytes.length > OVERSIZE_BYTES) oversize.push(t.path);
      add.push({ path: t.path, blob });
      if ((info.head === null ? null : await headBlob(pctx, t.path)) !== blob) {
        written.push(t.path);
        if (t.slug) changedSlugs.add(t.slug);
      }
    } catch (err) {
      if (fsErrno(err)) {
        refused.push({ path: t.path, reason: stage === 'read' ? 'unreadable' : 'unwritable' });
        if (t.slug) refusedSlugs.add(t.slug);
        continue;
      }
      if (!(err instanceof ExportRefusal) || RUN_FATAL.has(err.code)) throw err;
      refused.push({ path: t.path, reason: err.message });
      if (t.slug) refusedSlugs.add(t.slug);
    }
  }

  // Files of projects gone from the vault, and log parts no longer rendered, go when they are ours.
  const rendered = new Set(targets.map((t) => t.path));
  const kept = new Set(snap.projects.filter((p) => p.state !== 'ok').map((p) => p.slug));
  const candidates = new Set<string>();
  const realDir = realProjectsDir(repo);
  for (const n of realDir ? fs.readdirSync(projectsDir) : []) candidates.add(`projects/${n}`);
  if (realDir !== false && info.head !== null) {
    const tree = (await runGit(pctx, ['ls-tree', '--name-only', 'HEAD', '--', 'projects/'])).stdout;
    for (const n of tree.split('\n')) if (n) candidates.add(n);
  }
  const removed: string[] = [];
  for (const rel of [...candidates].sort()) {
    const m = PROJECT_FILE.exec(rel);
    if (!m || !isMirrorPath(rel) || rendered.has(rel) || kept.has(m[1] as string)) continue;
    const abs = path.join(repo, rel);
    const st = lstatOrNull(abs);
    const jb = journal.paths[rel] ?? [];
    if (st) {
      let disk: Uint8Array | null;
      try {
        disk = readRegular(abs);
      } catch (err) {
        if (!fsErrno(err)) throw err;
        refused.push({ path: rel, reason: 'unreadable' });
        continue;
      }
      const diskBlob = disk === null ? null : await hashBytes(pctx, disk);
      const kind = rel.includes('.log.') ? 'log' : 'document';
      if (st.nlink > 1 || classifyTarget({ bytes: disk, kind }, { diskBlob, journalBlobs: jb, vaultId: snap.vaultId, slug: m[1] as string }) !== 'ours') {
        refused.push({ path: rel, reason: 'hand edit' });
        continue;
      }
      try {
        fs.unlinkSync(abs);
      } catch (err) {
        if (!fsErrno(err)) throw err;
        refused.push({ path: rel, reason: 'unwritable' });
        continue;
      }
    } else {
      const hb = await headBlob(pctx, rel);
      if (hb === null || !jb.includes(hb)) continue;
    }
    removed.push(rel);
  }

  for (const p of snap.projects) {
    if (p.state === 'render failed') refused.push({ path: `projects/${p.slug}.md`, reason: RENDER_FAILED });
  }
  const host = opts.by === 'schedule' ? 'northkeep-schedule' : 'northkeep-cli';
  const message = formatExportCommitMessage({
    host,
    written: snap.projects.filter((p) => changedSlugs.has(p.slug)).map((p) => ({ slug: p.slug, lastWriterHost: p.lastWriterHost })),
    removed,
  });
  const guard = (): void => {
    if (!lock.held()) throw new ExportRefusal('lock_lost', 'NorthKeep lost the export lock before committing; nothing was committed. Export again');
  };
  const res = await plumbingCommit(pctx, info, { add, remove: removed, message, guard });

  const commitId = res.commit ?? (await readHead(pctx));
  if (res.commit) state.nk_commits.push(res.commit);
  state.last_attempt = { at, by: opts.by };
  if (commitId) state.last_success = { at, commit: commitId };
  state.refused = refused;
  state.vault_fingerprint = vaultFingerprint(opts.vaultPath);
  const live = new Set(snap.projects.map((p) => p.slug));
  for (const slug of Object.keys(state.projects)) if (!live.has(slug)) delete state.projects[slug];
  for (const p of snap.projects) {
    if (p.state !== 'ok' || refusedSlugs.has(p.slug) || p.revision === null) continue;
    const prev = state.projects[p.slug];
    state.projects[p.slug] = { revision: p.revision, exported_at: prev?.revision === p.revision ? prev.exported_at : at };
  }
  writeJournal(opts.home, journal, lock);
  writeExportState(opts.home, state, lock);
  return {
    repo,
    status: res.status,
    commit: res.commit,
    written,
    removed,
    refused,
    conflicts: snap.projects.filter((p) => p.state === 'conflict').map((p) => p.slug),
    oversize,
    note: res.note,
  };
}

/**
 * One export run. Renders under the vault lock, releases it, then does every
 * git step under the export lock. A whole-run refusal is recorded in the
 * state file as last_failure and rethrown; per-target refusals are reported
 * and the rest of the mirror still exports.
 */
export async function exportProjects(opts: ExportRunOptions): Promise<ExportRunResult> {
  const now = opts.now ?? (() => new Date());
  const repo = resolveRepo(opts.home, opts.repo);
  const ctx: GitContext = { repo, home: opts.home, vaultPath: opts.vaultPath };
  let lock: ExportLock;
  try {
    lock = await acquireExportLock(ctx, { waitMs: opts.lockWaitMs });
  } catch (err) {
    if (err instanceof GitCommandError) {
      throw new ExportRefusal('not_work_tree', 'The mirror folder is not a git working tree; run git init in an empty folder first');
    }
    throw err;
  }
  const at = now().toISOString();
  let vaultId: string | null = null;
  try {
    const snap = await (opts.withVault ?? defaultVaultRunner(opts.vaultPath))((v) => snapshotMirror(v));
    vaultId = snap.vaultId;
    return await runLocked(opts, repo, lock, snap, at);
  } catch (err) {
    try {
      recordFailure(opts.home, repo, vaultId, opts.vaultPath, opts.by, failureCode(err), at, lock);
    } catch {
      // the original error is the one worth reporting
    }
    throw err;
  } finally {
    lock.release();
  }
}

// ---- verify (Decision 6) ------------------------------------------------------------------

export type VerifyStatus =
  | 'matches'
  | 'uncommitted export'
  | 'stale'
  | 'missing'
  | 'missing on disk'
  | 'extra'
  | 'hand edit'
  | 'conflict'
  | 'render failed';

export interface VerifyResult {
  repo: string;
  entries: { path: string; status: VerifyStatus }[];
  ok: boolean;
}

/** Mode per path from `ls-tree -z`, for the top-level mirror files and projects/. */
function parseLsTree(text: string): Map<string, string> {
  const modes = new Map<string, string>();
  for (const rec of text.split('\0')) {
    const m = /^(\d{6}) \S+ [0-9a-f]+\t(.+)$/s.exec(rec);
    if (m) modes.set(m[2] as string, m[1] as string);
  }
  return modes;
}

/**
 * Read-only: no lock, no journal or state write, no git write verb, and
 * nothing created or chmodded under NORTHKEEP_HOME. Git runs with a throwaway
 * home holding an empty config and hooks folder, removed afterwards. Its git
 * calls are hash-object without -w, rev-parse and ls-tree.
 */
export async function verifyMirror(opts: {
  home: string;
  vaultPath: string;
  repo?: string;
  withVault?: VaultRunner;
}): Promise<VerifyResult> {
  const repo = resolveRepo(opts.home, opts.repo);
  const snap = await (opts.withVault ?? defaultVaultRunner(opts.vaultPath))((v) => snapshotMirror(v));
  const journal = readJournal(opts.home, repo, snap.vaultId);
  const gitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-verify-'));
  try {
    const ctx: GitContext = { repo, home: gitHome, vaultPath: opts.vaultPath };
    const top = await runGit(ctx, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (top.exitCode !== 0) throw new ExportRefusal('not_work_tree', 'The mirror folder is not a git working tree');
    const hasHead = (await readHead(ctx)) !== null;
    const headModes = hasHead
      ? parseLsTree((await runGit(ctx, ['ls-tree', '-z', 'HEAD', '--', MIRROR_MARKER_PATH, MIRROR_INDEX_PATH, 'projects/'])).stdout)
      : new Map<string, string>();
    const entries: VerifyResult['entries'] = [];

    const judge = async (rel: string, bytes: Uint8Array): Promise<VerifyStatus> => {
      const abs = path.join(repo, rel);
      if (rel.startsWith('projects/') && realProjectsDir(repo) === false) return 'hand edit';
      const st = lstatOrNull(abs);
      if (!st) return 'missing';
      if (!st.isFile() || st.nlink > 1) return 'hand edit';
      // NorthKeep writes 0644 and commits 100644; any other mode is someone else's change.
      if ((st.mode & 0o111) !== 0) return 'hand edit';
      const hm = headModes.get(rel);
      if (hm !== undefined && hm !== '100644') return 'hand edit';
      const rb = await hashBytes(ctx, bytes);
      const db = await hashFile(ctx, abs);
      const hb = hasHead ? await headBlob(ctx, rel) : null;
      const jb = journal.paths[rel] ?? [];
      const headOurs = hb === null || hb === rb || jb.includes(hb);
      if (db === rb) return hb === rb ? 'matches' : headOurs ? 'uncommitted export' : 'hand edit';
      return jb.includes(db) && headOurs ? 'stale' : 'hand edit';
    };

    entries.push({ path: MIRROR_MARKER_PATH, status: await judge(MIRROR_MARKER_PATH, snap.marker.bytes) });
    const rendered = new Set<string>([MIRROR_MARKER_PATH, MIRROR_INDEX_PATH]);
    const kept = new Set<string>();
    for (const p of snap.projects) {
      if (p.state !== 'ok') {
        kept.add(p.slug);
        entries.push({ path: `projects/${p.slug}.md`, status: p.state === 'conflict' ? 'conflict' : 'render failed' });
        continue;
      }
      for (const f of p.files) {
        rendered.add(f.path);
        entries.push({ path: f.path, status: await judge(f.path, f.bytes) });
      }
    }
    entries.push({ path: MIRROR_INDEX_PATH, status: await judge(MIRROR_INDEX_PATH, snap.index.bytes) });
    const unrendered = (rel: string): boolean => {
      const m = PROJECT_FILE.exec(rel);
      return m !== null && !rendered.has(rel) && !kept.has(m[1] as string);
    };
    const dir = path.join(repo, 'projects');
    const onDisk = new Set(realProjectsDir(repo) ? fs.readdirSync(dir).map((n) => `projects/${n}`) : []);
    for (const rel of [...onDisk].sort()) if (unrendered(rel)) entries.push({ path: rel, status: 'extra' });
    for (const rel of [...headModes.keys()].sort()) {
      if (rel.startsWith('projects/') && !onDisk.has(rel) && unrendered(rel)) entries.push({ path: rel, status: 'missing on disk' });
    }
    return { repo, entries, ok: entries.every((e) => e.status === 'matches') };
  } finally {
    fs.rmSync(gitHome, { recursive: true, force: true });
  }
}

// ---- status and the resume line (Decision 7) ----------------------------------------------

/**
 * The staleness line for project_list and project_resume. Reads export.json
 * and the state file only, never git, and counts only the caller's granted
 * projects. Null when no mirror is configured.
 */
export function readMirrorSummary(vault: ProjectVaultReader, granted: string[] | undefined, home: string, now = new Date()): string | null {
  let settings: ExportSettings | null;
  try {
    settings = readExportSettings(home);
  } catch {
    return 'mirror settings unreadable';
  }
  if (settings === null) return null;
  const state = readExportState(home, settings.repo, vault.getVaultId());
  return summarizeMirror(state ?? {}, listProjectViews(vault, granted), now);
}

// ---- import (Decision 10) -----------------------------------------------------------------

export interface ImportFileReport {
  name: string;
  slug: string | null;
  status: 'would import' | 'imported' | 'skipped' | 'refused';
  reason: string | null;
}

export interface ImportRunResult {
  plan: ImportPlan;
  files: ImportFileReport[];
}

/**
 * Reads `*.md` directly in `dir` as text (regular files only, no symlinks, no
 * recursion) and never writes there or spawns git. Dry run by default; with
 * write, each project goes in through Vault.importProject under the vault
 * lock with one save per project.
 */
export async function importProjects(
  dir: string,
  opts: { write: boolean; vaultPath: string; withVault?: VaultRunner; allowedScopes?: string[] },
): Promise<ImportRunResult> {
  const files: { name: string; text: string }[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isFile() || !d.name.endsWith('.md')) continue;
    const fd = fs.openSync(path.join(dir, d.name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      files.push({ name: d.name, text: fs.readFileSync(fd, 'utf8') });
    } finally {
      fs.closeSync(fd);
    }
  }
  const plan = planImport(files);
  const reports: ImportFileReport[] = plan.skipped.map((s) => ({ name: s.name, slug: null, status: 'skipped', reason: s.reason }));
  const run = opts.withVault ?? defaultVaultRunner(opts.vaultPath);
  for (const p of plan.projects) {
    if (!opts.write) {
      reports.push({ name: p.name, slug: p.slug, status: 'would import', reason: null });
      continue;
    }
    try {
      await run((vault) => {
        vault.importProject(p, opts.allowedScopes);
        vault.save();
      });
      reports.push({ name: p.name, slug: p.slug, status: 'imported', reason: null });
    } catch (err) {
      reports.push({ name: p.name, slug: p.slug, status: 'refused', reason: err instanceof Error ? err.message : 'import failed' });
    }
  }
  reports.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { plan, files: reports };
}

// ---- the schedule (Decision 8) ------------------------------------------------------------

export const SCHEDULE_LABEL = 'com.northkeep.mirror-export';

export interface ScheduleOptions {
  /** The CLI entry script launchd runs with process.execPath. */
  cliEntry: string;
  /** Override for tests; defaults to ~/Library/LaunchAgents. */
  plistDir?: string;
  /** False skips launchctl (tests). */
  load?: boolean;
  nodePath?: string;
  northkeepHome?: string;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function schedulePlistPath(plistDir?: string): string {
  return path.join(plistDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents'), `${SCHEDULE_LABEL}.plist`);
}

export function renderSchedulePlist(frequency: 'hourly' | 'daily', opts: ScheduleOptions): string {
  const args = [opts.nodePath ?? process.execPath, opts.cliEntry, 'projects', 'export', '--scheduled'];
  const timing =
    frequency === 'hourly'
      ? '  <key>StartInterval</key>\n  <integer>3600</integer>\n'
      : '  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>3</integer>\n    <key>Minute</key>\n    <integer>0</integer>\n  </dict>\n';
  const home = opts.northkeepHome ?? process.env.NORTHKEEP_HOME;
  const env = home
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>NORTHKEEP_HOME</key>\n    <string>${xml(home)}</string>\n  </dict>\n`
    : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    `  <key>Label</key>\n  <string>${SCHEDULE_LABEL}</string>\n` +
    `  <key>ProgramArguments</key>\n  <array>\n${args.map((a) => `    <string>${xml(a)}</string>\n`).join('')}  </array>\n` +
    timing +
    env +
    '  <key>StandardOutPath</key>\n  <string>/dev/null</string>\n' +
    '  <key>StandardErrorPath</key>\n  <string>/dev/null</string>\n' +
    '</dict>\n</plist>\n'
  );
}

function launchctl(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/bin/launchctl', args, { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } }, (err) => resolve(!err));
  });
}

function assertMac(): void {
  if (process.platform !== 'darwin') throw new ExportRefusal('schedule_unsupported', 'The export schedule is available on macOS only');
}

/** Writes the LaunchAgent (0o644, no secret) and loads it. Replaces an existing one. */
export async function installSchedule(frequency: 'hourly' | 'daily', opts: ScheduleOptions): Promise<string> {
  assertMac();
  const file = schedulePlistPath(opts.plistDir);
  const domain = `gui/${process.getuid?.() ?? 0}`;
  if (opts.load !== false) await launchctl(['bootout', domain, file]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  writeMirrorFile(file, Buffer.from(renderSchedulePlist(frequency, opts)));
  if (opts.load !== false && !(await launchctl(['bootstrap', domain, file]))) {
    throw new ExportRefusal('schedule_load_failed', 'launchctl could not load the export schedule');
  }
  return file;
}

/** Unloads and removes the LaunchAgent; true when one was there. */
export async function removeSchedule(opts: Pick<ScheduleOptions, 'plistDir' | 'load'> = {}): Promise<boolean> {
  assertMac();
  const file = schedulePlistPath(opts.plistDir);
  if (!fs.existsSync(file)) return false;
  if (opts.load !== false) await launchctl(['bootout', `gui/${process.getuid?.() ?? 0}`, file]);
  fs.rmSync(file, { force: true });
  return true;
}
