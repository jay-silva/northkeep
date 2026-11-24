import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONSENT_PAGE_HEADERS, LOOK_FIRST_SENTENCE, renderConsentPage } from '../src/consent.js';

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

  it('adds no script to the connect page, which still forbids them', () => {
    expect(page).not.toMatch(/<script/i);
    expect(CONSENT_PAGE_HEADERS['Content-Security-Policy']).toContain("default-src 'none'");
    expect(CONSENT_PAGE_HEADERS['Content-Security-Policy']).not.toContain('script-src');
  });

  it('is the same sentence in the Mac app, the known-limits file and the design record', () => {
    expect(read('../../web/static/index.html')).toContain(`id="lookFirstSentence"`);
    expect(read('../../web/static/index.html')).toContain(LOOK_FIRST_SENTENCE);
    expect(read('../../../KNOWN-LIMITS.md')).toContain(LOOK_FIRST_SENTENCE);
    expect(read('../../../docs/design/adr-0084-found-first.md')).toContain(LOOK_FIRST_SENTENCE);
  });
});
