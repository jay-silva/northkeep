import { AppleFMModel } from './apple-fm.js';
import { LlamaRnModel, type LlamaRnModelConfig } from './llama-rn.js';
import type { LocalBackend, LocalModel } from './types.js';

/**
 * Availability detection (invariant #6 — degrade LOUDLY, never silently).
 *
 * Order of preference:
 *   1. Apple Intelligence (on-device, OS-resident, NPU-accelerated, guided
 *      generation) when the hardware/OS supports it.
 *   2. A configured llama.rn GGUF, when its model file has been downloaded and
 *      loads.
 *   3. none — the caller keeps Tier-1 as the guaranteed floor and shows the
 *      persistent "Tier-2 unavailable on this device" banner.
 *
 * `reason` is content-free (backend/capability only) and suitable for the banner.
 */
export interface LocalModelResolution {
  model: LocalModel | null;
  backend: LocalBackend | 'none';
  reason: string;
}

export interface DetectOptions {
  /** Provide to allow the llama fallback; omit to consider Apple only. */
  llama?: LlamaRnModelConfig;
  /** Test seam: skip real backends and use this resolution instead. */
  override?: LocalModel | null;
}

export async function detectLocalModel(options: DetectOptions = {}): Promise<LocalModelResolution> {
  if (options.override !== undefined) {
    const m = options.override;
    return m
      ? { model: m, backend: m.backend, reason: `override: ${m.backend}` }
      : { model: null, backend: 'none', reason: 'override: none' };
  }

  const applePrimary = new AppleFMModel();
  if (await applePrimary.isReady()) {
    return { model: applePrimary, backend: 'apple', reason: 'Apple Intelligence available' };
  }

  if (options.llama) {
    const llama = new LlamaRnModel(options.llama);
    if (await llama.isReady()) {
      return { model: llama, backend: 'llama', reason: `llama.rn model loaded (${llama.label})` };
    }
    return {
      model: null,
      backend: 'none',
      reason: 'Apple Intelligence unavailable and the local model file did not load',
    };
  }

  return {
    model: null,
    backend: 'none',
    reason: 'Apple Intelligence unavailable and no local model configured',
  };
}
