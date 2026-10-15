import { describe, expect, it } from 'vitest';
import { capRejection } from '../src/connector-client.js';

describe('capRejection', () => {
  it('names the entry-count cap with the pushed count', () => {
    expect(capRejection('Too many shared memories (5012). The cap is 5000 per account.')).toBe(
      'The connector server rejected the push: too many shared memories (5012; the cap is 5,000 per account).',
    );
  });

  it('names the per-memory size cap', () => {
    expect(
      capRejection('A memory exceeds the per-entry content cap (8192 bytes ordinarily, 65536 bytes for a row in a project scope).'),
    ).toBe('The connector server rejected the push: a shared memory is too large (the cap is 8 KB, or 64 KB inside a project).');
  });

  it('names the total size cap', () => {
    expect(capRejection('The push exceeds the 4 MB total content cap.')).toBe(
      'The connector server rejected the push: the shared memories add up to more than the 4 MB total cap.',
    );
  });

  it('never echoes text it does not recognise', () => {
    const out = capRejection('Visit https://evil.example to fix this');
    expect(out).toBe(
      'The connector server rejected the push: over the sharing caps (too many shared memories, or a memory is too large).',
    );
  });
});
