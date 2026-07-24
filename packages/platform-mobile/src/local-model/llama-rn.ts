import type {
  LocalChatMessage,
  LocalGenerateOptions,
  LocalJsonSchema,
  LocalModel,
} from './types.js';

/**
 * LlamaRnModel: fallback backend for non-Apple-Intelligence devices (ADR 0025).
 *
 * STUBBED / DE-LINKED (2026-07-17). The `llama.rn` native iOS integration does
 * NOT build under Expo + New Architecture: the pod's header search path is
 * broken and Xcode fails with `'rnllama/rn-llama.h' file not found` (EAS build 4,
 * XCODE_BUILD_ERROR). Rather than ship a broken native compile, `llama.rn` is
 * removed as a bundled dependency and this class is an IMPORT-FREE stub: it holds
 * the intended shape but is never available, so `detectLocalModel` resolves to
 * Apple-or-none. On Apple-Intelligence hardware nothing here is used; on older
 * devices the app degrades loudly to Tier-1 (invariant #6), it does not crash.
 *
 * TODO(weekend, ADR 0025): resolve the rn-llama.h / CocoaPods header search path
 * under New Arch (or move to a maintained fork / prebuilt xcframework), then
 * restore the real `initLlama`/`context.completion` implementation. This needs an
 * actual non-Apple-Intelligence device to test end to end, so it is deferred out
 * of the Apple-FM-only build. The full implementation is preserved in git history
 * at commit ca4e812 (this same path). Do NOT re-add the `import ... from 'llama.rn'`
 * or the app.config.ts plugin until that native issue is fixed, or the iOS build
 * breaks again.
 */

export interface LlamaRnModelConfig {
  /** file:// path to the downloaded GGUF (managed by the app model store). */
  modelPath: string;
  /** Context window; keep modest on phones (memory). */
  contextSize?: number;
  /** Human label surfaced in the UI (e.g. "Llama 3.2 3B Q4"). */
  label?: string;
  /** Default cap for chat replies. */
  maxTokens?: number;
}

const UNAVAILABLE =
  'The on-device llama backend is not enabled in this build (native iOS integration pending). Use Apple Intelligence or a cloud provider.';

export class LlamaRnModel implements LocalModel {
  readonly backend = 'llama' as const;
  readonly label: string;

  constructor(config: LlamaRnModelConfig) {
    this.label = config.label ?? 'Local model';
  }

  /** Always false in this build: the native module is not linked (see header). */
  async isReady(): Promise<boolean> {
    return false;
  }

  async generateText(
    _messages: LocalChatMessage[],
    _options: LocalGenerateOptions = {},
  ): Promise<string> {
    throw new Error(UNAVAILABLE);
  }

  async generateStructured(_prompt: string, _schema: LocalJsonSchema): Promise<string> {
    throw new Error(UNAVAILABLE);
  }
}
