import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(fileURLToPath(new URL('../static/index.html', import.meta.url)), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
const dialog = html.slice(html.indexOf('<div class="overlay" id="setupOverlay"'), html.indexOf('<!-- Connect-a-model wizard'));
const setupJs = script.slice(script.indexOf('// --- first-run setup:'), script.indexOf("$('unlockBtn').addEventListener"));

describe('first-run setup order', () => {
  it('runs welcome, passphrase, connect, try, backup, then the optional extras', () => {
    const order = ['setupStepWelcome', 'setupStepCreate', 'setupStepConnect', 'setupStepTry', 'setupStepBackup', 'setupStepExtras'];
    const at = order.map((id) => dialog.indexOf(`id="${id}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(setupJs).toContain("const SETUP_PROGRESS = { setupStepWelcome: 1, setupStepCreate: 2, setupStepConnect: 3, setupStepTry: 4, setupStepBackup: 5, setupStepExtras: 6 }");
    expect(dialog).not.toContain('Add your first AI');
  });

  it('skipping the connect step goes straight to backup', () => {
    expect(setupJs).toContain("$('setupNoApp').addEventListener('click', () => setupStep('setupStepNoApp'))");
    expect(setupJs).toContain("$('setupNoAppNext').addEventListener('click', () => showSetupBackup())");
  });

  it('the demo is a static preview that calls no API', () => {
    const demo = dialog.slice(dialog.indexOf('id="setupStepDemo"'), dialog.indexOf('id="setupStepCreate"'));
    expect(demo).toContain('DEMO');
    for (const line of setupJs.split('\n').filter((l) => /setupDemo(Btn|Start|Leave)/.test(l))) {
      expect(line).not.toContain('api(');
    }
  });
});

describe('first-run backup stays mandatory', () => {
  it('keeps the no-recovery warning and needs the checkbox before the button works', () => {
    const backup = dialog.slice(dialog.indexOf('id="setupStepBackup"'), dialog.indexOf('id="setupStepExtras"'));
    expect(backup).toContain('Lose either one and the vault is unrecoverable, by design.');
    expect(backup).toContain('I saved a copy somewhere other than this computer.');
    expect(backup).toMatch(/id="setupBackupBtn" disabled/);
    expect(backup).not.toMatch(/<button[^>]*>[^<]*skip/i);
    expect(setupJs).toContain("api('/api/setup/backup-confirmed', { method: 'POST', json: { confirmed: true } })");
  });

  it('reopens on the backup step after unlock until the server records the backup', () => {
    expect(script).toContain("else if (status.backup_confirmed === false) { if ($('setupOverlay').hidden) { showSetup('setupStepBackup'); showSetupBackup(); } }");
  });
});

describe('first-run dialog rules', () => {
  it('renders dynamic text without innerHTML', () => {
    expect(setupJs).not.toContain('innerHTML');
  });

  it('has no em dashes in what the person reads', () => {
    expect(dialog.replace(/<!--[\s\S]*?-->/g, '')).not.toContain('—');
  });

  it('traps focus inside the dialog', () => {
    expect(dialog).toContain('aria-modal="true"');
    expect(setupJs).toContain("$('setupOverlay').addEventListener('keydown'");
    expect(setupJs).toContain("if (e.key !== 'Tab') return;");
  });
});
