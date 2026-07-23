import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE_DENSE,
  MAX_SCALE_TABBAR,
  MIN_TYPE_SIZE,
  TYPE_SCALE,
  WEIGHTS,
  type TypeRole,
} from '../src/lib/type-scale';

/**
 * The semantic type scale is the backbone of the Dynamic-Type wave. These guard
 * the invariants a screen migration relies on: every role exists, nothing is
 * below the 12px accessibility floor, line-heights leave room for descenders,
 * and the multiplier caps are sane. Pure data, tested under Node.
 */

const ROLES: TypeRole[] = [
  'largeTitle',
  'title',
  'headline',
  'callout',
  'body',
  'subhead',
  'footnote',
  'caption',
];

describe('TYPE_SCALE', () => {
  it('defines every semantic role exactly once', () => {
    expect(Object.keys(TYPE_SCALE).sort()).toEqual([...ROLES].sort());
  });

  it('never drops below the 12px accessibility floor', () => {
    for (const role of ROLES) {
      expect(TYPE_SCALE[role].fontSize, `${role} floor`).toBeGreaterThanOrEqual(MIN_TYPE_SIZE);
    }
  });

  it('gives every role a lineHeight at least its fontSize (no clipped descenders)', () => {
    for (const role of ROLES) {
      const { fontSize, lineHeight } = TYPE_SCALE[role];
      expect(lineHeight ?? 0, `${role} lineHeight`).toBeGreaterThanOrEqual(fontSize as number);
    }
  });

  it('scales monotonically from caption up to largeTitle', () => {
    const ascending: TypeRole[] = ['caption', 'footnote', 'subhead', 'body', 'title', 'largeTitle'];
    for (let i = 1; i < ascending.length; i++) {
      const prev = TYPE_SCALE[ascending[i - 1]!].fontSize as number;
      const cur = TYPE_SCALE[ascending[i]!].fontSize as number;
      expect(cur, `${ascending[i]} > ${ascending[i - 1]}`).toBeGreaterThan(prev);
    }
  });

  it('uses only valid RN font weights', () => {
    const valid = new Set(Object.values(WEIGHTS));
    for (const role of ROLES) {
      expect(valid.has(TYPE_SCALE[role].fontWeight as never), `${role} weight`).toBe(true);
    }
  });

  it('caps dense controls harder than free-scaling body, and the tab bar hardest', () => {
    expect(MAX_SCALE_TABBAR).toBeLessThan(MAX_SCALE_DENSE);
    expect(MAX_SCALE_DENSE).toBeGreaterThan(1);
  });
});
