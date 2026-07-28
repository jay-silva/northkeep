import { describe, expect, it, vi } from 'vitest';
import { createDeadline } from '../src/lib/deadline';

/**
 * The bug this guards against is a SILENT HANG, not a wrong answer, so every
 * test here asserts that an operation TERMINATES.
 *
 * expo/fetch's `arrayBuffer()` is `waitFor(states: [.bodyCompleted])`, and that
 * listener only fires on a transition into a listed state. A dropped connection
 * — and `AbortController.abort()` itself — lands on `.errorReceived`, which is
 * terminal and not listed, so the promise never resolves AND never rejects. A
 * timeout that merely aborts therefore does nothing at all: the await sits there
 * forever, the spinner turns forever, and no error ever reaches the classifier.
 *
 * `new Promise(() => {})` below is that response body.
 */
describe('createDeadline', () => {
  const NEVER = <T,>(): Promise<T> => new Promise<T>(() => {});

  it('rejects a promise that never settles, which is the whole point', async () => {
    vi.useFakeTimers();
    try {
      const d = createDeadline(120_000, 'stalled');
      const raced = d.race(NEVER<string>());
      const assertion = expect(raced).rejects.toThrow('stalled');
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      d.done();
    } finally {
      vi.useRealTimers();
    }
  });

  it('also aborts, so the socket closes rather than leaking', async () => {
    vi.useFakeTimers();
    try {
      const d = createDeadline(1_000, 'stalled');
      expect(d.signal.aborted).toBe(false);
      const assertion = expect(d.race(NEVER<void>())).rejects.toThrow('stalled');
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(d.signal.aborted).toBe(true);
      d.done();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes a value straight through when the work wins the race', async () => {
    const d = createDeadline(60_000, 'stalled');
    await expect(d.race(Promise.resolve('ok'))).resolves.toBe('ok');
    d.done();
  });

  it('propagates the real error rather than masking it as a stall', async () => {
    const d = createDeadline(60_000, 'stalled');
    await expect(d.race(Promise.reject(new Error('HTTP 402')))).rejects.toThrow('HTTP 402');
    d.done();
  });

  it('covers EVERY await in one operation, not just the first', async () => {
    // The original bug: the timer was cleared once the response HEAD arrived, so
    // the body download ran unprotected. One scope must survive across awaits.
    vi.useFakeTimers();
    try {
      const d = createDeadline(5_000, 'stalled');
      await expect(d.race(Promise.resolve('head'))).resolves.toBe('head'); // first await wins
      const assertion = expect(d.race(NEVER<ArrayBuffer>())).rejects.toThrow('stalled'); // body stalls
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      d.done();
    } finally {
      vi.useRealTimers();
    }
  });

  it('done() disarms the timer, so a finished call cannot reject later', async () => {
    vi.useFakeTimers();
    try {
      const d = createDeadline(1_000, 'stalled');
      await expect(d.race(Promise.resolve(1))).resolves.toBe(1);
      d.done();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(d.signal.aborted).toBe(false); // never fired
    } finally {
      vi.useRealTimers();
    }
  });

  it('an expiry after a successful finish is not an unhandled rejection', async () => {
    // The loser of Promise.race stays pending; if the deadline later rejects
    // with nobody attached, Node reports an unhandled rejection and the app
    // logs noise on every slow-but-successful transfer.
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const d = createDeadline(1_000, 'stalled');
      await expect(d.race(Promise.resolve('done'))).resolves.toBe('done');
      // Deliberately do NOT call done(), so the timer fires with no listener.
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.useRealTimers();
    }
  });
});
