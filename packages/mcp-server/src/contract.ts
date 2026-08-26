import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, backupOnce } from './fs-safe.js';
import { PROJECT_STANDING_INSTRUCTION } from './project-recipe.js';

/**
 * M16 contract installer (ADR 0042). Writes the standing project instruction
 * into the host files Claude Code, Codex, and Cursor actually read. Tests MUST
 * pass path overrides; this module's defaults point at the real home paths
 * and must never be used against Jay's machine from a test.
 */

export type ContractTarget = 'claude' | 'codex' | 'cursor-project';

export type ContractStatusKind = 'installed' | 'stale' | 'absent' | 'blocked';

export interface ContractOpts {
  /** File-path override for a single-target call. */
  path?: string;
  /** Claude file override when installing more than one target. */
  claudePath?: string;
  /** Claude: rules-directory override (`NORTHKEEP_CLAUDE_RULES_DIR`). */
  claudeRulesDir?: string;
  /** Codex file override when installing more than one target. */
  codexPath?: string;
  /** Codex home (existence gate + override sibling). */
  codexHome?: string;
  /** Cursor: project directory. Required for cursor-project. */
  projectDir?: string;
}

export interface ContractStatusResult {
  target: ContractTarget;
  status: ContractStatusKind;
  path: string;
  message?: string;
}

export interface InstallResult {
  target: ContractTarget;
  path: string;
  skipped?: boolean;
  skipReason?: string;
  warning?: string;
}

export interface UninstallResult {
  target: ContractTarget;
  path: string;
  action: 'deleted' | 'moved-aside' | 'absent' | 'block-removed' | 'refused';
  backupPath?: string;
  message?: string;
}

/** P6, pinned verbatim in ADR 0042. */
export const CONTRACT_GRACEFUL_DEGRADATION =
  'If the NorthKeep project tools are unavailable, disabled, or a call returns a scope or permission error, mention it once and continue without them; never retry in a loop and never block the session on it.';

/**
 * Canonical contract. Composed from PROJECT_STANDING_INSTRUCTION plus the
 * anti-spam, no-false-pass, no-secrets, hosted-surface, and P6 lines.
 * No em dashes. Under 2048 bytes.
 */
export const CONTRACT_TEXT =
  PROJECT_STANDING_INSTRUCTION +
  ' Only do this when the user names a project or the work clearly belongs to one. ' +
  'If you are unsure whether the work is a tracked project, call project_list once and match; if nothing matches, do nothing. ' +
  'Do not claim a project was updated unless the project_update call succeeded. ' +
  'Never write secrets, credentials, PHI, or personal identifying information into a project document. ' +
  'On a hosted surface, use the NorthKeep connector project tools if they are present; never create a project there. ' +
  CONTRACT_GRACEFUL_DEGRADATION;

export const CLAUDE_CONTRACT_FILENAME = 'northkeep-projects.md';
export const CURSOR_CONTRACT_FILENAME = 'northkeep.mdc';
export const OWNERSHIP_MARKER = '<!-- northkeep-contract -->';
export const OWNERSHIP_MARKER_END = '<!-- /northkeep-contract -->';

const BEGIN_LINE = /^<!-- northkeep-contract -->\r?$/;
const END_LINE = /^<!-- \/northkeep-contract -->\r?$/;

const CODEX_SKIP_MESSAGE =
  'Codex not detected, skipped; run northkeep contract install codex to force.';

const CODEX_OVERRIDE_WARNING =
  'AGENTS.override.md is present, so Codex uses that file instead of AGENTS.md. ' +
  'The contract was written to AGENTS.md but will not take effect until the override is removed.';

const CURSOR_GIT_NOTE =
  'This Cursor rule file may be committed with the repo. Collaborators will see it and do not have NorthKeep. ' +
  'To keep it personal, add .cursor/rules/northkeep.mdc to .git/info/exclude. NorthKeep never edits .gitignore.';

export function cursorGitVisibilityNote(): string {
  return CURSOR_GIT_NOTE;
}

function withOneTrailingNewline(text: string): string {
  return text.replace(/\n+$/, '') + '\n';
}

function stripBom(text: string): { bom: string; rest: string } {
  if (text.startsWith('\uFEFF')) return { bom: '\uFEFF', rest: text.slice(1) };
  return { bom: '', rest: text };
}

