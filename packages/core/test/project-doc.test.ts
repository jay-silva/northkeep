import { describe, expect, it } from 'vitest';
import {
  PROJECT_DOC_CAP_MESSAGE,
  PROJECT_DOC_MAX_CHARS,
  emptyProjectDoc,
  firstNonEmptyLine,
  getProjectSection,
  isValidProjectSlug,
  mergeProjectDoc,
  parseProjectDoc,
  parseProjectSlug,
  projectScope,
  serializeProjectDoc,
  assertProjectDocSize,
  rollProjectLog,
  splitLogEntries,
  formatLogArchive,
  isProjectLogArchive,
  PROJECT_LOG_KEEP_ENTRIES,
} from '../src/project-doc.js';

const SAMPLE = `## What & Why

A local-first project document for the demo.

## Current Status

Drafting the MCP tools.

## Next Actions

- [ ] Write the ADR
- [ ] Land the parser

## Decisions

- 2026-08-24 - Derived index, no stored INDEX memory.

## Log

- 2026-08-24 - Started the milestone.`;

describe('slug validation', () => {
  it('accepts 1–40 lowercase letters, digits, and hyphens', () => {
    expect(isValidProjectSlug('a')).toBe(true);
    expect(isValidProjectSlug('northkeep')).toBe(true);
    expect(isValidProjectSlug('demo-m13')).toBe(true);
    expect(isValidProjectSlug('x'.repeat(40))).toBe(true);
  });

  it('rejects uppercase, punctuation, and over-length', () => {
    expect(isValidProjectSlug('NorthKeep')).toBe(false);
    expect(isValidProjectSlug('foo_bar')).toBe(false);
    expect(isValidProjectSlug('foo.bar')).toBe(false);
    expect(isValidProjectSlug('')).toBe(false);
    expect(isValidProjectSlug('x'.repeat(41))).toBe(false);
    expect(parseProjectSlug('project:northkeep')).toBe('northkeep');
    expect(parseProjectSlug('project:foo_bar')).toBeNull();
    expect(parseProjectSlug('personal')).toBeNull();
    expect(projectScope('demo-m13')).toBe('project:demo-m13');
    expect(() => projectScope('Nope')).toThrow(/Invalid project slug/);
  });
});

describe('parse / serialize round-trip', () => {
  it('is stable for a well-formed five-section doc', () => {
    const parsed = parseProjectDoc(SAMPLE);
    expect(getProjectSection(parsed, 'What & Why')).toBe(
      'A local-first project document for the demo.',
    );
    expect(getProjectSection(parsed, 'Current Status')).toBe('Drafting the MCP tools.');
    expect(getProjectSection(parsed, 'Next Actions')).toContain('Write the ADR');
    expect(getProjectSection(parsed, 'Decisions')).toContain('Derived index');
    expect(getProjectSection(parsed, 'Log')).toContain('Started the milestone.');
    const again = parseProjectDoc(serializeProjectDoc(parsed));
    expect(serializeProjectDoc(again)).toBe(serializeProjectDoc(parsed));
    expect(again).toEqual(parsed);
  });

  it('preserves unknown extra sections verbatim, including Open Questions', () => {
    const withExtra = `## What & Why

Why this exists.

## Current Status

In progress.

## Open Questions

- Does the Log need a curator?

## Next Actions

- [ ] Decide later

## Decisions

## Log
`;
    const parsed = parseProjectDoc(withExtra);
    expect(parsed.sections.map((s) => s.title)).toEqual([
      'What & Why',
      'Current Status',
      'Open Questions',
      'Next Actions',
      'Decisions',
      'Log',
    ]);
    expect(getProjectSection(parsed, 'Current Status')).toBe('In progress.');
    const extra = parsed.sections.find((s) => s.title === 'Open Questions')!;
    expect(extra.body).toBe('- Does the Log need a curator?');
    const round = parseProjectDoc(serializeProjectDoc(parsed));
    expect(serializeProjectDoc(round)).toBe(serializeProjectDoc(parsed));
    expect(round.sections.map((s) => s.title)).toEqual(parsed.sections.map((s) => s.title));
    expect(round.sections.find((s) => s.title === 'Open Questions')?.body).toBe(extra.body);
  });

  it('does not split sections on heading-lookalikes inside a body', () => {
    const hostile = `## What & Why

See ## Current Status in this sentence, and also ##Next Actions without a space.

A code-looking line: \`## Log\` is not a heading.

## Current Status

Still one status section. Mention of ## Decisions stays here.

## Next Actions

none

## Decisions

## Log
`;
    const parsed = parseProjectDoc(hostile);
    expect(parsed.sections.map((s) => s.title)).toEqual([
      'What & Why',
      'Current Status',
      'Next Actions',
      'Decisions',
      'Log',
    ]);
    expect(getProjectSection(parsed, 'What & Why')).toContain('See ## Current Status in this sentence');
    expect(getProjectSection(parsed, 'What & Why')).toContain('##Next Actions without a space');
    expect(getProjectSection(parsed, 'Current Status')).toContain('Mention of ## Decisions stays here');
    expect(parsed.sections.filter((s) => s.title === 'Log')).toHaveLength(1);
  });
});

