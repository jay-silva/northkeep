import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function functionSource(name: string) {
  const start = script.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const brace = script.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

function page() {
  const els: Record<string, Record<string, unknown>> = {};
  const hourButtons = [1, 2, 4, 8].map((h) => {
    const attrs: Record<string, string> = {};
    return { dataset: { hours: String(h) }, disabled: false, attrs, setAttribute: (k: string, v: string) => (attrs[k] = v) };
  });
  const $ = (id: string) => (els[id] ??= { hidden: false, checked: false, disabled: false, textContent: '', innerHTML: '' });
  const context = {
    $,
    esc: (s: unknown) => String(s),
    Date,
    kwHours: 2,
    document: { querySelectorAll: () => hourButtons },
  };
  vm.runInNewContext(`${functionSource('kwLeft')}\n${functionSource('renderKeepWatch')}\nthis.render = renderKeepWatch;`, context);
  return { render: (context as unknown as { render: (k: unknown) => void }).render, $, hourButtons };
}

const base = {
  supported: true,
  hours: 2,
  allow_battery: false,
  helper: 'installed',
  power: { source: 'ac', percent: 100, charging: true, hasBattery: true },
  thermal: 0,
  last_off_reason: null,
  problem: null,
};

describe('Keep Watch page', () => {
  it('hides its Settings entry until the Mac app says it can run', () => {
    expect(html).toContain('<button data-sub="keepwatch" id="keepWatchNav" hidden>Keep Watch</button>');
    expect(script).toContain("$('keepWatchNav').hidden = !(status.desktop && status.platform === 'darwin');");
  });

  it('shows time left, power and the on buttons while on, and locks the settings', () => {
    const p = page();
    const ends = new Date(Date.now() + 102 * 60_000 + 20_000).toISOString();
    p.render({ ...base, state: 'on', ends_at: ends, ceiling_at: new Date(Date.now() + 12 * 3_600_000).toISOString() });
    expect(p.$('kwSwitch').checked).toBe(true);
    expect(p.$('kwPills').innerHTML).toContain('1 h 42 m left');
    expect(p.$('kwPills').innerHTML).toContain('Plugged in · 100%');
    expect(p.$('kwOnButtons').hidden).toBe(false);
    expect(p.hourButtons.every((b) => b.disabled)).toBe(true);
    expect(p.$('kwHelperRow').hidden).toBe(true);
  });

  it('says why it turned off and offers removal when off', () => {
    const p = page();
    p.render({ ...base, state: 'off', ends_at: null, ceiling_at: null, last_off_reason: 'The charger was unplugged.' });
    expect(p.$('kwSwitch').checked).toBe(false);
    expect(p.$('kwHint').textContent).toBe('Off. The charger was unplugged. macOS asks for your login password each time you turn this on.');
    expect(p.$('kwHelperRow').hidden).toBe(false);
    expect(p.hourButtons[1]!.attrs['aria-pressed']).toBe('true');
  });

  it('offers Update and Remove for an outdated helper, only while off', () => {
    const p = page();
    p.render({ ...base, helper: 'outdated', state: 'off', ends_at: null, ceiling_at: null });
    expect(p.$('kwUpdateRow').hidden).toBe(false);
    expect(p.$('kwHelperRow').hidden).toBe(false);
    p.render({ ...base, helper: 'outdated', state: 'on', ends_at: new Date().toISOString(), ceiling_at: new Date().toISOString() });
    expect(p.$('kwUpdateRow').hidden).toBe(true);
    p.render({ ...base, state: 'off', ends_at: null, ceiling_at: null });
    expect(p.$('kwUpdateRow').hidden).toBe(true);
  });

  it('shows the problem banner with Turn off now', () => {
    const p = page();
    p.render({ ...base, state: 'on', ends_at: new Date().toISOString(), ceiling_at: new Date().toISOString(), problem: 'Keep Watch can’t turn itself off.' });
    expect(p.$('kwProblem').hidden).toBe(false);
    expect(p.$('kwProblemText').textContent).toBe('Keep Watch can’t turn itself off.');
  });
});