function hasOwnershipMarker(text: string): boolean {
  return text.split('\n').some((line) => BEGIN_LINE.test(line));
}

function bytesMatchRender(existing: string, rendered: string): boolean {
  return withOneTrailingNewline(existing) === withOneTrailingNewline(rendered);
}

/** Exact bytes install writes and status compares (P4). */
export function renderContract(target: ContractTarget): string {
  switch (target) {
    case 'claude':
      return withOneTrailingNewline(`${OWNERSHIP_MARKER}\n${CONTRACT_TEXT}`);
    case 'codex':
      return withOneTrailingNewline(
        `${OWNERSHIP_MARKER}\n${CONTRACT_TEXT}\n${OWNERSHIP_MARKER_END}`,
      );
    case 'cursor-project':
      return withOneTrailingNewline(
        `---\nalwaysApply: true\n---\n${OWNERSHIP_MARKER}\n${CONTRACT_TEXT}`,
      );
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unhandled Contract target: ${String(_exhaustive)}`);
    }
  }
}

export function claudeRulesPath(override?: string, rulesDirOverride?: string): string {
  if (override) return override;
  const dir = rulesDirOverride ?? process.env.NORTHKEEP_CLAUDE_RULES_DIR;
  if (dir) return path.join(dir, CLAUDE_CONTRACT_FILENAME);
  return path.join(os.homedir(), '.claude', 'rules', CLAUDE_CONTRACT_FILENAME);
}

export function codexHomePath(override?: string): string {
  if (override) return override;
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  return path.join(os.homedir(), '.codex');
}

export function codexAgentsPath(override?: string, homeOverride?: string): string {
  if (override) return override;
  const fromEnv = process.env.NORTHKEEP_CODEX_AGENTS;
  if (fromEnv) return fromEnv;
  return path.join(codexHomePath(homeOverride), 'AGENTS.md');
}

export function isCodexDetected(homeOverride?: string): boolean {
  return fs.existsSync(codexHomePath(homeOverride));
}

export function codexOverridePath(agentsFile: string): string {
  return path.join(path.dirname(agentsFile), 'AGENTS.override.md');
}

function resolveCursorProjectDir(projectDir: string): string {
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Refusing to install: ${projectDir} does not exist or is not a directory.`);
  }
  const resolved = fs.realpathSync(projectDir);
  const st = fs.statSync(resolved);
  if (!st.isDirectory()) {
    throw new Error(`Refusing to install: ${resolved} is not a directory.`);
  }
  const root = path.parse(resolved).root;
  if (resolved === root || resolved === path.sep) {
    throw new Error('Refusing to install a Cursor contract at the filesystem root.');
  }
  let home: string;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    home = path.resolve(os.homedir());
  }
  if (resolved === home) {
    throw new Error('Refusing to install a Cursor contract in the home directory.');
  }
  if (home === resolved || home.startsWith(resolved + path.sep)) {
    throw new Error('Refusing to install a Cursor contract in an ancestor of the home directory.');
  }
  return resolved;
}

export function cursorRulePath(projectDir: string): string {
  return path.join(resolveCursorProjectDir(projectDir), '.cursor', 'rules', CURSOR_CONTRACT_FILENAME);
}

