import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, getProjectView } from '@northkeep/core';
import { milestoneLines, projectsMilestonesCmd, projectsPassCmd, type PassDeps } from '../src/milestonesCmd.js';

/** ADR 0065 K1: `northkeep projects milestones` and `northkeep projects pass`. Temp homes only. */

const CLI_DIST = path.resolve(__dirname, '..', 'dist', 'index.js');
const PASS = 'synthetic cli milestones passphrase';
const deviceSecret = generateDeviceSecret();
let home = '';
let vault: Vault;
let lines: string[] = [];

const vaultPath = () => path.join(home, 'vault.nkv');
const fail = (m: string): never => {
  throw new Error(`FAIL: ${m}`);
};
const withVault = async <T>(fn: (v: Vault) => T | Promise<T>): Promise<T> => fn(vault);
const out = (line: string) => lines.push(line);
const NOW = () => new Date('2026-10-14T09:30:00.000Z');

function seed(): string {
  const created = vault.updateProject({
    project: 'rental', expected_revision: null, what_why: 'Buy a rental.', status: 'Starting.', next_actions: '- [x] Call the lender',
    milestones: { kind: 'plan', items: [{ title: 'Buy box', test: 'Jay signs off the criteria' }, { title: 'Markets', test: 'three markets with comps' }] },
  }, { actor: 'agent' });
  vault.save();
  return created.revision;
}

