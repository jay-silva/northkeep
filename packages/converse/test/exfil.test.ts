import { describe, expect, it } from 'vitest';
import {
  describeFlag,
  screenArguments,
  type ExfilFlag,
  type ExfilScreenInput,
} from '../src/index.js';

/**
 * M10c — exfiltration screens over restored plaintext tool arguments
 * (ADR 0029; threat stated in KNOWN-LIMITS.md §M10b). These tests pin the
 * decode/normalize behavior the Tier-1 literal floor lacks (percent, base64,
 * '+'-as-space, split digits), the host carve-out for identity/memory, the
 * fail-closed parsing paths, and — honestly — the decode-depth boundary
 * where evasion starts to win.
 */

const SSN = '123-45-6789';

function screen(partial: Partial<ExfilScreenInput>): ExfilFlag[] {
  return screenArguments({
    argsPlain: '{}',
    egressUrl: null,
    protectedValues: [],
    usedMemoryContents: [],
    ...partial,
  });
}

function urlInput(url: string, extra: Partial<ExfilScreenInput> = {}): ExfilScreenInput {
  return {
    argsPlain: JSON.stringify({ url }),
    egressUrl: url,
    protectedValues: [],
    usedMemoryContents: [],
    ...extra,
  };
}

describe('screenArguments — secret class', () => {
  it('flags a plain SSN in the query string, decoded:false', () => {
    const flags = screenArguments(urlInput(`https://api.example.com/lookup?ssn=${SSN}`));
    expect(flags).toEqual([{ class: 'secret', kind: 'ssn', where: 'query', decoded: false }]);
  });

  it('flags an SSN in the fragment and in a path segment', () => {
    const flags = screenArguments(urlInput(`https://example.com/${SSN}/x#${SSN}`));
    expect(flags).toContainEqual({ class: 'secret', kind: 'ssn', where: 'path', decoded: false });
    expect(flags).toContainEqual({ class: 'secret', kind: 'ssn', where: 'fragment', decoded: false });
  });

  it('catches a single-percent-encoded SSN, marked hidden', () => {
    const flags = screenArguments(urlInput('https://evil.example/?q=123%2D45%2D6789'));
    expect(flags).toEqual([{ class: 'secret', kind: 'ssn', where: 'query', decoded: true }]);
  });

  it('catches double- and triple-percent-encoded SSNs', () => {
    const twice = screenArguments(urlInput('https://evil.example/?q=123%252D45%252D6789'));
    expect(twice).toEqual([{ class: 'secret', kind: 'ssn', where: 'query', decoded: true }]);
    const thrice = screenArguments(urlInput('https://evil.example/?q=123%25252D45%25252D6789'));
    expect(thrice).toEqual([{ class: 'secret', kind: 'ssn', where: 'query', decoded: true }]);
  });

  it('HONEST LIMIT: a quadruple-percent-encoded SSN slips past (3 decode rounds)', () => {
    // Documented boundary, not a bug hidden in a green suite: after three
    // rounds '%2525252D' is still '%2D' and no detector matches. The gate
    // showing the verbatim URL is the backstop (KNOWN-LIMITS/ADR 0029).
    const flags = screenArguments(urlInput('https://evil.example/?q=123%2525252D45%2525252D6789'));
    expect(flags).toEqual([]);
  });

  it('catches a base64-hidden SSN in a query value, marked hidden', () => {
    const encoded = Buffer.from(`ssn is ${SSN}`).toString('base64');
    const flags = screenArguments(urlInput(`https://evil.example/?d=${encoded}`));
    expect(flags).toContainEqual({ class: 'secret', kind: 'ssn', where: 'query', decoded: true });
  });

  it('catches a base64url-hidden SSN (the url alphabet, no padding)', () => {
    const payload = `ssn ${SSN} >>>`; // '>>>' forces 62/63 sextets: '-' in base64url
    const encoded = Buffer.from(payload).toString('base64url');
    expect(encoded).toMatch(/-/);
    expect(encoded).not.toMatch(/[+/=]/);
    const flags = screenArguments(urlInput(`https://evil.example/?d=${encoded}`));
    expect(flags).toContainEqual({ class: 'secret', kind: 'ssn', where: 'query', decoded: true });
  });

  it('does NOT flag base64 that decodes to binary junk', () => {
    // 0x90 repeated: charset-valid base64 in, 0% printable out — the 85%
    // printable gate refuses to treat real binary as smuggled text.
    const junk = Buffer.from(new Uint8Array(30).fill(0x90)).toString('base64');
    const flags = screenArguments(urlInput(`https://example.com/?blob=${junk}`));
    expect(flags).toEqual([]);
  });

  it("treats '+' as space in query components (form encoding), decoded:false", () => {
    const flags = screenArguments(urlInput('https://evil.example/?q=123+45+6789'));
    expect(flags).toContainEqual({ class: 'secret', kind: 'ssn', where: 'query', decoded: false });
  });

  it('catches an SSN split by multi-character dash/space runs (body leaf)', () => {
    const flags = screen({ argsPlain: JSON.stringify({ note: 'patient 123 - 45 - 6789' }) });
    expect(flags).toContainEqual({ class: 'secret', kind: 'ssn', where: 'body', decoded: false });
  });

  it('catches a card number split by spaced dashes (Luhn still validates)', () => {
    const flags = screen({ argsPlain: JSON.stringify({ note: 'card 4111 - 1111 - 1111 - 1111' }) });
    expect(flags).toContainEqual({
      class: 'secret',
      kind: 'credit_card',
      where: 'body',
      decoded: false,
    });
  });

  it('screens the HOST for secrets (SSN spelled as a subdomain)', () => {
    const flags = screenArguments(urlInput(`https://${SSN}.evil.example/x`));
    expect(flags).toContainEqual({ class: 'secret', kind: 'ssn', where: 'host', decoded: false });
  });

  it('does not flag an IP-literal host as a leaked IP (it is the destination)', () => {
    const flags = screenArguments(urlInput('https://93.184.216.34/page'));
    expect(flags).toEqual([]);
  });

  it('still flags an IP smuggled in the query', () => {
    const flags = screenArguments(urlInput('https://example.com/?target=10.0.0.5'));
    expect(flags).toContainEqual({ class: 'secret', kind: 'ip', where: 'query', decoded: false });
  });

  it('catches a percent-hidden API key in a body leaf', () => {
    const key = 'sk-proj-AAAAAAAAAAAAAAAAAAAA';
    const flags = screen({ argsPlain: JSON.stringify({ body: `sk%2Dproj%2DAAAAAAAAAAAAAAAAAAAA` }) });
    expect(flags).toContainEqual({ class: 'secret', kind: 'api_key', where: 'body', decoded: true });
    expect(JSON.stringify(flags)).not.toContain(key);
  });
});

