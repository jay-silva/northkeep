import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CONSENT_COPY_SCRIPT, CONSENT_PAGE_HEADERS, LOOK_FIRST_SENTENCE, renderConsentPage } from '../src/consent.js';

// ADR 0084 D2: the sentence a person pastes into an app that ignores NorthKeep's connect-time instruction.

const page = renderConsentPage({ clientId: 'client-1', clientName: 'Grok Bot', redirectUri: 'https://example.com/cb', codeChallenge: 'c', state: 's', scope: 'memory', resource: undefined } as never);
const read = (rel: string): string => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('ADR 0084 D2: the look-first sentence', () => {
  it('is on the connect page, above the Allow button, with where to paste it', () => {
    expect(page).toContain(LOOK_FIRST_SENTENCE);
    expect(page.indexOf(LOOK_FIRST_SENTENCE)).toBeLessThan(page.indexOf('Allow access'));
    expect(page).toContain('Grok Bot, Muse:');
    expect(page).toContain('user-select:all');
  });

  it('runs exactly one script, pinned by its hash, and nothing else may run (ADR 0091)', () => {
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toEqual([CONSENT_COPY_SCRIPT]);
    expect(page.match(/<script/gi)).toHaveLength(1);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    const hash = createHash('sha256').update(CONSENT_COPY_SCRIPT, 'utf8').digest('base64');
    // Pinned on purpose: a change to the script must fail here until a person reads the new script and updates this line.
    expect(hash).toBe('ES6tOhv5ieMMx8bHSGJX6oOAcoqCyxQ4gieehHMDR1Q=');
    const csp = CONSENT_PAGE_HEADERS['Content-Security-Policy'];
    expect(csp).toBe(`default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; frame-ancestors 'none'; base-uri 'none'`);
    expect(csp).not.toMatch(/unsafe-eval|unsafe-hashes|script-src[^;]*unsafe-inline|script-src[^;]*https?:/);
  });

  it('the script reads no form field and makes no request', () => {
    expect(CONSENT_COPY_SCRIPT).not.toMatch(/pairing|fetch|XMLHttpRequest|sendBeacon|WebSocket|location|cookie|innerHTML|eval|import|src\s*=|\.value|forms|action|submit|open\(|querySelector|elements|\[/);
    expect(CONSENT_COPY_SCRIPT).not.toContain('</');
  });

  it('a script smuggled in through the app name is shown as text, not run', () => {
    const hostile = renderConsentPage({ clientId: 'c', clientName: '<script>alert(1)</script>', redirectUri: 'https://example.com/cb', codeChallenge: 'c', state: 's', scope: 'memory' } as never);
    expect([...hostile.matchAll(/<script>/g)]).toHaveLength(1);
    expect(hostile).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('no field can carry markup: a hostile value everywhere leaves one script and one sentence', () => {
    const evil = `"><script>alert(1)</script><p id="nk-sentence">x</p><img src=x onerror=alert(1)>'`;
    const hostile = renderConsentPage(
      { clientId: evil, clientName: evil, redirectUri: `https://example.com/cb?x=${evil}`, codeChallenge: evil, state: evil, scope: evil, resource: evil } as never,
      { error: evil },
    );
    expect(hostile.match(/<script/gi)).toHaveLength(1);
    expect(hostile.match(/id="nk-sentence"/g)).toHaveLength(1);
    expect(hostile).not.toMatch(/<img/i);
    expect(hostile.match(/<p /g)).toEqual(page.match(/<p /g)!.concat(['<p ']));
  });

  it('the copy button stays hidden until the script runs, and the sentence still selects on a tap', () => {
    expect(page).toMatch(/<button type="button" id="nk-copy" hidden/);
    expect(page).toContain('user-select:all');
  });

  it('is the same sentence in the Mac app, the known-limits file and the design record', () => {
    expect(read('../../web/static/index.html')).toContain(`id="lookFirstSentence"`);
    expect(read('../../web/static/index.html')).toContain(LOOK_FIRST_SENTENCE);
    expect(read('../../../KNOWN-LIMITS.md')).toContain(LOOK_FIRST_SENTENCE);
    expect(read('../../../docs/design/adr-0084-found-first.md')).toContain(LOOK_FIRST_SENTENCE);
  });
});
