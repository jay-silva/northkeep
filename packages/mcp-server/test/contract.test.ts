import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTRACT_GRACEFUL_DEGRADATION,
  CONTRACT_TEXT,
  OWNERSHIP_MARKER,
  claudeRulesPath,
  codexAgentsPath,
  contractStatus,
  installAll,
  installContract,
  renderContract,
  uninstallContract,
} from '../src/contract.js';
import {
  PROJECT_BOOTSTRAP_INSTRUCTION,
  PROJECT_STANDING_INSTRUCTION,
} from '../src/project-recipe.js';

let dir: string;
let prevClaudeRules: string | undefined;
let prevCodexAgents: string | undefined;
let prevCodexHome: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-contract-'));
  prevClaudeRules = process.env.NORTHKEEP_CLAUDE_RULES_DIR;
  prevCodexAgents = process.env.NORTHKEEP_CODEX_AGENTS;
  prevCodexHome = process.env.CODEX_HOME;
  delete process.env.NORTHKEEP_CLAUDE_RULES_DIR;
  delete process.env.NORTHKEEP_CODEX_AGENTS;
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  if (prevClaudeRules === undefined) delete process.env.NORTHKEEP_CLAUDE_RULES_DIR;
  else process.env.NORTHKEEP_CLAUDE_RULES_DIR = prevClaudeRules;
  if (prevCodexAgents === undefined) delete process.env.NORTHKEEP_CODEX_AGENTS;
  else process.env.NORTHKEEP_CODEX_AGENTS = prevCodexAgents;
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

function claudeFile(): string {
  return path.join(dir, 'claude-rules', 'northkeep-projects.md');
}

function codexFile(): string {
  return path.join(dir, 'codex', 'AGENTS.md');
}

function projectDir(): string {
  return path.join(dir, 'proj');
}

describe('CONTRACT_TEXT', () => {
  it('has no em dash, is under 4096 bytes, contains P6 and standing-instruction tools', () => {
    expect(CONTRACT_TEXT).not.toMatch(/[—–]/);
    // ADR 0042 pinned 2048 for one paragraph; ADR 0052 Decision 5 adds the
    // bootstrap paragraph, so the bound is doubled rather than removed.
    expect(Buffer.byteLength(CONTRACT_TEXT, 'utf8')).toBeLessThan(4096);
    expect(CONTRACT_TEXT).toContain(CONTRACT_GRACEFUL_DEGRADATION);
    expect(CONTRACT_TEXT).toContain('project_resume');
    expect(CONTRACT_TEXT).toContain('project_wrap');
    expect(CONTRACT_TEXT).toContain('project_checkpoint');
    expect(CONTRACT_TEXT).toContain('project_update');
    expect(CONTRACT_TEXT).toContain('project_list');
    expect(CONTRACT_TEXT).toContain('project_create');
    expect(CONTRACT_TEXT).toContain(PROJECT_STANDING_INSTRUCTION);
    // ADR 0052 Decision 5: the installed block carries both paragraphs.
    expect(CONTRACT_TEXT).toContain(PROJECT_BOOTSTRAP_INSTRUCTION);
    // ADR 0050 Decision 7: one sentence, on every surface.
    expect(CONTRACT_TEXT).toContain(
      'Create a project with project_create only when the user asks for one; never create one to hold notes that belong in an existing project or in a memory.',
    );
    expect(CONTRACT_TEXT).not.toContain('On a hosted surface');
    expect(CONTRACT_TEXT).not.toContain('never create a project there');
    expect(CONTRACT_GRACEFUL_DEGRADATION).toBe(
      'If the NorthKeep project tools are unavailable, disabled, or a call returns a scope or permission error, mention it once and continue without them; never retry in a loop and never block the session on it.',
    );
  });
});

