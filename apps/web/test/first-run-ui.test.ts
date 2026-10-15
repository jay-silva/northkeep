import fs from 'node:fs';
import vm from 'node:vm';
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

describe('first-run projects card', () => {
  function functionSource(name: string): string {
    const start = script.indexOf(`function ${name}(`);
    const brace = script.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < script.length; i += 1) {
      if (script[i] === '{') depth += 1;
      if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
    }
    throw new Error(`Missing function ${name}`);
  }
  function render(apps: Array<{ id: string; label: string }>): Record<string, { textContent: string; hidden: boolean }> {
    const els: Record<string, { textContent: string; hidden: boolean }> = {};
    const ctx = vm.createContext({ $: (id: string) => (els[id] ??= { textContent: '', hidden: false }), setupApps: apps });
    vm.runInContext(functionSource('renderSetupProjects') + '; renderSetupProjects();', ctx);
    return els;
  }

  it('sits on the last step, above the optional extras', () => {
    const extras = dialog.slice(dialog.indexOf('id="setupStepExtras"'));
    expect(extras.indexOf('class="setup-proj"')).toBeGreaterThan(-1);
    expect(extras.indexOf('class="setup-proj"')).toBeLessThan(extras.indexOf('id="setupModelBtn"'));
    expect(extras).toContain('Only you can mark one passed.');
  });

  it('names the one connected app in the starter line', () => {
    const els = render([{ id: 'claude-desktop', label: 'Claude Desktop' }]);
    expect(els.setupProjTry.hidden).toBe(false);
    expect(els.setupProjTryLine.textContent).toBe('Want to try one? Send this to Claude Desktop:');
    expect(els.setupProjLead.textContent).toContain('the next app you open picks up from the latest save');
  });

  it('says "one of your connected apps" when there are several', () => {
    const els = render([{ id: 'a', label: 'Cursor' }, { id: 'b', label: 'Claude Code' }]);
    expect(els.setupProjTryLine.textContent).toBe('Want to try one? Send this to one of your connected apps:');
  });

  it('drops the starter message when no app is connected', () => {
    const els = render([]);
    expect(els.setupProjTry.hidden).toBe(true);
    expect(els.setupProjLead.textContent).toContain('Once you connect an AI app, ask it to start a project');
  });
});

describe('backup step wording matches what the gate enforces (ADR 0070)', () => {
  it('does not claim sync stays off', () => {
    expect(dialog).not.toContain('sync stays off');
    expect(dialog).toContain('the app will not set up sync');
  });
});