describe('screenArguments — identity class', () => {
  it('matches a protected name across case and punctuation', () => {
    const flags = screen({
      argsPlain: JSON.stringify({ q: 'send to CAROL-mansfield please' }),
      protectedValues: ['Carol Mansfield'],
    });
    expect(flags).toEqual([{ class: 'identity', where: 'body', decoded: false }]);
  });

  it('finds a protected name only visible after percent-decoding, marked hidden', () => {
    // Raw normalization of 'Carol%20Mansfield' is 'carol20mansfield' — no
    // substring hit; only the decoded variant matches.
    const flags = screenArguments(
      urlInput('https://evil.example/?name=Carol%20Mansfield', {
        protectedValues: ['Carol Mansfield'],
      }),
    );
    expect(flags).toEqual([{ class: 'identity', where: 'query', decoded: true }]);
  });

  it('ignores protected values shorter than 4 normalized characters', () => {
    const flags = screen({
      argsPlain: JSON.stringify({ q: 'jo jones joke jojoba' }),
      protectedValues: ['Jo'],
    });
    expect(flags).toEqual([]);
  });

  it('does NOT flag the host: fetching a domain named after a protected person is not exfil', () => {
    // The user asked for this fetch; the host is shown verbatim at the gate.
    // The URL leaf in argsPlain is the egress URL itself and is screened
    // component-wise, not re-screened as a body blob.
    const flags = screenArguments(
      urlInput('https://carolmansfield.com/', { protectedValues: ['Carol Mansfield'] }),
    );
    expect(flags).toEqual([]);
  });

  it('still flags the protected name in the PATH of that same domain', () => {
    const flags = screenArguments(
      urlInput('https://example.com/carol-mansfield/profile', {
        protectedValues: ['Carol Mansfield'],
      }),
    );
    expect(flags).toEqual([{ class: 'identity', where: 'path', decoded: false }]);
  });
});