describe('Claude contract', () => {
  it('creates the rules file and parent directory', () => {
    const file = claudeFile();
    expect(fs.existsSync(file)).toBe(false);
    const result = installContract('claude', { path: file });
    expect(result.path).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(renderContract('claude'));
    expect(fs.readFileSync(file, 'utf8').startsWith('<!-- northkeep-contract -->\n')).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a foreign file without the ownership marker', () => {
    const file = claudeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const foreign = 'someone else wrote this\n';
    fs.writeFileSync(file, foreign);
    expect(() => installContract('claude', { path: file })).toThrow(/not a NorthKeep contract file/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(foreign);
  });

  it('uninstall deletes on byte match', () => {
    const file = claudeFile();
    installContract('claude', { path: file });
    const result = uninstallContract('claude', { path: file });
    expect(result.action).toBe('deleted');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('uninstall moves aside an edited marked file', () => {
    const file = claudeFile();
    installContract('claude', { path: file });
    fs.writeFileSync(file, `${renderContract('claude')}\n# my notes\n`);
    const result = uninstallContract('claude', { path: file });
    expect(result.action).toBe('moved-aside');
    expect(fs.existsSync(file)).toBe(false);
    expect(result.backupPath).toBe(`${file}.northkeep-bak`);
    expect(fs.existsSync(`${file}.northkeep-bak`)).toBe(true);
    expect(fs.readFileSync(`${file}.northkeep-bak`, 'utf8')).toContain('my notes');
  });

  it('status reports absent, installed, stale, and blocked', () => {
    const file = claudeFile();
    expect(contractStatus('claude', { path: file }).status).toBe('absent');

    installContract('claude', { path: file });
    expect(contractStatus('claude', { path: file }).status).toBe('installed');

    fs.writeFileSync(file, `${renderContract('claude')}\nextra\n`);
    expect(contractStatus('claude', { path: file }).status).toBe('stale');

    fs.writeFileSync(file, 'not ours\n');
    expect(contractStatus('claude', { path: file }).status).toBe('blocked');
  });

  it('claudeRulesPath honors NORTHKEEP_CLAUDE_RULES_DIR', () => {
    const rules = path.join(dir, 'env-rules');
    process.env.NORTHKEEP_CLAUDE_RULES_DIR = rules;
    expect(claudeRulesPath()).toBe(path.join(rules, 'northkeep-projects.md'));
  });
});

describe('Codex contract', () => {
  it('appends a blank-line-separated block to an existing file', () => {
    const file = codexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prior = '# my agents\n\nDo not touch this comment.\n';
    fs.writeFileSync(file, prior);
    installContract('codex', { path: file });
    const after = fs.readFileSync(file, 'utf8');
    expect(after.startsWith(prior.replace(/\n+$/, ''))).toBe(true);
    expect(after).toContain(renderContract('codex').trimEnd());
    expect(after).toContain('\n\n<!-- northkeep-contract -->\n');
    expect(contractStatus('codex', { path: file }).status).toBe('installed');
  });

  it('replaces interior bytes and preserves other bytes including CRLF and BOM', () => {
    const file = codexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const secret = '[mcp_servers.other]\nenv = { SECRET = "do-not-touch" }\n';
    const original =
      '\uFEFF# keep me\r\n' +
      secret.replace(/\n/g, '\r\n') +
      '<!-- northkeep-contract -->\r\n' +
      'OLD CONTRACT\r\n' +
      '<!-- /northkeep-contract -->\r\n' +
      '# after\r\n';
    fs.writeFileSync(file, original);

    installContract('codex', { path: file });
    const after = fs.readFileSync(file, 'utf8');
    expect(after.startsWith('\uFEFF')).toBe(true);
    expect(after).toContain('# keep me\r\n');
    expect(after).toContain('SECRET = "do-not-touch"');
    expect(after).toContain('# after\r\n');
    expect(after).toContain('<!-- northkeep-contract -->\r\n');
    expect(after).toContain('<!-- /northkeep-contract -->\r\n');
    expect(after).not.toContain('OLD CONTRACT');
    expect(after).toContain(CONTRACT_TEXT);
    expect(contractStatus('codex', { path: file }).status).toBe('installed');
  });

  it('refuses duplicated, unpaired, and reversed markers', () => {
    const file = codexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });

    fs.writeFileSync(
      file,
      '<!-- northkeep-contract -->\nA\n<!-- /northkeep-contract -->\n<!-- northkeep-contract -->\nB\n<!-- /northkeep-contract -->\n',
    );
    expect(() => installContract('codex', { path: file })).toThrow(/duplicated or unpaired/i);

    fs.writeFileSync(file, '<!-- northkeep-contract -->\nno end\n');
    expect(() => installContract('codex', { path: file })).toThrow(/duplicated or unpaired/i);

    fs.writeFileSync(file, '<!-- /northkeep-contract -->\n<!-- northkeep-contract -->\n');
    expect(() => installContract('codex', { path: file })).toThrow(/duplicated or unpaired/i);
  });

  it('backs up once and leaves the original backup on a second write', () => {
    const file = codexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = '# first\n';
    fs.writeFileSync(file, original);
    installContract('codex', { path: file });
    const bak = `${file}.northkeep-bak`;
    expect(fs.readFileSync(bak, 'utf8')).toBe(original);
    installContract('codex', { path: file });
    expect(fs.readFileSync(bak, 'utf8')).toBe(original);
  });

  it('writes through a symlink and leaves the symlink in place', () => {
    const sibling = path.join(dir, 'elsewhere');
    fs.mkdirSync(sibling, { recursive: true });
    const real = path.join(sibling, 'AGENTS.md');
    const link = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(real, '# linked\n');
    fs.chmodSync(real, 0o640);
    fs.symlinkSync(real, link);

    installContract('codex', { path: link });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toContain('# linked');
    expect(fs.readFileSync(real, 'utf8')).toContain(CONTRACT_TEXT);
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
  });

  it('creates a new file at 0600', () => {
    const file = codexFile();
    installContract('codex', { path: file });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('install all skips Codex when the home directory does not exist', () => {
    const missingHome = path.join(dir, 'no-codex');
    const results = installAll({
      claudePath: claudeFile(),
      codexHome: missingHome,
      codexPath: path.join(missingHome, 'AGENTS.md'),
    });
    expect(results[0]?.target).toBe('claude');
    expect(fs.existsSync(claudeFile())).toBe(true);
    expect(results[1]).toMatchObject({
      target: 'codex',
      skipped: true,
    });
    expect(results[1]?.skipReason).toMatch(/Codex not detected, skipped; run northkeep contract install codex to force/);
    expect(fs.existsSync(missingHome)).toBe(false);
  });

  it('explicit install creates the Codex directory even when it did not exist', () => {
    const home = path.join(dir, 'fresh-codex');
    const file = path.join(home, 'AGENTS.md');
    expect(fs.existsSync(home)).toBe(false);
    installContract('codex', { path: file, codexHome: home });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('override file yields blocked status after install', () => {
    const file = codexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(file), 'AGENTS.override.md'), '# override\n');
    const result = installContract('codex', { path: file });
    expect(fs.existsSync(file)).toBe(true);
    expect(result.warning).toMatch(/AGENTS\.override\.md/);
    expect(contractStatus('codex', { path: file }).status).toBe('blocked');
  });

  it('codexAgentsPath honors NORTHKEEP_CODEX_AGENTS', () => {
    const file = path.join(dir, 'custom-agents.md');
    process.env.NORTHKEEP_CODEX_AGENTS = file;
    expect(codexAgentsPath()).toBe(file);
  });

  it('uninstall removes only the marked block', () => {
    const file = codexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# keep\n');
    installContract('codex', { path: file });
    const result = uninstallContract('codex', { path: file });
    expect(result.action).toBe('block-removed');
    expect(fs.readFileSync(file, 'utf8')).toBe('# keep\n');
  });
});

describe('Cursor contract', () => {
  it('writes an mdc with alwaysApply: true', () => {
    const proj = projectDir();
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    const result = installContract('cursor-project', { projectDir: proj });
    const file = path.join(fs.realpathSync(proj), '.cursor', 'rules', 'northkeep.mdc');
    expect(result.path).toBe(file);
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toBe(renderContract('cursor-project'));
    expect(body.startsWith('---\nalwaysApply: true\n---\n')).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses the filesystem root, the home directory, and an ancestor of home', () => {
    expect(() => installContract('cursor-project', { projectDir: '/' })).toThrow(
      /filesystem root/i,
    );
    expect(() => installContract('cursor-project', { projectDir: os.homedir() })).toThrow(
      /home directory/i,
    );
    expect(() =>
      installContract('cursor-project', { projectDir: path.dirname(os.homedir()) }),
    ).toThrow(/ancestor of the home directory/i);
  });

  it('resolves a symlink and writes into the real project directory', () => {
    const real = path.join(dir, 'real-proj');
    const link = path.join(dir, 'link-proj');
    fs.mkdirSync(path.join(real, '.git'), { recursive: true });
    fs.symlinkSync(real, link);
    installContract('cursor-project', { projectDir: link });
    expect(fs.existsSync(path.join(real, '.cursor', 'rules', 'northkeep.mdc'))).toBe(true);
    expect(fs.existsSync(path.join(link, '.cursor', 'rules', 'northkeep.mdc'))).toBe(true);
  });

  it('warns when the project has no .git', () => {
    const proj = projectDir();
    fs.mkdirSync(proj, { recursive: true });
    const result = installContract('cursor-project', { projectDir: proj });
    expect(result.warning).toMatch(/No \.git directory/i);
    expect(fs.existsSync(path.join(proj, '.cursor', 'rules', 'northkeep.mdc'))).toBe(true);
  });

  it('uninstall moves aside an edited marked mdc', () => {
    const proj = projectDir();
    fs.mkdirSync(proj, { recursive: true });
    installContract('cursor-project', { projectDir: proj });
    const file = path.join(proj, '.cursor', 'rules', 'northkeep.mdc');
    fs.writeFileSync(file, `${renderContract('cursor-project')}\n# note\n`);
    const result = uninstallContract('cursor-project', { projectDir: proj });
    expect(result.action).toBe('moved-aside');
    expect(fs.existsSync(`${file}.northkeep-bak`)).toBe(true);
  });
});

describe('contract staleness after the ADR 0052 rewrite', () => {
  it('reads stale for a file holding the pre-0052 block and installed after a reinstall', () => {
    const file = claudeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The block as ADR 0042 shipped it: our marker, one paragraph, no
    // bootstrap recipe. Staleness is a byte comparison against renderContract.
    const oldBlock =
      `${OWNERSHIP_MARKER}\n` +
      'When I name a project, read it from NorthKeep with project_get at the start of the session. ' +
      'When a working session on that project ends, call project_update with the new Current Status, ' +
      'Next Actions, and a log entry describing what was done. ' +
      CONTRACT_GRACEFUL_DEGRADATION +
      '\n';
    fs.writeFileSync(file, oldBlock);
    expect(contractStatus('claude', { path: file }).status).toBe('stale');

    installContract('claude', { path: file });
    expect(contractStatus('claude', { path: file }).status).toBe('installed');
    expect(fs.readFileSync(file, 'utf8')).toContain(PROJECT_BOOTSTRAP_INSTRUCTION);
  });

  it('reads stale for a Codex block holding the old contract interior', () => {
    const file = codexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `# Notes\n\n<!-- northkeep-contract -->\nOld contract text.\n<!-- /northkeep-contract -->\n`,
    );
    expect(contractStatus('codex', { path: file }).status).toBe('stale');
    installContract('codex', { path: file });
    expect(contractStatus('codex', { path: file }).status).toBe('installed');
    expect(fs.readFileSync(file, 'utf8')).toContain('# Notes');
  });
});
