import { execFile, type ExecFileException } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Git plumbing for the local project mirror (ADR 0053 Decisions 2, 4 and 9).
 * Every spawn goes through runGit: execFile with an args array, the pinned
 * environment and -c pins that scripts/adr-0053-canary.sh proves, and a verb
 * allowlist with no push, fetch or ls-remote, so nothing leaves the machine.
 * Git never writes the working tree: files are written by writeMirrorFile and
 * committed from a temporary index seeded from HEAD, so a user's staged or
 * untracked work is never committed. Every error carries fixed text only;
 * git's stderr, which can echo paths and repository content, is discarded.
 */

export const GIT_BIN = '/usr/bin/git';
export const GIT_TIMEOUT_MS = 10_000;
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;
export const INDEX_NOT_REFRESHED = 'committed; working index not refreshed';

export interface GitContext {
  /** Repository realpath, passed to -C. */
  repo: string;
  /** NorthKeep home, which owns empty.gitconfig, hooks/ and export/. */
  home: string;
  /** Vault file; runGit refuses while this process holds its lock. */
  vaultPath: string;
}

/** A refusal with fixed, user-facing text. `path` is for the CLI, never a model payload. */
export class ExportRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'ExportRefusal';
  }
}

export class GitCommandError extends Error {
  constructor(
    readonly verb: string,
    readonly exitCode: number | null,
    readonly reason: 'exit' | 'timeout' | 'output' | 'spawn' = 'exit',
  ) {
    super(reason === 'timeout' ? `git ${verb} timed out` : `git ${verb} failed`);
    this.name = 'GitCommandError';
  }
}

export function repoKey(repoReal: string): string {
  return crypto.createHash('sha256').update(repoReal, 'utf8').digest('hex');
}

export function tempIndexPath(home: string, repoReal: string): string {
  return path.join(home, 'export', `${repoKey(repoReal)}.index`);
}

/** Decision 2's environment, and nothing else from the parent process. */
export function gitEnv(home: string, indexFile: string | null): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'empty.gitconfig'),
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  if (indexFile !== null) env.GIT_INDEX_FILE = indexFile;
  return env;
}

/** Decision 2's -c pins; command-line config outranks every repository file. */
export function gitPins(home: string): string[] {
  const kv = [
    `core.hooksPath=${path.join(home, 'hooks')}`,
    'core.fsmonitor=false',
    'core.useBuiltinFSMonitor=false',
    'gpg.program=/usr/bin/false',
    'commit.gpgsign=false',
    'tag.gpgsign=false',
    'core.sshCommand=/usr/bin/false',
    'credential.helper=',
    'diff.external=',
    'core.editor=/usr/bin/false',
    'sequence.editor=/usr/bin/false',
    'core.pager=cat',
    'core.askPass=/usr/bin/false',
    'core.gitProxy=',
    'core.alternateRefsCommand=',
    'core.autocrlf=false',
    'core.safecrlf=false',
    'core.symlinks=false',
    'protocol.ext.allow=never',
    'uploadpack.packObjectsHook=',
    'user.useConfigOnly=true',
  ];
  return kv.flatMap((p) => ['-c', p]);
}

const FREE_VERBS = new Set([
  'rev-parse',
  'read-tree',
  'hash-object',
  'update-index',
  'write-tree',
  'commit-tree',
  'update-ref',
  'ls-tree',
  'var',
]);

/** The verb allowlist: M-A1 constructs no command that can reach a network. */
export function assertAllowedGitArgs(args: readonly string[]): void {
  const verb = args[0] ?? '';
  const ok =
    FREE_VERBS.has(verb) ||
    (verb === 'worktree' && args.length === 3 && args[1] === 'list' && args[2] === '--porcelain') ||
    (verb === 'remote' && args.length === 2 && args[1] === '-v');
  if (!ok) throw new ExportRefusal('git_verb_refused', 'NorthKeep refused to run a git command outside its allowlist');
}

type GitObserver = (verb: string, args: readonly string[]) => void;
let observer: GitObserver | null = null;

/** Test seam: records every spawned invocation. */
export function setGitSpawnObserver(fn: GitObserver | null): void {
  observer = fn;
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (errno(err) === 'ENOENT') return null;
    throw err;
  }
}

function ownedByUs(st: fs.Stats): boolean {
  return typeof process.getuid !== 'function' || st.uid === process.getuid();
}

/**
 * Creates or checks the files the environment points git at. A hooks dir with
 * entries, or a non-empty global config, is refused rather than cleaned: it
 * means something other than NorthKeep wrote there.
 */
