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
    const huge = 'x'.repeat(PROJECT_DOC_MAX_CHARS);
    expect(() => mergeProjectDoc(emptyProjectDoc(), { status: huge })).toThrow(PROJECT_DOC_CAP_MESSAGE);
    expect(PROJECT_DOC_CAP_MESSAGE).toMatch(/Prune older entries from the Log/);
    expect(PROJECT_DOC_CAP_MESSAGE).not.toMatch(/[—–]/);
  });

  it('does not silently truncate: a just-under-cap merge succeeds', () => {
    const status = 'y'.repeat(200);
    const merged = mergeProjectDoc(emptyProjectDoc(), { status });
    expect(getProjectSection(merged, 'Current Status')).toBe(status);
    expect(serializeProjectDoc(merged).length).toBeLessThanOrEqual(PROJECT_DOC_MAX_CHARS);
  });
});
