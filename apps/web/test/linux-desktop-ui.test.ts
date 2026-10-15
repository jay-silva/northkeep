import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hostCopy } from '../src/host-copy.js';

const html = fs.readFileSync(fileURLToPath(new URL('../static/index.html', import.meta.url)), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function functionSource(name: string) {
  const functionStart = script.indexOf(`function ${name}(`);
  const start = script.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  if (functionStart < 0) throw new Error(`Missing function ${name}`);
  const brace = script.indexOf('{', functionStart);
  let depth = 0;
  for (let index = brace; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    if (script[index] === '}' && --depth === 0) return script.slice(start, index + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

describe('platform wording on the desktop page', () => {
  it('names Linux, macOS, and Windows without borrowing brew or the Keychain', () => {
    expect(hostCopy('linux')).toMatchObject({
      device: 'this Linux computer',
      ollamaStart: 'systemctl start ollama',
      ollamaAlt: 'ollama serve',
      ollamaInstall: null,
      ollamaLabel: 'This Linux computer: Ollama',
      providerKeyNote: 'API keys are not saved on this computer. NorthKeep does not write them to files.',
    });
    expect(hostCopy('darwin')).toMatchObject({
      ollamaStart: 'brew services start ollama',
      ollamaInstall: 'brew install ollama',
      ollamaLabel: 'This Mac: Ollama',
    });
    expect(hostCopy('win32').ollamaStart).toBe('ollama serve');
    expect(hostCopy('win32').ollamaLabel).toBe('This Windows PC: Ollama');
  });

  it('does not leave Mac or Homebrew instructions in the page the user reads', () => {
    const styleEnd = html.indexOf('</style>');
    const body = html.slice(styleEnd, html.indexOf('<script>'));
    expect(body).not.toMatch(/this\s+Mac|your\s+Mac|This\s+Mac|brew services|brew install|macOS Keychain|The Mac app/);
    expect(body).toContain('id="ollamaFix">ollama serve');
    expect(body).toContain('id="ollamaFixAlt"');
    expect(body).toContain('Use one on <span data-place>this computer</span>, or connect Claude');
    expect(body).toContain('encrypted vault on <span data-place>this computer</span>, and you choose which apps can read it.');
    expect(body).toContain('placeholder="Label (e.g. This computer: Ollama)"');
    const code = stripComments(script);
    expect(code).not.toMatch(/this Mac|your Mac|This Mac|brew services|brew install ollama/);
    expect(code).toContain('status.ollama_start');
    expect(code).toContain('status.ollama_label');
    expect(code).toContain('status.provider_key_note');
  });
});

describe('typed input on the desktop page', () => {
  it('does not autofocus the hidden passphrase or steal focus inside an open dialog', () => {
    expect(html).not.toMatch(/id="passphrase"[^>]*autofocus/);
    expect(functionSource('showUnlock')).toContain("if (!$('setupOverlay').hidden) return");
    expect(functionSource('showUnlock')).toContain('focusDialogField');
    expect(functionSource('showSetup')).toContain('focusDialogField');
    const focused: string[] = [];
    const setup = { hidden: false, contains: (node: unknown) => node === confirmField };
    const unlock = { hidden: true, contains: () => false };
    const first = { focus() { focused.push('first'); } };
    const confirmField = { focus() { focused.push('confirm'); } };
    const context = vm.createContext({
      document: { activeElement: confirmField, body: {} },
      $: (id: string) => (id === 'setupOverlay' ? setup : id === 'unlockOverlay' ? unlock : id === 'setupPass' ? first : id === 'passphrase' ? first : null),
      clearCurationSensitive() {},
      clearMemorySensitive() {},
      clearDetailedReviewSensitive() {},
      clearProjectsSensitive() {},
      hideUnlock() { unlock.hidden = true; },
    });
    vm.runInContext(`${functionSource('focusDialogField')}\n${functionSource('showUnlock')}\n${functionSource('showSetup')}`, context);
    vm.runInContext('showSetup()', context);
    expect(focused).toEqual([]);
    setup.hidden = true;
    unlock.hidden = false;
    context.document.activeElement = context.document.body;
    vm.runInContext('showUnlock()', context);
    expect(focused).toEqual(['first']);
  });

  it('puts a clobbered memory field back, including the caret', () => {
    const field = {
      value: 'Mara Quill set the masthead',
      selectionStart: 4,
      selectionEnd: 4,
      setSelectionRange(start: number, end: number) {
        this.selectionStart = start;
        this.selectionEnd = end;
      },
    };
    const context = vm.createContext({ field });
    vm.runInContext(`${functionSource('keepTypedValue')}\nkeepTypedValue(field, () => { field.value = 'M'; })`, context);
    expect(field.value).toBe('Mara Quill set the masthead');
    expect(field.selectionStart).toBe(4);
    expect(functionSource('loadMemories')).toContain("keepTypedValue($('addMemContent')");
    expect(functionSource('loadMemories')).toContain("keepTypedValue($('q')");
    expect(functionSource('renderProjectChoices')).toContain("keepTypedValue($('projectSearch')");
    expect(script).toContain('requestAnimationFrame(() => renderProjectChoices())');
  });
});

describe('key file badge', () => {
  it('is informational when the private file is the store, and red only when nothing can store the key', () => {
    expect(html).toContain('<span id="keyFilePill" class="pill info" hidden>Key file</span>');
    expect(html).toContain('.pill.info { background: var(--chip); color: var(--ink); }');
    const store = functionSource('applyKeyStore');
    expect(store).toContain("pill.className = 'pill info'");
    expect(store).toContain("pill.textContent = 'Key file'");
    expect(store).toContain('store.warning');
    expect(store).toContain("pill.className = 'pill locked'");
    expect(store).toContain("pill.textContent = 'No key store'");
    const elements = new Map<string, Record<string, unknown>>();
    const context = vm.createContext({
      $: (id: string) => {
        if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', title: '', className: '' });
        return elements.get(id);
      },
    });
    vm.runInContext(store, context);
    vm.runInContext("applyKeyStore({ backend: 'file', warning: 'kept in a private file' }, false)", context);
    expect(elements.get('keyFilePill')).toMatchObject({
      hidden: false,
      className: 'pill info',
      textContent: 'Key file',
      title: 'kept in a private file',
    });
    vm.runInContext("applyKeyStore({ backend: 'none' }, false)", context);
    expect(elements.get('keyFilePill')).toMatchObject({ hidden: false, className: 'pill locked', textContent: 'No key store' });
    vm.runInContext("applyKeyStore({ backend: 'secret-service' }, false)", context);
    expect(elements.get('keyFilePill')?.hidden).toBe(true);
  });
});