export function ensureGitHome(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const hooks = path.join(home, 'hooks');
  let st = lstatOrNull(hooks);
  if (!st) {
    fs.mkdirSync(hooks, { mode: 0o700 });
    st = fs.lstatSync(hooks);
  }
  if (!st.isDirectory() || !ownedByUs(st) || fs.readdirSync(hooks).length > 0) {
    throw new ExportRefusal(
      'hooks_dir_invalid',
      'The NorthKeep hooks folder is not an empty folder NorthKeep owns; empty or remove it, then retry',
    );
  }
  const cfg = path.join(home, 'empty.gitconfig');
  st = lstatOrNull(cfg);
  if (!st) {
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
    fs.closeSync(fs.openSync(cfg, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600));
    st = fs.lstatSync(cfg);
  }
  if (!st.isFile() || st.size !== 0 || !ownedByUs(st)) {
    throw new ExportRefusal(
      'gitconfig_invalid',
      'The NorthKeep empty.gitconfig is not an empty file NorthKeep owns; remove it, then retry',
    );
  }
  const exp = path.join(home, 'export');
  st = lstatOrNull(exp);
  if (!st) {
    fs.mkdirSync(exp, { mode: 0o700 });
    st = fs.lstatSync(exp);
  }
  if (!st.isDirectory() || !ownedByUs(st)) {
    throw new ExportRefusal('export_dir_invalid', 'The NorthKeep export folder is not a folder NorthKeep owns');
  }
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(exp, 0o700);
}

/** core's withFileLock writes `<pid> <iso> <nonce>`; our pid there means we hold the vault. */
function assertVaultLockNotHeld(vaultPath: string): void {
  let token: string;
  try {
    token = fs.readFileSync(`${vaultPath}.lock`, 'utf8');
  } catch {
    return;
  }
  if (Number.parseInt(token.split(' ')[0] ?? '', 10) === process.pid) {
    throw new ExportRefusal('vault_lock_held', 'NorthKeep does not run git while it holds the vault lock');
  }
}

export interface RunGitOptions {
  input?: Uint8Array | string;
  /** 'default' omits GIT_INDEX_FILE; only the reconcile uses it. */
  index?: 'temp' | 'default';
  /** Resolve with the exit code instead of throwing on a nonzero exit. */
  allowFailure?: boolean;
}

export interface GitResult {
  stdout: string;
  exitCode: number;
}

