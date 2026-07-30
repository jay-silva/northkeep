/**
 * Request deadlines that work on Hermes as well as Node.
 *
 * THE ONLY PLACE `AbortSignal.timeout` / `AbortSignal.any` may be called
 * directly. Everything phone-reachable goes through here, enforced by
 * packages/sync/test/hermes-abortsignal.test.ts.
 *
 * Both statics exist in Node and in the TypeScript lib types, and neither
 * exists on Hermes. So a direct call compiles, passes every Node test, and
 * throws "undefined is not a function" on a real phone before the request is
 * even sent. On 2026-07-30 that took out every Cloud Connect action on iOS at
 * once (pairing, sharing, unsharing, sync) from seven call sites in
 * connector-client.ts.
 *
 * The fallback is a real AbortController rather than "no signal". Dropping the
 * deadline silently is how a lost connection becomes a spinner that never
 * stops, and this codebase has already paid for that failure mode once (see
 * apps/mobile/src/lib/deadline.ts).
 */

const hasTimeout = (): boolean =>
  typeof (AbortSignal as { timeout?: unknown }).timeout === 'function';
const hasAny = (): boolean => typeof (AbortSignal as { any?: unknown }).any === 'function';

/** A signal that aborts after `ms`, on any engine. */
export function timeoutSignal(ms: number): AbortSignal {
  if (hasTimeout()) return AbortSignal.timeout(ms);
  const controller = new AbortController();
  const timer: unknown = setTimeout(() => controller.abort(), ms);
  // Do not hold a Node event loop open for a timer that may never fire. RN's
  // timer has no unref, hence the optional call.
  (timer as { unref?: () => void })?.unref?.();
  return controller.signal;
}

/**
 * Combine a caller's signal with a deadline. Returns a signal that aborts when
 * EITHER fires, on any engine.
 *
 * Where `AbortSignal.any` is missing we wire the two together by hand rather
 * than returning just one of them: dropping the caller's signal would ignore a
 * user cancellation, and dropping the timeout would reintroduce the hang.
 */
export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const deadline = timeoutSignal(ms);
  if (!signal) return deadline;
  if (signal.aborted) return signal;
  if (hasAny()) return AbortSignal.any([signal, deadline]);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  deadline.addEventListener('abort', abort, { once: true });
  return controller.signal;
}
