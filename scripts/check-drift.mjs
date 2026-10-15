#!/usr/bin/env node
// Drift checks: the release version must agree everywhere a release writes it,
// and Markdown must not point at repo files that do not exist.
// Usage: node scripts/check-drift.mjs [repoRoot]. Exit 1 on any problem.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, normalize, relative, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/;

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** Every place a release writes the version, read from disk. */
export function readVersions(root) {
  const found = { problems: [] };

  const tauri = readIfExists(join(root, 'apps/desktop/src-tauri/tauri.conf.json'));
  if (tauri === null) found.problems.push('apps/desktop/src-tauri/tauri.conf.json is missing.');
  else found.desktop = JSON.parse(tauri).version;

  const web = readIfExists(join(root, 'apps/web/src/api.ts'));
  const webMatch = web && web.match(/const APP_VERSION = '([^']+)'/);
  if (!webMatch) found.problems.push("apps/web/src/api.ts has no `const APP_VERSION = '...'` line.");
  else found.web = webMatch[1];

  const mobile = readIfExists(join(root, 'apps/mobile/app.config.ts'));
  const mobileMatch = mobile && mobile.match(/^\s*version:\s*'([^']+)'/m);
  if (!mobileMatch) found.problems.push("apps/mobile/app.config.ts has no `version: '...'` line.");
  else found.mobile = mobileMatch[1];

  const readme = readIfExists(join(root, 'README.md')) ?? '';
  found.readme = [...readme.matchAll(/current download is v?(\d+\.\d+\.\d+)/gi)].map((m) => m[1]);

  found.site = [];
  const siteDir = join(root, 'site');
  if (existsSync(siteDir)) {
    for (const name of readdirSync(siteDir).filter((n) => n.endsWith('.html')).sort()) {
      const html = readFileSync(join(siteDir, name), 'utf8');
      for (const m of html.matchAll(/releases\/download\/v(\d+\.\d+\.\d+)\/[^"'\s]*?_(\d+\.\d+\.\d+)[_.]/g)) {
        found.site.push({ file: `site/${name}`, tag: m[1], asset: m[2] });
      }
    }
  }
  return found;
}

/** Plain-language problems with the release version; empty when it agrees. */
export function checkVersions(root) {
  const v = readVersions(root);
  const problems = [...v.problems];
  const notes = [];
  const release = v.desktop;
  if (!release) return { problems, notes };
  if (!SEMVER.test(release)) problems.push(`Desktop version "${release}" is not x.y.z.`);

  if (v.web && v.web !== release) {
    problems.push(`apps/web/src/api.ts says APP_VERSION ${v.web}, but the desktop release is ${release}. Settings → About and the update check would report the wrong version.`);
  }
  // The iPhone's marketing version moves with App Store submissions, not with
  // every Mac release, so it may lag. It may never lead: that would name a
  // release that does not exist.
  if (v.mobile) {
    if (!SEMVER.test(v.mobile)) problems.push(`apps/mobile/app.config.ts version "${v.mobile}" is not x.y.z.`);
    else if (compareVersions(v.mobile, release) > 0) {
      problems.push(`apps/mobile/app.config.ts says ${v.mobile}, which is ahead of the desktop release ${release}. The phone may lag the Mac but never lead it.`);
    } else if (v.mobile !== release) {
      notes.push(`iPhone app is ${v.mobile}, desktop is ${release} (allowed: the phone may lag).`);
    }
  }
  for (const r of v.readme) {
    if (r !== release) problems.push(`README.md says "The current download is ${r}", but the desktop release is ${release}.`);
  }
  for (const s of v.site) {
    if (s.tag !== release || s.asset !== release) {
      problems.push(`${s.file} links to the v${s.tag} download (${s.asset} asset), but the desktop release is ${release}.`);
    }
  }
  return { problems, notes };
}

// ---------------------------------------------------------------- links

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', '.expo', 'ios', 'android', '.turbo', 'coverage']);
const PATH_EXT = /\.(md|ts|tsx|mts|mjs|cjs|js|json|ya?ml|html|css|toml|rs|sh|py|sql|txt|plist)$/;
const TOP_DIRS = ['SPEC/', 'docs/', 'packages/', 'apps/', 'scripts/', 'e2e/', 'site/', 'legal/', 'workers/', 'brand/', '.github/'];

/** Paths (relative to root, forward slashes) of every file in the repo. */
export function listRepoFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const files = out.split('\0').filter((f) => f && existsSync(join(root, f)));
    if (files.length > 0 && existsSync(join(root, '.git'))) return files;
  } catch {
    // Not a git checkout (test fixtures): walk the tree instead.
  }
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return files;
}

/** Replaces fenced code blocks with blank lines so line numbers survive. */
function stripFences(text) {
  const lines = text.split('\n');
  let fence = null;
  return lines.map((line) => {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return '';
    }
    if (m) { fence = m[1]; return ''; }
    return line;
  });
}

function looksLikePlaceholder(p) {
  return /[<>*{}$|\\]|\.\.\.|^~|^\/|^[a-z]+:|\s/.test(p) || /^@/.test(p);
}

/**
 * Candidate references on one line. Markdown links are always checked. Code
 * spans and prose are checked only where they clearly name a repo file: a path
 * from a top-level repo folder, or an upper-case doc name like `KNOWN-LIMITS.md`.
 */
