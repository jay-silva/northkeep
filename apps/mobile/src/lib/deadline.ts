/**
 * A hard deadline you can RACE, not merely arm.
 *
 * Pure TypeScript with no React Native, Expo, or @northkeep imports, so it is
 * unit-tested under Node (apps/mobile/test/deadline.test.ts) — same seam as
 * sync-flow.ts and sync-errors.ts.
 *
 * WHY THIS EXISTS. The obvious shape for a timeout,
 *
 *   const c = new AbortController();
 *   const t = setTimeout(() => c.abort(), MS);
 *   try { res = await fetch(url, { signal: c.signal }); } finally { clearTimeout(t); }
 *   const body = await res.arrayBuffer();
 *
 * is silently wrong against expo/fetch, in two compounding ways verified in the
 * installed iOS module:
 *
 * 1. `fetch()` resolves when the response HEAD arrives (ExpoFetchModule resolves
 *    on `.responseReceived`), so `clearTimeout` in that `finally` disarms the
 *    timer while the body is still downloading. The body transfer — by far the
 *    longest part when the payload is a whole vault — ends up with no deadline.
 *
 * 2. `arrayBuffer()` and `text()` are `waitFor(states: [.bodyCompleted])`, and
 *    that listener fires only on a transition INTO a listed state. Every failure
 *    path — a dropped connection, and `controller.abort()` itself — lands on
 *    `.errorReceived`, which is terminal and not in the list. The promise then
 *    NEVER settles: not resolved, not rejected. Aborting cannot rescue it, so a
 *    timeout that only aborts is not a timeout at all.
 *
 * The result on device is the worst failure mode available: a wifi blip during a
 * vault download leaves the spinner turning forever, with no error for the
 * classifier to report and no timeout to fire. Racing the deadline against each
 * await is what makes the operation terminate; the abort is still issued so the
 * socket actually closes.
 */

/** A scope whose `race()` must wrap EVERY await in the operation, body reads included. */
export interface DeadlineScope {
  /** Pass to `fetch` so an expiry closes the socket as well as failing the call. */
  signal: AbortSignal;
  /** Wrap each await: `await scope.race(res.arrayBuffer())`. */
  race<T>(promise: Promise<T>): Promise<T>;
  /** Always call in a `finally`, or the timer keeps the process/JS timer alive. */
  done(): void;
}

export function createDeadline(ms: number, message: string): DeadlineScope {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(message));
    }, ms);
  });
  // The winner of a race leaves the loser pending; without this, an expiry that
  // arrives after a successful finish is an unhandled rejection.
  expired.catch(() => {});
  return {
    signal: controller.signal,
    race: <T,>(promise: Promise<T>): Promise<T> => Promise.race([promise, expired]),
    done: (): void => clearTimeout(timer),
  };
}
