import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret } from '@northkeep/core';
import { projectsCompactCmd } from '../src/projectsCmd.js';
import type { WithVault } from '../src/shareCmd.js';

/** ADR 0051 Decision 2 on the CLI: a preview by default, a write only with --yes. */

const PASS = 'synthetic cli compaction passphrase';
const deviceSecret = generateDeviceSecret();
let directory = '';
let vaultPath = '';
let lines: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

function openVault(): Vault {
  return Vault.open({ path: vaultPath, passphrase: PASS, deviceSecret, kdf: KDF_INTERACTIVE });
}

/** Mirrors index.ts's withVault minus the lock and the push: open, run, close. */
const withVault: WithVault = async (fn) => {
  const vault = openVault();
  try {
    return await fn(vault);
  } finally {
    vault.close();
  }
};

function fail(message: string): never {
  throw new Error(message);
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cli-compact-'));
  vaultPath = path.join(directory, 'vault.nkv');
  const vault = Vault.create({ path: vaultPath, passphrase: PASS, deviceSecret, kdf: KDF_INTERACTIVE });
  let revision = vault.updateProject({ project: 'demo', expected_revision: null, what_why: 'Why.', status: 'Start.', next_actions: 'Go' }).revision;
  for (let i = 0; i < 9; i += 1) revision = vault.updateProject({ project: 'demo', expected_revision: revision, status: `Step ${i}.` }).revision;
  vault.save();
  vault.close();
  lines = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('northkeep projects compact', () => {
  it('previews the per-project table without saving', async () => {
    const before = fs.readFileSync(vaultPath);
    // Automatic compaction (ADR 0051 Decision 4) already holds the project at
    // five revisions, so a smaller keep is what gives the command work to show.
    await projectsCompactCmd({ keep: '2' }, withVault, fail);
    const output = lines.join('\n');
    expect(output).toContain('Project');
    expect(output).toMatch(/demo\s+5\s+2\s+3\s/);
    expect(output).toContain('Dry run: nothing changed. Add --yes to compact.');
    expect(fs.readFileSync(vaultPath).equals(before)).toBe(true);
    const vault = openVault();
    expect(vault.list({ scope: 'project:demo', includeSuperseded: true }).filter((e) => e.superseded_at)).toHaveLength(5);
    vault.close();
  });

  it('compacts and saves with --yes, and reports the file size after', async () => {
    const before = fs.readFileSync(vaultPath);
    await projectsCompactCmd({ yes: true, keep: '2' }, withVault, fail);
    const output = lines.join('\n');
    expect(output).toContain('✓ Blanked 3 old project revisions');
    expect(output).toMatch(/Vault file is now [\d.]+ MB\./);
    expect(fs.readFileSync(vaultPath).equals(before)).toBe(false);
    const vault = openVault();
    expect(vault.list({ scope: 'project:demo', includeSuperseded: true }).filter((e) => e.superseded_at)).toHaveLength(2);
    expect(vault.verifyChain().ok).toBe(true);
    vault.close();
  });

  it('rejects a keep outside the allowed range before opening the vault', async () => {
    await expect(projectsCompactCmd({ keep: '0', yes: true }, withVault, fail)).rejects.toThrow('Keep must be a whole number');
    await expect(projectsCompactCmd({ keep: 'five' }, withVault, fail)).rejects.toThrow('Keep must be a whole number');
    const vault = openVault();
    expect(vault.list({ scope: 'project:demo', includeSuperseded: true }).filter((e) => e.superseded_at)).toHaveLength(5);
    vault.close();
  });
});