export function referencesInLine(line) {
  const refs = [];
  const spans = [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  const outsideCode = line.replace(/`[^`\n]*`/g, ' ');
  const linkRe = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const m of outsideCode.matchAll(linkRe)) refs.push({ kind: 'link', target: m[1] });
  const def = outsideCode.match(/^\s{0,3}\[[^\]]+\]:\s+<?(\S+?)>?(\s|$)/);
  if (def) refs.push({ kind: 'link', target: def[1] });

  for (const span of spans) {
    const t = span.replace(/:\d+(-\d+)?$/, '').replace(/[),.;:]+$/, '');
    if (isRepoPath(t)) refs.push({ kind: 'code', target: t });
  }
  const prose = outsideCode.replace(linkRe, ' ');
  for (const m of prose.matchAll(/(?<![\w/.@~$-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[a-z]+)(?![\w/])/g)) {
    if (isRepoPath(m[1])) refs.push({ kind: 'prose', target: m[1] });
  }
  return refs;
}

const UPPER_DOC = /^[0-9A-Z][0-9A-Z_-]*\.md$/;

/** True when text names a file in this repo rather than a runtime or example file. */
export function isRepoPath(t) {
  if (looksLikePlaceholder(t) || t.length > 200 || !/^[\w./-]+$/.test(t)) return false;
  if (TOP_DIRS.some((d) => t.startsWith(d))) return t.includes('/') && (PATH_EXT.test(t) || t.endsWith('/'));
  return UPPER_DOC.test(t);
}

/**
 * Allowlist: references that are right even though no such file exists in
 * the repo. Each entry needs a reason.
 */
export const ALLOWLIST = [
  { pattern: /(^|\/)(dist|target|build|node_modules)\//, reason: 'build output, not committed' },
  { pattern: /^apps\/desktop\/(\.node-cache|src-tauri\/server-tree)\/$/, reason: 'made by the desktop bundle script, gitignored' },
  { pattern: /^INDEX\.md$/, reason: 'written into the git mirror by export (ADR 0053), not into this repo' },
]

function allowlisted(target) {
  return ALLOWLIST.some((a) => a.pattern.test(target));
}

function resolveRef(root, fromFile, ref, byName) {
  let target = ref.target.split('#')[0].split('?')[0];
  if (!target) return true; // pure anchor
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return true; // URL
  try { target = decodeURIComponent(target); } catch { /* keep raw */ }
  if (ref.kind !== 'link' && looksLikePlaceholder(target)) return true;
  if (allowlisted(target)) return true;
  const fromDir = dirname(join(root, fromFile));
  const candidates = target.startsWith('/')
    ? [join(root, target)]
    : [resolve(fromDir, target), ...(ref.kind === 'link' ? [] : [join(root, target)])];
  for (const c of candidates) {
    if (!normalize(c).startsWith(normalize(root))) continue;
    if (existsSync(c)) return true;
  }
  // A bare doc name ("see KNOWN-LIMITS.md") may live in any folder.
  if (ref.kind !== 'link' && !target.includes('/') && byName.has(target)) return true;
  return false;
}

/** Plain-language problems with dead file references in Markdown. */
export function checkLinks(root, { exclude = DEFAULT_LINK_EXCLUDES } = {}) {
  root = resolve(root);
  const files = listRepoFiles(root);
  const byName = new Map();
  for (const f of files) {
    const b = basename(f);
    if (!byName.has(b)) byName.set(b, []);
    byName.get(b).push(f);
  }
  const problems = [];
  for (const file of files.filter((f) => f.endsWith('.md')).sort()) {
    if (file.split('/').some((part) => SKIP_DIRS.has(part))) continue;
    if (exclude.some((e) => e.test(file))) continue;
    const lines = stripFences(readFileSync(join(root, file), 'utf8'));
    lines.forEach((line, i) => {
      const seen = new Set();
      for (const ref of referencesInLine(line)) {
        if (seen.has(ref.target)) continue;
        seen.add(ref.target);
        if (!resolveRef(root, file, ref, byName)) {
          problems.push(`${file}:${i + 1} refers to ${ref.target}, which does not exist in the repo.`);
        }
      }
    });
  }
  return { problems };
}

// Dated records: design history and evidence describe the repo as it was on
// the day they were written. Their paths are allowed to go stale.
export const DEFAULT_LINK_EXCLUDES = [/^docs\/design\//, /^docs\/evidence\//];

// ---------------------------------------------------------------- main

function main() {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const versions = checkVersions(root);
  const links = checkLinks(root);
  for (const n of versions.notes) console.log(`note: ${n}`);
  const all = [
    ...versions.problems.map((p) => ['Version drift', p]),
    ...links.problems.map((p) => ['Dead file reference', p]),
  ];
  if (all.length === 0) {
    console.log('Drift check passed: versions agree and every Markdown file reference exists.');
    return 0;
  }
  console.error(`Drift check failed with ${all.length} problem(s):\n`);
  for (const [kind, p] of all) console.error(`  ${kind}: ${p}`);
  console.error('\nFix the file, or for a reference that is right on purpose, add it to ALLOWLIST in scripts/check-drift.mjs with a reason.');
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
