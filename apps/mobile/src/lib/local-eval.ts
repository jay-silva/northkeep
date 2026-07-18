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
export type OnDeviceNerEval =
  | {
      status: 'ok';
      backend: 'apple' | 'llama';
      label: string;
      report: NerEvalReport;
      ranAt: string;
    }
  | { status: 'unavailable'; reason: string };

export async function runOnDeviceNerEval(): Promise<OnDeviceNerEval> {
  const resolution = await getLocalModel();
  if (!resolution.model) {
    return { status: 'unavailable', reason: resolution.reason };
  }
  const client = createLocalNerClient(resolution.model);
  const report = await evaluateNer(NER_EVAL_CORPUS, client);
  return {
    status: 'ok',
    backend: resolution.model.backend,
    label: resolution.model.label,
    report,
    ranAt: new Date().toISOString(),
  };
}
