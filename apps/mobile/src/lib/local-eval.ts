import { NER_EVAL_CORPUS, evaluateNer, type NerEvalReport } from '@northkeep/redact/dist/eval.js';
import { createLocalNerClient } from '@northkeep/platform-mobile/dist/local-model/index.js';
import { getLocalModel } from './local-model';

/**
 * On-device Tier-2 NER eval runner (M6-4 GATE). Runs the seeded corpus through
 * the REAL redact() pipeline using the phone's own model, so Jay can read a
 * catch-rate on his iPhone and decide parity -> ship / near -> "beta" / poor ->
 * private-chat-only. The scoring lives in @northkeep/redact (evaluateNer), so
 * this number is directly comparable to the desktop Ollama baseline captured
 * with the same function.
 *
 * Returns an honest `unavailable` when no backend is present — never a fake
 * number (invariant #6: degrade loudly).
 */
/**
 * Ground truth on what the model ACTUALLY did during the run. applyTier2
 * swallows model errors into a silent per-case degrade (correct for chats,
 * opaque for evals) — a run where every call throws scores 0.0% with no
 * visible error. This wrapper makes that failure mode legible: it counts
 * calls/errors at the client seam and keeps one sample of each.
 */
export interface NerEvalDiagnostics {
  modelCalls: number;
  modelErrors: number;
  /** First error message seen, if any. */
  sampleError?: string;
  /** First raw model reply (truncated) — shows exactly what the parser got. */
  sampleRaw?: string;
}

export type OnDeviceNerEval =
  | {
      status: 'ok';
      backend: 'apple' | 'llama';
      label: string;
      report: NerEvalReport;
      diagnostics: NerEvalDiagnostics;
      ranAt: string;
    }
  | { status: 'unavailable'; reason: string };

export async function runOnDeviceNerEval(
  onProgress?: (done: number, total: number) => void,
): Promise<OnDeviceNerEval> {
  const resolution = await getLocalModel();
  if (!resolution.model) {
    return { status: 'unavailable', reason: resolution.reason };
  }
  const client = createLocalNerClient(resolution.model);
  const diagnostics: NerEvalDiagnostics = { modelCalls: 0, modelErrors: 0 };
  const instrumented = {
    ...client,
    generateJson: async (prompt: string) => {
      diagnostics.modelCalls += 1;
      try {
        const raw = await client.generateJson(prompt);
        if (diagnostics.sampleRaw === undefined) {
          diagnostics.sampleRaw = raw.slice(0, 400);
        }
        return raw;
      } catch (err) {
        diagnostics.modelErrors += 1;
        if (diagnostics.sampleError === undefined) {
          diagnostics.sampleError = err instanceof Error ? err.message : String(err);
        }
        throw err;
      }
    },
  };
  const report = await evaluateNer(NER_EVAL_CORPUS, instrumented, onProgress);
  return {
    status: 'ok',
    backend: resolution.model.backend,
    label: resolution.model.label,
    report,
    diagnostics,
    ranAt: new Date().toISOString(),
  };
}
