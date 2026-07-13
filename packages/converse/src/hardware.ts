import os from 'node:os';
import { lookupModel } from './catalog.js';

/**
 * Hardware detection + a memory-matched local-model recommendation (M9c, ADR
 * 0014). Pure and deterministic given a HardwareProfile, so the GUI/CLI can
 * say "your Mac (chip, RAM) can run <model>" before a 1-click Ollama pull.
 * macOS-first (that's NorthKeep's target); no network, no side effects.
 */

export interface HardwareProfile {
  totalRamGB: number;
  chip: string;
  arch: string;
}

/** Read this machine's memory, chip name, and CPU arch. */
export function detectHardware(): HardwareProfile {
  return {
    totalRamGB: Math.round(os.totalmem() / 1024 ** 3),
    chip: os.cpus()[0]?.model ?? 'unknown',
    arch: os.arch(),
  };
}

interface Tier {
  /** Minimum RAM (GB) at which this tier becomes the pick. */
  minRamGB: number;
  /** Ollama tag to pull. */
  tag: string;
  /** Approx download/RAM footprint in GB. */
  sizeGB: number;
  /** Parameter size, for the reason string. */
  size: string;
}

// RAM → local model. <16 stays on the tiny 3B (a safe default that never
// thrashes); bigger machines step up. Pick the highest tier the RAM clears.
const TIERS: readonly Tier[] = [
  { minRamGB: 0, tag: 'llama3.2:3b', sizeGB: 2, size: '3B' },
  { minRamGB: 16, tag: 'qwen2.5:7b', sizeGB: 5, size: '7B' },
  { minRamGB: 32, tag: 'qwen2.5:14b', sizeGB: 9, size: '14B' },
  { minRamGB: 64, tag: 'qwen2.5:32b', sizeGB: 20, size: '32B' },
];

export function recommendLocalModel(hw: HardwareProfile = detectHardware()): {
  tag: string;
  label: string;
  sizeGB: number;
  reason: string;
} {
  const ram = hw.totalRamGB;
  // Highest tier whose minimum the machine clears (TIERS is ascending).
  let tier = TIERS[0]!;
  for (const t of TIERS) if (ram >= t.minRamGB) tier = t;

  // Resolve the family via the catalog for a friendly label.
  const family = lookupModel(tier.tag)?.id ?? tier.tag.split(':')[0]!;
  const label = `${family} ${tier.size}`;

  let reason: string;
  if (ram < 8) {
    reason = `${ram} GB — runs a small ${tier.size} model (memory is tight).`;
  } else if (ram < 16) {
    reason = `${ram} GB — comfortably runs a ${tier.size} model (a safe default).`;
  } else {
    reason = `${ram} GB — comfortably runs a ${tier.size} model.`;
  }

  return { tag: tier.tag, label, sizeGB: tier.sizeGB, reason };
}
