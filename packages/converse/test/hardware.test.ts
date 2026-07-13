import { describe, expect, it } from 'vitest';
import { detectHardware, recommendLocalModel, type HardwareProfile } from '../src/hardware.js';

/** Hardware-matched local-model recommendation (M9c, ADR 0014). */

const hw = (totalRamGB: number): HardwareProfile => ({ totalRamGB, chip: 'Apple M-test', arch: 'arm64' });

describe('recommendLocalModel — RAM boundaries', () => {
  const cases: Array<[number, string]> = [
    [4, 'llama3.2:3b'],
    [8, 'llama3.2:3b'],
    [15, 'llama3.2:3b'],
    [16, 'qwen2.5:7b'],
    [24, 'qwen2.5:7b'],
    [31, 'qwen2.5:7b'],
    [32, 'qwen2.5:14b'],
    [48, 'qwen2.5:14b'],
    [63, 'qwen2.5:14b'],
    [64, 'qwen2.5:32b'],
    [128, 'qwen2.5:32b'],
  ];
  for (const [ram, tag] of cases) {
    it(`${ram} GB → ${tag}`, () => {
      expect(recommendLocalModel(hw(ram)).tag).toBe(tag);
    });
  }

  it('resolves a friendly label via the catalog and sizes the pull', () => {
    const rec = recommendLocalModel(hw(24));
    expect(rec.label).toBe('qwen2.5 7B');
    expect(rec.sizeGB).toBe(5);
    expect(rec.reason).toContain('24 GB');
    expect(rec.reason).toContain('7B');
  });

  it('flags a tight-memory machine differently from the safe default', () => {
    expect(recommendLocalModel(hw(4)).reason).toMatch(/tight/);
    expect(recommendLocalModel(hw(8)).reason).toMatch(/safe default/);
  });
});

describe('detectHardware', () => {
  it('reports this machine without throwing', () => {
    const p = detectHardware();
    expect(p.totalRamGB).toBeGreaterThan(0);
    expect(typeof p.chip).toBe('string');
    expect(typeof p.arch).toBe('string');
  });
});
