import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical.js';

describe('canonicalJson', () => {
  it('sorts keys at every level with no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('normalizes strings to NFC so equivalent unicode hashes identically', () => {
    const composed = 'caf\u00e9'; // e-acute as one code point
    const decomposed = 'cafe\u0301'; // e + combining acute accent
    expect(composed).not.toBe(decomposed);
    expect(canonicalJson({ content: composed })).toBe(canonicalJson({ content: decomposed }));
  });

  it('renders numbers in ECMAScript shortest form per the spec', () => {
    expect(canonicalJson({ confidence: 1.0 })).toBe('{"confidence":1}');
    expect(canonicalJson({ confidence: 0.85 })).toBe('{"confidence":0.85}');
  });

  it('preserves nulls and arrays', () => {
    expect(canonicalJson({ metadata: null, tags: ['b', 'a'] })).toBe(
      '{"metadata":null,"tags":["b","a"]}',
    );
  });
});