function targetFile(target: ContractTarget, opts: ContractOpts = {}): string {
  switch (target) {
    case 'claude':
      return claudeRulesPath(opts.path ?? opts.claudePath, opts.claudeRulesDir);
    case 'codex':
      return codexAgentsPath(opts.path ?? opts.codexPath, opts.codexHome);
    case 'cursor-project':
      if (!opts.projectDir) {
        throw new Error('Cursor contract install requires --project <dir>.');
      }
      return cursorRulePath(opts.projectDir);
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unhandled Contract target: ${String(_exhaustive)}`);
    }
  }
}

function foreignFileRefusal(file: string): Error {
  return new Error(
    `Refusing to modify ${file}: it exists and is not a NorthKeep contract file. ` +
      `Move or rename it, then reinstall.`,
  );
}

function installOwnedFile(target: 'claude' | 'cursor-project', file: string): InstallResult {
  const rendered = renderContract(target);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8');
    if (!hasOwnershipMarker(existing)) throw foreignFileRefusal(file);
  }
  atomicWrite(file, rendered);
  return { target, path: file };
}

function uninstallOwnedFile(
  target: 'claude' | 'cursor-project',
  file: string,
): UninstallResult {
  if (!fs.existsSync(file)) return { target, path: file, action: 'absent' };
  const existing = fs.readFileSync(file, 'utf8');
  if (bytesMatchRender(existing, renderContract(target))) {
    fs.rmSync(file);
    return { target, path: file, action: 'deleted' };
  }
  if (hasOwnershipMarker(existing)) {
    const bak = `${file}.northkeep-bak`;
    fs.renameSync(file, bak);
    return {
      target,
      path: file,
      action: 'moved-aside',
      backupPath: bak,
      message: `The file was edited, so it was moved to ${path.basename(bak)} instead of deleted.`,
    };
  }
  return {
    target,
    path: file,
    action: 'refused',
    message: `Refusing to remove ${file}: it is not a NorthKeep contract file.`,
  };
}

function statusOwnedFile(
  target: 'claude' | 'cursor-project',
  file: string,
): ContractStatusResult {
  if (!fs.existsSync(file)) return { target, path: file, status: 'absent' };
  const existing = fs.readFileSync(file, 'utf8');
  if (!hasOwnershipMarker(existing)) {
    return {
      target,
      path: file,
      status: 'blocked',
      message: 'A file exists at this path without a NorthKeep ownership marker.',
    };
  }
  if (bytesMatchRender(existing, renderContract(target))) {
    return { target, path: file, status: 'installed' };
  }
  return { target, path: file, status: 'stale' };
}

interface MarkerHit {
  start: number;
  end: number;
}

function scanMarkers(text: string): { begins: MarkerHit[]; ends: MarkerHit[] } {
  const begins: MarkerHit[] = [];
  const ends: MarkerHit[] = [];
  let pos = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const hasNl = i < lines.length - 1;
    const spanEnd = pos + line.length + (hasNl ? 1 : 0);
    if (BEGIN_LINE.test(line)) begins.push({ start: pos, end: spanEnd });
    if (END_LINE.test(line)) ends.push({ start: pos, end: spanEnd });
    pos = spanEnd;
  }
  return { begins, ends };
}

function malformedMarkersRefusal(file: string): Error {
  return new Error(
    `Refusing to modify ${file}: NorthKeep's contract markers are duplicated or unpaired. ` +
      `Fix or remove them, then reinstall.`,
  );
}

function classifyCodexMarkers(
  file: string,
  rest: string,
): { kind: 'none' } | { kind: 'pair'; begin: MarkerHit; end: MarkerHit } {
  const { begins, ends } = scanMarkers(rest);
  if (begins.length === 0 && ends.length === 0) return { kind: 'none' };
  if (begins.length === 1 && ends.length === 1 && begins[0]!.start < ends[0]!.start) {
    return { kind: 'pair', begin: begins[0]!, end: ends[0]! };
  }
  throw malformedMarkersRefusal(file);
}

function installCodex(file: string): InstallResult {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const { bom, rest } = stripBom(raw);
  const markers = classifyCodexMarkers(file, rest);
  let next: string;
  if (markers.kind === 'none') {
    if (rest.trim() === '') {
      next = renderContract('codex');
    } else {
      const base = rest.replace(/\s*$/, '');
      next = `${base}\n\n${renderContract('codex')}`;
    }
  } else {
    const interior = withOneTrailingNewline(CONTRACT_TEXT);
    next = rest.slice(0, markers.begin.end) + interior + rest.slice(markers.end.start);
  }
  if (fs.existsSync(file)) backupOnce(file);
  atomicWrite(file, bom + next);
  const result: InstallResult = { target: 'codex', path: file };
  if (fs.existsSync(codexOverridePath(file))) {
    result.warning = CODEX_OVERRIDE_WARNING;
  }
  return result;
}

function uninstallCodex(file: string): UninstallResult {
  if (!fs.existsSync(file)) return { target: 'codex', path: file, action: 'absent' };
  const raw = fs.readFileSync(file, 'utf8');
  const { bom, rest } = stripBom(raw);
  const markers = classifyCodexMarkers(file, rest);
  if (markers.kind === 'none') return { target: 'codex', path: file, action: 'absent' };
  backupOnce(file);
  let before = rest.slice(0, markers.begin.start);
  let after = rest.slice(markers.end.end);
  before = before.replace(/[ \t]*\r?\n?[ \t]*$/, '');
  after = after.replace(/^\r?\n/, '');
  const rebuilt = before === '' && after === '' ? '' : withOneTrailingNewline(before + (before && after ? '\n' : '') + after);
  atomicWrite(file, bom + rebuilt);
  return { target: 'codex', path: file, action: 'block-removed' };
}

