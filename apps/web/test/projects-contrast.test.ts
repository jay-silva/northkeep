import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0053 F7: the Projects mirror line is 12px muted text, so it needs
 * WCAG AA 4.5:1 in both themes. Colors are read from the page's own CSS.
 */
const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'index.html'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

function token(block: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!m) throw new Error(`missing --${name}`);
  return m[1] as string;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The light theme's --muted as #view-projects sees it: its own light-only override, else :root. */
function projectsLightMuted(): string {
  const re = /@media not \(prefers-color-scheme: dark\)\s*\{([\s\S]*?)\n {2}\}/g;
  for (const m of css.matchAll(re)) {
    const rule = /(^|[\s,])#view-projects[^{]*\{([^}]*)\}/m.exec(m[1] as string);
    if (rule && /--muted:/.test(rule[2] as string)) return token(rule[2] as string, 'muted');
  }
  return token(rootLight(), 'muted');
}

function rootLight(): string {
  return /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
}

function rootDark(): string {
  return /prefers-color-scheme: dark\)\s*\{\s*:root[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
}

describe('Projects mirror line contrast (F7)', () => {
  it('meets 4.5:1 against the page and panel backgrounds in the light theme', () => {
    const muted = projectsLightMuted();
    const root = rootLight();
    expect(contrast(muted, token(root, 'bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted, token(root, 'panel'))).toBeGreaterThanOrEqual(4.5);
  });

  it('meets 4.5:1 in the dark theme', () => {
    const dark = rootDark();
    expect(contrast(token(dark, 'muted'), token(dark, 'bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(dark, 'muted'), token(dark, 'panel'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the mirror line on the muted color', () => {
    expect(html).toContain('class="muted projects-mirror"');
    expect(css).toMatch(/\.muted\s*\{\s*color:\s*var\(--muted\)/);
  });
});