describe('merge semantics', () => {
  const noon = new Date('2026-08-24T16:00:00.000Z');

  it('replaces What & Why, Current Status, and Next Actions', () => {
    const merged = mergeProjectDoc(parseProjectDoc(SAMPLE), {
      whatWhy: 'Rewritten reason.',
      status: 'Tools are landing.',
      nextActions: '- [ ] Verify on the desktop',
    });
    expect(getProjectSection(merged, 'What & Why')).toBe('Rewritten reason.');
    expect(getProjectSection(merged, 'Current Status')).toBe('Tools are landing.');
    expect(getProjectSection(merged, 'Next Actions')).toBe('- [ ] Verify on the desktop');
    expect(getProjectSection(merged, 'Decisions')).toContain('Derived index');
    expect(getProjectSection(merged, 'Log')).toContain('Started the milestone.');
  });

  it('appends dated decisions and prepends dated log entries (newest first)', () => {
    const first = mergeProjectDoc(
      parseProjectDoc(SAMPLE),
      { decision: 'Cap at 16 KiB.', logEntry: 'Wrote the parser.' },
      noon,
    );
    expect(getProjectSection(first, 'Decisions')).toBe(
      '- 2026-08-24 - Derived index, no stored INDEX memory.\n- 2026-08-24 - Cap at 16 KiB.',
    );
    expect(getProjectSection(first, 'Log')).toBe(
      '- 2026-08-24 - Wrote the parser.\n- 2026-08-24 - Started the milestone.',
    );

    const second = mergeProjectDoc(first, { logEntry: 'Wrote the tests.' }, noon);
    expect(getProjectSection(second, 'Log').startsWith('- 2026-08-24 - Wrote the tests.')).toBe(true);
    expect(getProjectSection(second, 'Log')).toContain('Wrote the parser.');
    expect(getProjectSection(second, 'Log')).toContain('Started the milestone.');
  });

  it('does not double-stamp a caller-dated log or decision (tool owns the date)', () => {
    const merged = mergeProjectDoc(
      emptyProjectDoc(),
      {
        logEntry: '- 2026-01-01 - Already dated by the caller.',
        decision: '2026-01-01 - Also dated.',
      },
      noon,
    );
    expect(getProjectSection(merged, 'Log')).toBe('- 2026-08-24 - Already dated by the caller.');
    expect(getProjectSection(merged, 'Decisions')).toBe('- 2026-08-24 - Also dated.');

    const stacked = mergeProjectDoc(
      emptyProjectDoc(),
      { logEntry: '- 2026-01-01 - - 2026-01-02 - Stacked stamps.' },
      noon,
    );
    expect(getProjectSection(stacked, 'Log')).toBe('- 2026-08-24 - Stacked stamps.');
  });

  it('fills missing known sections on an empty or partial doc without dropping extras', () => {
    const partial = parseProjectDoc('## Open Questions\n\nStill open.\n');
    const merged = mergeProjectDoc(partial, { status: 'Just started.' }, noon);
    expect(merged.sections.map((s) => s.title)).toEqual(expect.arrayContaining([
      'What & Why',
      'Current Status',
      'Open Questions',
      'Next Actions',
      'Decisions',
      'Log',
    ]));
    expect(getProjectSection(merged, 'Current Status')).toBe('Just started.');
    expect(merged.sections.find((s) => s.title === 'Open Questions')?.body).toBe('Still open.');
  });

  it('starts from emptyProjectDoc', () => {
    const merged = mergeProjectDoc(emptyProjectDoc(), { status: 'Blank slate.' }, noon);
    expect(serializeProjectDoc(merged)).toContain('## Current Status\n\nBlank slate.');
    expect(firstNonEmptyLine(getProjectSection(merged, 'Current Status'))).toBe('Blank slate.');
  });
});

