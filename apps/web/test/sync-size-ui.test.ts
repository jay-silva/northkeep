import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { vaultSizeReport } from '@northkeep/sync';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

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

interface FakeEl {
  textContent: string;
  hidden: boolean;
  style: Record<string, string>;
  attrs: Record<string, string>;
  classes: Set<string>;
  classList: { toggle(c: string, on: boolean): void };
  setAttribute(k: string, v: string): void;
}

function fakeEl(): FakeEl {
  const e: FakeEl = {
    textContent: '', hidden: false, style: {}, attrs: {}, classes: new Set(),
    classList: { toggle: (c, on) => (on ? e.classes.add(c) : e.classes.delete(c)) },
    setAttribute: (k, v) => { e.attrs[k] = v; },
  };
  return e;
}

function render(bytes: number | null): Record<string, FakeEl> {
  const els: Record<string, FakeEl> = {};
  const ctx = vm.createContext({
    $: (id: string) => (els[id] ??= fakeEl()),
    devicePlace: () => 'this Mac',
    size: bytes === null ? null : vaultSizeReport(bytes),
  });
  vm.runInContext(functionSource('sizeText') + functionSource('renderSyncSize'), ctx);
  vm.runInContext('renderSyncSize(size)', ctx);
  return els;
}

const MB = 1024 * 1024;

describe('Sync page vault size card (ADR 0067 D4)', () => {
  it('stays hidden when there is no size to show', () => {
    expect(render(null).syncSizeCard.hidden).toBe(true);
  });

  it('is quiet under 75%', () => {
    const els = render(1.1 * MB);
    expect(els.syncSizeCard.hidden).toBe(false);
    expect(els.syncSizeNum.textContent).toBe('1.1 MB');
    expect(els.syncSizeOk.textContent).toBe('Plenty of room. Your vault syncs normally.');
    expect(els.syncSizeWarn.hidden).toBe(true);
    expect(els.syncSizeMeter.classes.has('warn')).toBe(false);
  });

  it('warns at exactly 3 MB with what happens and what to do', () => {
    const els = render(3 * MB);
    expect(els.syncSizeWarn.hidden).toBe(false);
    expect(els.syncSizeOk.hidden).toBe(true);
    expect(els.syncSizeWarnHead.textContent).toBe('Getting close to the limit');
    expect(els.syncSizeWarnLine.textContent).toContain('Your vault is 3 MB of 4 MB. Sync still works.');
    expect(els.syncSizeWarnLine.textContent).toContain('new changes stay on this Mac');
    expect(els.syncSizeMeter.classes.has('warn')).toBe(true);
    expect(els.syncSizeMeter.attrs['aria-valuenow']).toBe('75');
  });

  it('says plainly when the vault is over the limit, with the bar capped at full', () => {
    const els = render(4.5 * MB);
    expect(els.syncSizeWarnHead.textContent).toBe('Over the sync limit');
    expect(els.syncSizeWarnLine.textContent).toContain('do not reach your other devices until it is smaller. Nothing is lost.');
    expect(els.syncSizeMeter.classes.has('over')).toBe(true);
    expect(els.syncSizeBar.style.width).toBe('100%');
  });

  it('places the card above Status on the Sync page', () => {
    const view = html.slice(html.indexOf('<section id="view-sync"'), html.indexOf('<section id="view-connect"'));
    expect(view.indexOf('id="syncSizeCard"')).toBeGreaterThan(-1);
    expect(view.indexOf('id="syncSizeCard"')).toBeLessThan(view.indexOf('<h3 class="sect">Status</h3>'));
  });
});