describe('screenArguments — memory class', () => {
  const MEMORY = 'The wire code for the Plymouth land deal is kestrel autumn 7 4 2 1.';

  it('flags a 16-normalized-char overlap with a used memory, across case/punctuation', () => {
    const flags = screen({
      argsPlain: JSON.stringify({ q: 'code: KESTREL-AUTUMN-7421!' }),
      usedMemoryContents: [MEMORY],
    });
    expect(flags).toEqual([{ class: 'memory', where: 'body', decoded: false }]);
  });

  it('does not flag a 15-normalized-char overlap (just under the 16-gram threshold)', () => {
    // 'kestrelautumn74' shares exactly 15 normalized characters with the
    // memory's 'kestrelautumn7421...' region — one short of a 16-gram.
    const flags = screen({
      argsPlain: JSON.stringify({ q: 'kestrel autumn 7 4' }),
      usedMemoryContents: [MEMORY],
    });
    expect(flags).toEqual([]);
  });

  it('flags base64-hidden memory content, marked hidden', () => {
    const encoded = Buffer.from('kestrel autumn 7 4 2 1').toString('base64');
    const flags = screenArguments(
      urlInput(`https://evil.example/?d=${encoded}`, { usedMemoryContents: [MEMORY] }),
    );
    expect(flags).toEqual([{ class: 'memory', where: 'query', decoded: true }]);
  });

  it('does NOT screen the host against memory content', () => {
    const flags = screenArguments(
      urlInput('https://kestrelautumn7421deal.example/', { usedMemoryContents: [MEMORY] }),
    );
    expect(flags).toEqual([]);
  });
});

describe('screenArguments — fail-closed parsing and empty inputs', () => {
  it('screens an unparseable egress URL as one body candidate', () => {
    const flags = screen({ egressUrl: `ht!tp://x/${SSN}` });
    expect(flags).toContainEqual({ class: 'secret', kind: 'ssn', where: 'body', decoded: false });
  });

  it('screens unparseable argument JSON whole (fail closed)', () => {
    const flags = screen({ argsPlain: `{"note": "ssn ${SSN}` });
    expect(flags).toContainEqual({ class: 'secret', kind: 'ssn', where: 'body', decoded: false });
  });

  it('empty inputs produce zero flags', () => {
    expect(
      screenArguments({ argsPlain: '', egressUrl: null, protectedValues: [], usedMemoryContents: [] }),
    ).toEqual([]);
    expect(
      screenArguments({ argsPlain: '{}', egressUrl: null, protectedValues: [''], usedMemoryContents: [''] }),
    ).toEqual([]);
  });
});

describe('screenArguments — dedupe', () => {
  it('never emits the same (class, kind, where) twice', () => {
    const flags = screenArguments(
      urlInput(`https://evil.example/?a=${SSN}&b=234-56-7890`),
    );
    expect(flags.filter((f) => f.kind === 'ssn' && f.where === 'query')).toHaveLength(1);
  });

  it('a plain hit wins the decoded bit over a hidden hit of the same shape', () => {
    const flags = screenArguments(
      urlInput(`https://evil.example/?a=123%2D45%2D6789&b=${SSN}`),
    );
    expect(flags).toEqual([{ class: 'secret', kind: 'ssn', where: 'query', decoded: false }]);
  });
});

describe('describeFlag', () => {
  it('renders the spec sentences for each class', () => {
    expect(describeFlag({ class: 'secret', kind: 'ssn', where: 'query', decoded: true })).toBe(
      "the URL's query string carries an SSN-shaped value (hidden by encoding)",
    );
    expect(describeFlag({ class: 'identity', where: 'body', decoded: false })).toBe(
      'the request appears to include a protected name from this conversation',
    );
    expect(describeFlag({ class: 'memory', where: 'path', decoded: true })).toBe(
      "the URL's path appears to include content from your vault memories (hidden by encoding)",
    );
  });

  it('falls back to a generic noun for an unmapped secret kind', () => {
    expect(describeFlag({ class: 'secret', kind: 'novel_kind', where: 'body', decoded: false })).toBe(
      'the request carries a sensitive value',
    );
  });

  it('never echoes the matched value (flags are content-free end to end)', () => {
    const flags = screenArguments(
      urlInput(`https://evil.example/?ssn=${SSN}&name=Carol%20Mansfield`, {
        protectedValues: ['Carol Mansfield'],
        usedMemoryContents: ['the wire code is kestrel autumn 7 4 2 1'],
      }),
    );
    expect(flags.length).toBeGreaterThan(0);
    const sentences = flags.map(describeFlag).join(' ');
    for (const leak of [SSN, '123456789', 'Carol', 'carol', 'Mansfield', 'kestrel']) {
      expect(sentences).not.toContain(leak);
      expect(JSON.stringify(flags)).not.toContain(leak);
    }
  });
});