export async function runGit(ctx: GitContext, args: readonly string[], opts: RunGitOptions = {}): Promise<GitResult> {
  assertAllowedGitArgs(args);
  assertVaultLockNotHeld(ctx.vaultPath);
  ensureGitHome(ctx.home);
  const verb = args[0] as string;
  const env = gitEnv(ctx.home, opts.index === 'default' ? null : tempIndexPath(ctx.home, ctx.repo));
  const argv = ['-C', ctx.repo, ...gitPins(ctx.home), ...args];
  observer?.(verb, args);
  return new Promise((resolve, reject) => {
    const child = execFile(
      GIT_BIN,
      argv,
      {
        env,
        timeout: GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: GIT_MAX_BUFFER,
        encoding: 'buffer',
        windowsHide: true,
      },
      (err: ExecFileException | null, stdout: Buffer) => {
        if (!err) return resolve({ stdout: stdout.toString('utf8'), exitCode: 0 });
        if (err.killed || err.signal) return reject(new GitCommandError(verb, null, 'timeout'));
        if (typeof err.code !== 'number') {
          const reason = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output' : 'spawn';
          return reject(new GitCommandError(verb, null, reason));
        }
        if (opts.allowFailure) return resolve({ stdout: stdout.toString('utf8'), exitCode: err.code });
        reject(new GitCommandError(verb, err.code));
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input === undefined ? undefined : Buffer.from(opts.input));
  });
}

function line(r: GitResult): string {
  return r.stdout.replace(/\r?\n$/, '');
}

async function out(ctx: GitContext, args: readonly string[], opts?: RunGitOptions): Promise<string> {
  return line(await runGit(ctx, args, opts));
}

/** Current HEAD commit, or null for an unborn HEAD. */
export async function readHead(ctx: GitContext): Promise<string | null> {
  const r = await runGit(ctx, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
  if (r.exitCode === 0) return line(r);
  if (r.exitCode === 1 && r.stdout.trim() === '') return null;
  throw new GitCommandError('rev-parse', r.exitCode);
}

/** The blob HEAD holds at a path, or null. */
export async function headBlob(ctx: GitContext, rel: string): Promise<string | null> {
  const r = await runGit(ctx, ['rev-parse', '-q', '--verify', `HEAD:${rel}`], { allowFailure: true });
  return r.exitCode === 0 ? line(r) : null;
}

/** Blob id of a file on disk, with no filter applied. */
export async function hashFile(ctx: GitContext, abs: string): Promise<string> {
  return out(ctx, ['hash-object', '--no-filters', '--', abs]);
}

/** Stores rendered bytes as a blob; the id is journaled before the file is written. */
export async function hashObjectWrite(ctx: GitContext, bytes: Uint8Array): Promise<string> {
  return out(ctx, ['hash-object', '-w', '--no-filters', '--stdin'], { input: bytes });
}

/** Blob id of bytes without storing them (verify). */
export async function hashBytes(ctx: GitContext, bytes: Uint8Array): Promise<string> {
  return out(ctx, ['hash-object', '--no-filters', '--stdin'], { input: bytes });
}

// ---- repository preflight (Decisions 2 and 4) ---------------------------------------------

export const MARKER_FILE = '.northkeep-mirror';
const MIRROR_PATH = /^(?:INDEX\.md|\.northkeep-mirror|projects\/[a-z0-9-]{1,40}(?:\.log(?:\.[1-9][0-9]{0,3})?)?\.md)$/;

/** The only repository paths NorthKeep ever writes or commits. */
export function isMirrorPath(rel: string): boolean {
  return MIRROR_PATH.test(rel);
}

export interface RepoInfo {
  repo: string;
  gitDir: string;
  commonDir: string;
  head: string | null;
  /** 'fresh' is the first export into an empty folder; 'owned' has our marker. */
  ownership: 'fresh' | 'owned';
}

export interface MarkerHeader {
  vaultId: string;
  kind: string;
}

export interface PreflightInput {
  repo: string;
  home: string;
  vaultPath: string;
  vaultId: string;
  /** core's parseMirrorHeader, injected so this module does not depend on the renderer. */
  parseMarker: (bytes: Uint8Array) => MarkerHeader | null;
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isNorthKeepCheckout(repo: string): boolean {
  const pkgName = (file: string): string | null => {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown };
      return typeof v.name === 'string' ? v.name : null;
    } catch {
      return null;
    }
  };
  return (
    pkgName(path.join(repo, 'packages', 'core', 'package.json')) === '@northkeep/core' ||
    pkgName(path.join(repo, 'package.json')) === 'northkeep'
  );
}

/** Git's own index.lock is only ever read; NorthKeep never removes it. */
export function assertNoIndexLock(gitDir: string): void {
  const lock = path.join(gitDir, 'index.lock');
  if (lstatOrNull(lock)) {
    throw new ExportRefusal(
      'index_locked',
      "The repository's index.lock exists; remove it once no git process is running, then retry",
      lock,
    );
  }
}

/** Refuses when HEAD's branch is checked out in another worktree. */
export async function assertBranchNotElsewhere(ctx: GitContext): Promise<void> {
  const text = await out(ctx, ['worktree', 'list', '--porcelain']);
  const entries: { path: string; branch: string | null }[] = [];
  for (const block of text.split(/\n\n+/)) {
    let wt: string | null = null;
    let branch: string | null = null;
    for (const l of block.split('\n')) {
      if (l.startsWith('worktree ')) wt = l.slice('worktree '.length);
      else if (l.startsWith('branch ')) branch = l.slice('branch '.length);
    }
    if (wt !== null) entries.push({ path: realOrResolved(wt), branch });
  }
  const self = entries.find((e) => e.path === ctx.repo);
  if (!self) {
    throw new ExportRefusal('worktree_unknown', 'Git does not list this folder as one of its worktrees');
  }
  if (self.branch !== null && entries.some((e) => e !== self && e.branch === self.branch)) {
    throw new ExportRefusal(
      'branch_elsewhere',
      "This folder's branch is checked out in another worktree; check out a different branch in one of them",
    );
  }
}

function readMarkerBytes(repo: string): Uint8Array | null {
  const p = path.join(repo, MARKER_FILE);
  const st = lstatOrNull(p);
  if (!st) return null;
  if (!st.isFile() || st.nlink > 1) {
    throw new ExportRefusal('marker_invalid', 'The .northkeep-mirror marker is not a plain file; restore it with git checkout -- .northkeep-mirror');
  }
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Decision 4: an empty folder with an unborn HEAD, or a folder carrying this vault's marker. */
export function checkOwnedFolder(
  repo: string,
  head: string | null,
  vaultId: string,
  parseMarker: PreflightInput['parseMarker'],
): 'fresh' | 'owned' {
  const bytes = readMarkerBytes(repo);
  if (bytes === null) {
    const names = fs.readdirSync(repo);
    if (head === null && names.length === 1 && names[0] === '.git') return 'fresh';
    throw new ExportRefusal(
      'not_owned',
      'This folder is not a NorthKeep mirror; restore it with git checkout -- .northkeep-mirror, or start a new mirror in an empty folder',
    );
  }
  const h = parseMarker(bytes);
  if (!h || h.kind !== 'marker' || h.vaultId !== vaultId) {
    throw new ExportRefusal(
      'marker_mismatch',
      'The .northkeep-mirror marker is unreadable or names another vault; restore it with git checkout -- .northkeep-mirror, or start a new mirror in an empty folder',
    );
  }
  return 'owned';
}

/** Every Decision 2 and 4 check that refuses the whole run, before any write. */
export async function preflightRepository(input: PreflightInput): Promise<{ ctx: GitContext; info: RepoInfo }> {
  let repo: string;
  try {
    repo = fs.realpathSync(input.repo);
    if (!fs.statSync(repo).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new ExportRefusal('repo_missing', 'The mirror folder does not exist or is not a folder');
  }
  ensureGitHome(input.home);
  const home = fs.realpathSync(input.home);
  const vaultDir = realOrResolved(path.dirname(input.vaultPath));
  if (inside(repo, home) || inside(repo, vaultDir)) {
    throw new ExportRefusal('repo_in_home', 'The mirror folder cannot be inside the NorthKeep data folder');
  }
  if (isNorthKeepCheckout(repo)) {
    throw new ExportRefusal('repo_is_northkeep', 'The mirror folder cannot be a NorthKeep source checkout');
  }
  const ctx: GitContext = { repo, home: input.home, vaultPath: input.vaultPath };
  const bare = await runGit(ctx, ['rev-parse', '--is-bare-repository'], { allowFailure: true });
  if (bare.exitCode !== 0 || line(bare) !== 'false') {
    throw new ExportRefusal('not_work_tree', 'The mirror folder is not a git working tree; run git init in an empty folder first');
  }
  const top = await runGit(ctx, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (top.exitCode !== 0 || realOrResolved(line(top)) !== repo) {
    throw new ExportRefusal('not_toplevel', 'The mirror folder must be the top of its git working tree');
  }
  const gitDir = await out(ctx, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const commonDir = await out(ctx, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  assertNoIndexLock(gitDir);
  await assertBranchNotElsewhere(ctx);
  const head = await readHead(ctx);
  const ownership = checkOwnedFolder(repo, head, input.vaultId, input.parseMarker);
  return { ctx, info: { repo, gitDir, commonDir, head, ownership } };
}

// ---- per-target containment (Decision 2) --------------------------------------------------

/**
 * Refuses one target, not the run: a symlink in any component, a non-regular
 * or hard-linked target, a gitlink or nested .git under projects, or a parent
 * whose realpath leaves the repository. The temp-path check is in writeMirrorFile.
 */
export async function checkTargetContainment(ctx: GitContext, rel: string, head: string | null): Promise<void> {
  if (!isMirrorPath(rel)) {
    throw new ExportRefusal('path_not_mirror', 'This path is not one NorthKeep writes');
  }
  const parts = rel.split('/');
  let cur = ctx.repo;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i] as string);
    const name = parts.slice(0, i + 1).join('/');
    const st = lstatOrNull(cur);
    if (!st) break;
    const last = i === parts.length - 1;
    if (st.isSymbolicLink()) {
      throw new ExportRefusal(
        'containment_symlink',
        `${name} is a symlink; NorthKeep exports only into a real directory inside the repository`,
      );
    }
    if (!last && !st.isDirectory()) {
      throw new ExportRefusal('containment_not_dir', `${name} is not a directory; move it aside so NorthKeep can create the folder`);
    }
    if (last && (!st.isFile() || st.nlink > 1)) {
      throw new ExportRefusal(
        'containment_not_regular',
        `${name} is not a plain file with a single link; move it aside and NorthKeep writes it fresh`,
      );
    }
  }
  if (parts[0] === 'projects' && lstatOrNull(path.join(ctx.repo, 'projects', '.git'))) {
    throw new ExportRefusal('containment_nested_git', 'projects/ holds a .git; NorthKeep does not export into a nested repository');
  }
  const dir = path.dirname(path.join(ctx.repo, rel));
  if (lstatOrNull(dir) && !inside(fs.realpathSync(dir), ctx.repo)) {
    throw new ExportRefusal('containment_outside', 'The target folder resolves outside the repository');
  }
  if (head !== null && parts[0] === 'projects') {
    for (const spec of ['projects', rel]) {
      const tree = await out(ctx, ['ls-tree', 'HEAD', '--', spec]);
      if (tree.split('\n').some((l) => l.startsWith('160000 '))) {
        throw new ExportRefusal('containment_gitlink', 'projects/ is a submodule in HEAD; NorthKeep does not export into a submodule');
      }
    }
  }
}

// ---- identity, remotes, commit (Decisions 2, 7 and 9) -------------------------------------

/** Refuses before any write when the repository has no identity; NorthKeep never sets one. */
export async function requireCommitIdentity(ctx: GitContext): Promise<void> {
  for (const v of ['GIT_COMMITTER_IDENT', 'GIT_AUTHOR_IDENT']) {
    const r = await runGit(ctx, ['var', v], { allowFailure: true });
    if (r.exitCode !== 0) {
      throw new ExportRefusal(
        'no_identity',
        'This repository has no commit identity. Set one with: git config user.name "Your Name" and git config user.email "you@example.com"',
      );
    }
  }
}

export interface RemoteInfo {
  name: string;
  url: string;
}

/** Read-only, for --status. Credentials embedded in an http(s) URL are dropped. */
export async function readRemotes(ctx: GitContext): Promise<RemoteInfo[]> {
  const text = await out(ctx, ['remote', '-v']);
  const seen = new Map<string, RemoteInfo>();
  for (const l of text.split('\n')) {
    const m = /^(\S+)\t(\S+)(?: \((?:fetch|push)\))?$/.exec(l);
    if (!m) continue;
    const url = (m[2] as string).replace(/^(https?:\/\/)[^/@]*@/i, '$1');
    seen.set(`${m[1]}\0${url}`, { name: m[1] as string, url });
  }
  return [...seen.values()];
}

export interface CommitEntry {
  path: string;
  blob: string;
}

export interface CommitInput {
  add: CommitEntry[];
  remove?: string[];
  message: string;
}

export interface CommitResult {
  status: 'committed' | 'unchanged';
  commit: string | null;
  tree: string;
  indexRefreshed: boolean;
  note: string | null;
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * One commit per run from a temporary index seeded from HEAD, then the
 * reconcile of the default index. An unchanged tree stops before commit-tree.
 * Blobs must already be stored with hashObjectWrite.
 */
export async function plumbingCommit(ctx: GitContext, info: RepoInfo, input: CommitInput): Promise<CommitResult> {
  const remove = input.remove ?? [];
  for (const p of [...input.add.map((e) => e.path), ...remove]) {
    if (!isMirrorPath(p)) throw new ExportRefusal('path_not_mirror', 'NorthKeep commits only its own mirror paths');
  }
  for (const e of input.add) {
    if (!OID.test(e.blob)) throw new ExportRefusal('bad_blob', 'NorthKeep refused a malformed blob id');
  }
  assertNoIndexLock(info.gitDir);
  await assertBranchNotElsewhere(ctx);
  const parent = await readHead(ctx);
  fs.rmSync(tempIndexPath(ctx.home, ctx.repo), { force: true });
  if (parent) await runGit(ctx, ['read-tree', parent]);
  else await runGit(ctx, ['read-tree', '--empty']);
  for (const e of input.add) {
    await runGit(ctx, ['update-index', '--add', '--cacheinfo', `100644,${e.blob},${e.path}`]);
  }
  for (const p of remove) await runGit(ctx, ['update-index', '--force-remove', '--', p]);
  const tree = await out(ctx, ['write-tree']);
  let commit: string | null = null;
  if (!parent || tree !== (await out(ctx, ['rev-parse', `${parent}^{tree}`]))) {
    const ctArgs = parent ? ['commit-tree', tree, '-p', parent] : ['commit-tree', tree];
    commit = await out(ctx, ctArgs, { input: input.message });
    assertNoIndexLock(info.gitDir);
    const urArgs = ['update-ref', '-m', 'northkeep export', 'HEAD', commit];
    if (parent) urArgs.push(parent);
    await runGit(ctx, urArgs);
  }
  let indexRefreshed = true;
  try {
    for (const e of input.add) {
      await runGit(ctx, ['update-index', '--add', '--cacheinfo', `100644,${e.blob},${e.path}`], { index: 'default' });
    }
    for (const p of remove) await runGit(ctx, ['update-index', '--force-remove', '--', p], { index: 'default' });
  } catch {
    indexRefreshed = false;
  }
  fs.rmSync(tempIndexPath(ctx.home, ctx.repo), { force: true });
  return {
    status: commit ? 'committed' : 'unchanged',
    commit,
    tree,
    indexRefreshed,
    note: indexRefreshed ? null : commit ? INDEX_NOT_REFRESHED : 'working index not refreshed',
  };
}