function deps(answer: string, overrides: Partial<PassDeps> = {}): PassDeps {
  return { withVault, fail, isTTY: () => true, ask: async () => answer, now: NOW, out, ...overrides };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cli-0065-'));
  fs.writeFileSync(path.join(home, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
  vault = Vault.create({ path: vaultPath(), passphrase: PASS, deviceSecret, kdf: KDF_INTERACTIVE });
  lines = [];
});
afterEach(() => {
  try { vault.close(); } catch { /* closed by the test */ }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('northkeep projects milestones', () => {
  it('lists the plan with each test, marking the current milestone', async () => {
    seed();
    await projectsMilestonesCmd('rental', withVault, fail, out);
    expect(lines).toEqual([
      'Project rental: 0 of 2 milestones passed.',
      '  [ ] M1 Buy box  (current)',
      '      test: Jay signs off the criteria',
      '  [ ] M2 Markets',
      '      test: three markets with comps',
    ]);
  });

  it('says who passed each milestone and how to confirm an AI app report', () => {
    expect(milestoneLines('rental', { kind: 'plan', items: [
      { id: 'M1' as never, title: 'Buy box', test: 'agreed', state: 'passed', on: '2026-10-01', by: 'you' },
      { id: 'M2' as never, title: 'Markets', test: 'comps', state: 'passed', on: '2026-10-02', by: 'agent' },
    ] })).toEqual([
      'Project rental: 2 of 2 milestones passed.',
      '  [x] M1 Buy box  (passed 2026-10-01, confirmed by you)',
      '      test: agreed',
      '  [x] M2 Markets  (an AI app reported it passed on 2026-10-02; not confirmed by you)',
      '      test: comps',
      '      To confirm: northkeep projects pass rental M2',
    ]);
    expect(milestoneLines('rental', { kind: 'absent' })).toEqual(['Project rental has no milestones yet.']);
    expect(milestoneLines('rental', { kind: 'none', reason: 'a one-off errand' })).toEqual(['Project rental has no milestones: a one-off errand']);
  });

  it('changes nothing', async () => {
    const head = seed();
    await projectsMilestonesCmd('rental', withVault, fail, out);
    expect(getProjectView(vault, 'rental').revision).toBe(head);
  });
});

describe('northkeep projects pass', () => {
  it('confirms the current milestone after a typed yes, stamped (you) with the date', async () => {
    seed();
    const questions: string[] = [];
    await projectsPassCmd('rental', 'M1', deps('yes', { ask: async (q) => { questions.push(q); return 'yes'; } }));
    expect(questions).toEqual(['Type yes to confirm: ']);
    expect(lines.slice(0, 2)).toEqual(['Confirm that M1 Buy box in project rental passed its test:', '  Jay signs off the criteria']);
    expect(lines[2]).toMatch(/^✓ Confirmed M1 Buy box passed on 2026-10-14\. Project rental is now at revision [0-9a-f]{8}\.$/);
    const view = getProjectView(vault, 'rental');
    expect(view.content).toContain('- [x] M1 Buy box | test: Jay signs off the criteria | passed 2026-10-14 (you)');
    expect(view.content).toContain('- [ ] M2 Markets | test: three markets with comps');
  });

  it('refuses when stdin is not a terminal, before opening the vault', async () => {
    const head = seed();
    let opened = false;
    const guarded: PassDeps['withVault'] = async (fn) => { opened = true; return fn(vault); };
    await expect(projectsPassCmd('rental', 'M1', deps('yes', { isTTY: () => false, withVault: guarded })))
      .rejects.toThrow('FAIL: This command asks you to type yes, so it runs only in a terminal you are typing in. Nothing was changed.');
    expect(opened).toBe(false);
    expect(getProjectView(vault, 'rental').revision).toBe(head);
  });

  it('accepts only the word yes', async () => {
    const head = seed();
    for (const answer of ['y', 'YES', 'Yes', 'yes please', '']) {
      await expect(projectsPassCmd('rental', 'M1', deps(answer))).rejects.toThrow('FAIL: Not confirmed. Nothing was changed.');
    }
    expect(getProjectView(vault, 'rental').revision).toBe(head);
  });

  it('refuses a milestone that is not current, and one already confirmed', async () => {
    seed();
    await expect(projectsPassCmd('rental', 'M2', deps('yes'))).rejects.toThrow('FAIL: Only the current milestone, M1, can be confirmed now. Milestones pass in order. Nothing was changed.');
    await expect(projectsPassCmd('rental', 'M9', deps('yes'))).rejects.toThrow('FAIL: This project has no milestone M9. Nothing was changed.');
    await projectsPassCmd('rental', 'M1', deps('yes'));
    await expect(projectsPassCmd('rental', 'M1', deps('yes'))).rejects.toThrow('FAIL: M1 is already confirmed. Nothing was changed.');
  });

  it('confirms a milestone an AI app reported passed, restamping it (you)', async () => {
    const head = seed();
    vault.checkpointProject({
      vault_id: vault.getVaultId(), project: 'rental', mode: 'checkpoint', operation_id: '00650000-0000-4000-8000-0000000000c1',
      expected_revision: head, status: 'Buy box agreed.', completed: 'Agreed it.', next_actions: '', milestone_passed: 'M1',
    }, { actor: 'agent' });
    expect(getProjectView(vault, 'rental').content).toMatch(/- \[x\] M1 Buy box \| test: Jay signs off the criteria \| passed \d{4}-\d{2}-\d{2} \(agent\)/);
    await projectsPassCmd('rental', 'M1', deps('yes'));
    expect(getProjectView(vault, 'rental').content).toContain('- [x] M1 Buy box | test: Jay signs off the criteria | passed 2026-10-14 (you)');
  });

  it('refuses when the project changed while the question was open (stale page)', async () => {
    const head = seed();
    const ask = async (): Promise<string> => {
      vault.updateProject({ project: 'rental', expected_revision: head, status: 'Changed meanwhile.' }, { actor: 'owner' });
      return 'yes';
    };
    await expect(projectsPassCmd('rental', 'M1', deps('yes', { ask })))
      .rejects.toThrow('FAIL: Project rental changed while you were answering. Nothing was changed. Run the command again to see the current milestones.');
    expect(getProjectView(vault, 'rental').content).toContain('- [ ] M1 Buy box');
  });
});

describe('the built command', () => {
  it('refuses without a terminal; --yes and NORTHKEEP_ASSUME_YES do not bypass it', () => {
    seed();
    vault.close();
    const env = { PATH: '/usr/bin:/bin', HOME: home, NORTHKEEP_HOME: home, NORTHKEEP_NO_KEYCHAIN: '1', NORTHKEEP_PASSPHRASE: PASS, NORTHKEEP_ASSUME_YES: '1' };
    const plain = spawnSync(process.execPath, [CLI_DIST, 'projects', 'pass', 'rental', 'M1'], { env, input: 'yes\n', encoding: 'utf8' });
    expect(plain.status).toBe(1);
    expect(plain.stderr).toContain('This command asks you to type yes, so it runs only in a terminal you are typing in. Nothing was changed.');
    const flagged = spawnSync(process.execPath, [CLI_DIST, 'projects', 'pass', 'rental', 'M1', '--yes'], { env, input: 'yes\n', encoding: 'utf8' });
    expect(flagged.status).toBe(1);
    expect(flagged.stderr).toContain("unknown option '--yes'");
    const reopened = Vault.open({ path: vaultPath(), passphrase: PASS, deviceSecret });
    expect(getProjectView(reopened, 'rental').content).toContain('- [ ] M1 Buy box');
    reopened.close();
  });
});