describe('size cap', () => {
  it('refuses a merge that would pass 16 KiB, with a prune-the-Log message', () => {
    // ADR 0045: merge no longer enforces size; the host rolls, then asserts.
    const huge = 'x'.repeat(PROJECT_DOC_MAX_CHARS);
    const merged = mergeProjectDoc(emptyProjectDoc(), { status: huge });
    const rolled = rollProjectLog(merged);
    expect(rolled.archived).toEqual([]); // nothing in the Log to roll
    expect(() => assertProjectDocSize(serializeProjectDoc(rolled.doc))).toThrow(PROJECT_DOC_CAP_MESSAGE);
    expect(PROJECT_DOC_CAP_MESSAGE).toMatch(/Shorten What & Why, Current Status, or Next Actions/);
    expect(PROJECT_DOC_CAP_MESSAGE).not.toMatch(/[—–]/);
  });

  it('does not silently truncate: a just-under-cap merge succeeds', () => {
    const status = 'y'.repeat(200);
    const merged = mergeProjectDoc(emptyProjectDoc(), { status });
    expect(getProjectSection(merged, 'Current Status')).toBe(status);
    expect(serializeProjectDoc(merged).length).toBeLessThanOrEqual(PROJECT_DOC_MAX_CHARS);
  });
});

describe('Log rolling (ADR 0045)', () => {
  const entry = (i: number) => `- 2026-09-${String(1 + (i % 28)).padStart(2, '0')} - entry ${i} ${'x'.repeat(600)}`;
  function bigDoc(n: number) {
    let doc = emptyProjectDoc();
    doc = mergeProjectDoc(doc, { status: 'Status.', nextActions: '- [ ] one' });
    const lines = [];
    for (let i = n; i >= 1; i -= 1) lines.push(entry(i)); // newest first, like the tool writes
    doc.sections.find((s) => s.title === 'Log')!.body = lines.join('\n');
    return doc;
  }

  it('does nothing while the document fits', () => {
    const doc = bigDoc(5);
    const rolled = rollProjectLog(doc);
    expect(rolled.archived).toEqual([]);
    expect(serializeProjectDoc(rolled.doc)).toBe(serializeProjectDoc(doc));
  });

  it('keeps the newest entries and returns the rest oldest first, whole entries only', () => {
    const doc = bigDoc(40); // ~24 KB of Log
    const rolled = rollProjectLog(doc);
    const kept = splitLogEntries(getProjectSection(rolled.doc, 'Log'));
    expect(kept).toHaveLength(PROJECT_LOG_KEEP_ENTRIES);
    expect(kept[0]).toContain('entry 40 ');
    expect(kept[kept.length - 1]).toContain('entry 31 ');
    expect(rolled.archived).toHaveLength(30);
    expect(rolled.archived[0]).toContain('entry 1 ');
    expect(rolled.archived[29]).toContain('entry 30 ');
    expect(serializeProjectDoc(rolled.doc).length).toBeLessThanOrEqual(PROJECT_DOC_MAX_CHARS);
    for (const e of rolled.archived) expect(e.startsWith('- ')).toBe(true);
    expect(getProjectSection(rolled.doc, 'Decisions')).toBe(getProjectSection(doc, 'Decisions'));
  });

  it('keeps a multi-line entry together', () => {
    const body = ['- 2026-09-03 - newest', '- 2026-09-02 - middle', '  continued line', '- 2026-09-01 - oldest'].join('\n');
    expect(splitLogEntries(body)).toEqual(['- 2026-09-03 - newest', '- 2026-09-02 - middle\n  continued line', '- 2026-09-01 - oldest']);
  });

  it('keeps fewer than ten when the rest of the document is large, down to one', () => {
    let doc = bigDoc(40);
    doc = mergeProjectDoc(doc, { status: 'S'.repeat(PROJECT_DOC_MAX_CHARS - 4000) });
    const rolled = rollProjectLog(doc);
    const kept = splitLogEntries(getProjectSection(rolled.doc, 'Log'));
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.length).toBeLessThan(PROJECT_LOG_KEEP_ENTRIES);
    expect(serializeProjectDoc(rolled.doc).length).toBeLessThanOrEqual(PROJECT_DOC_MAX_CHARS);
  });

  it('formats an archive the reader can recognise', () => {
    const text = formatLogArchive('demo', ['- 2026-09-01 - a', '- 2026-09-02 - b'], new Date('2026-09-04T00:00:00Z'));
    expect(text.startsWith('## Log archive: demo')).toBe(true);
    expect(text).toContain('Rolled 2026-09-04');
    expect(text.endsWith('- 2026-09-01 - a\n- 2026-09-02 - b')).toBe(true);
    expect(isProjectLogArchive(text)).toBe(true);
    expect(isProjectLogArchive('## Current Status\n\nnope')).toBe(false);
  });
});
