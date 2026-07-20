import { NER_EVAL_CORPUS, evaluateNer, type NerEvalReport } from '@northkeep/redact/dist/eval.js';
import {
  createLocalNerClient,
  type NerPassEvent,
} from '@northkeep/platform-mobile/dist/local-model/index.js';
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
 * visible error. Since the per-kind change the client runs K focused passes
 * per case; the `onNerPass` hook at the client seam counts calls/errors and
 * latency PER PASS and keeps one raw-reply and one error sample for each, so
 * a single weak kind is legible instead of averaged away.
 */
export interface NerPassDiagnostics {
  /** Pass id: 'person', 'org', 'street', 'place' (or 'single' fallback). */
  pass: string;
  calls: number;
  errors: number;
  /** Summed model latency across the run for this pass, in ms. */
  totalMs: number;
  /** First raw model reply for this pass (truncated). */
  sampleRaw?: string;
  /** First error message for this pass, if any. */
  sampleError?: string;
}

export interface NerEvalDiagnostics {
  /** Total model passes across the run (K per case since per-kind NER). */
  modelCalls: number;
  modelErrors: number;
  /** Per-kind breakdown, in pass order. */
  perPass: NerPassDiagnostics[];
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
  const diagnostics: NerEvalDiagnostics = { modelCalls: 0, modelErrors: 0, perPass: [] };
  const byPass = new Map<string, NerPassDiagnostics>();
  const record = (event: NerPassEvent) => {
    diagnostics.modelCalls += 1;
    let d = byPass.get(event.pass);
    if (!d) {
      d = { pass: event.pass, calls: 0, errors: 0, totalMs: 0 };
      byPass.set(event.pass, d);
      diagnostics.perPass.push(d);
    }
    d.calls += 1;
    d.totalMs += event.ms;
    if (event.ok) {
      if (d.sampleRaw === undefined && event.raw !== undefined) {
        d.sampleRaw = event.raw.slice(0, 300);
      }
      if (diagnostics.sampleRaw === undefined && event.raw !== undefined) {
        diagnostics.sampleRaw = event.raw.slice(0, 400);
      }
    } else {
      diagnostics.modelErrors += 1;
      d.errors += 1;
      if (d.sampleError === undefined && event.error !== undefined) {
        d.sampleError = event.error;
      }
      if (diagnostics.sampleError === undefined && event.error !== undefined) {
        diagnostics.sampleError = event.error;
      }
    }
  };
  // The SAME client construction the real redaction path uses
  // (makeLocalTier2RedactFn), so the eval measures the per-kind path the
  // product ships, with the diagnostics hook layered on at the same seam.
  const client = createLocalNerClient(resolution.model, { onNerPass: record });
  const report = await evaluateNer(NER_EVAL_CORPUS, client, onProgress);
  return {
    status: 'ok',
    backend: resolution.model.backend,
    label: resolution.model.label,
    report,
    diagnostics,
    ranAt: new Date().toISOString(),
  };
}