function statusCodex(file: string): ContractStatusResult {
  const override = fs.existsSync(codexOverridePath(file));
  if (!fs.existsSync(file)) {
    return {
      target: 'codex',
      path: file,
      status: override ? 'blocked' : 'absent',
      message: override ? CODEX_OVERRIDE_WARNING : undefined,
    };
  }
  const raw = fs.readFileSync(file, 'utf8');
  const { rest } = stripBom(raw);
  let markers: ReturnType<typeof classifyCodexMarkers>;
  try {
    markers = classifyCodexMarkers(file, rest);
  } catch {
    return {
      target: 'codex',
      path: file,
      status: 'blocked',
      message: 'NorthKeep contract markers are duplicated or unpaired.',
    };
  }
  if (markers.kind === 'none') {
    return {
      target: 'codex',
      path: file,
      status: override ? 'blocked' : 'absent',
      message: override ? CODEX_OVERRIDE_WARNING : undefined,
    };
  }
  if (override) {
    return { target: 'codex', path: file, status: 'blocked', message: CODEX_OVERRIDE_WARNING };
  }
  const interior = rest.slice(markers.begin.end, markers.end.start);
  if (bytesMatchRender(interior, CONTRACT_TEXT)) {
    return { target: 'codex', path: file, status: 'installed' };
  }
  return { target: 'codex', path: file, status: 'stale' };
}

export function installContract(target: ContractTarget, opts: ContractOpts = {}): InstallResult {
  switch (target) {
    case 'claude':
      return installOwnedFile('claude', targetFile('claude', opts));
    case 'codex':
      return installCodex(targetFile('codex', opts));
    case 'cursor-project': {
      if (!opts.projectDir) {
        throw new Error('Cursor contract install requires --project <dir>.');
      }
      const resolved = resolveCursorProjectDir(opts.projectDir);
      const file = path.join(resolved, '.cursor', 'rules', CURSOR_CONTRACT_FILENAME);
      const result = installOwnedFile('cursor-project', file);
      if (!fs.existsSync(path.join(resolved, '.git'))) {
        result.warning =
          (result.warning ? `${result.warning} ` : '') +
          'No .git directory here. Cursor still accepts the rule; it will not be version-controlled.';
      }
      return result;
    }
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unhandled Contract target: ${String(_exhaustive)}`);
    }
  }
}

export function installAll(opts: ContractOpts = {}): InstallResult[] {
  const results: InstallResult[] = [installContract('claude', opts)];
  if (isCodexDetected(opts.codexHome)) {
    results.push(installContract('codex', opts));
  } else {
    results.push({
      target: 'codex',
      path: codexAgentsPath(opts.path ?? opts.codexPath, opts.codexHome),
      skipped: true,
      skipReason: CODEX_SKIP_MESSAGE,
    });
  }
  return results;
}

export function uninstallContract(target: ContractTarget, opts: ContractOpts = {}): UninstallResult {
  switch (target) {
    case 'claude':
      return uninstallOwnedFile('claude', targetFile('claude', opts));
    case 'codex':
      return uninstallCodex(targetFile('codex', opts));
    case 'cursor-project':
      return uninstallOwnedFile('cursor-project', targetFile('cursor-project', opts));
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unhandled Contract target: ${String(_exhaustive)}`);
    }
  }
}

export function contractStatus(target: ContractTarget, opts: ContractOpts = {}): ContractStatusResult {
  switch (target) {
    case 'claude':
      return statusOwnedFile('claude', targetFile('claude', opts));
    case 'codex':
      return statusCodex(targetFile('codex', opts));
    case 'cursor-project':
      return statusOwnedFile('cursor-project', targetFile('cursor-project', opts));
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unhandled Contract target: ${String(_exhaustive)}`);
    }
  }
}

export function contractStatusAll(opts: ContractOpts = {}): ContractStatusResult[] {
  const results: ContractStatusResult[] = [
    contractStatus('claude', opts),
    contractStatus('codex', opts),
  ];
  if (opts.projectDir) {
    results.push(contractStatus('cursor-project', opts));
  }
  return results;
}
