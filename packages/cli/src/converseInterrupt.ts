/**
 * Line input and Ctrl-C routing for the Converse REPL.
 *
 * Lines are queued instead of using rl.question(): while a command awaits
 * something async, readline would drop lines that arrive mid-await, breaking
 * pasted input and piped scripting.
 *
 * At an interactive terminal readline holds stdin in raw mode, so Ctrl-C is a
 * keypress, not a process signal, and readline closes itself unless the
 * interface has a 'SIGINT' listener. This installs one: while a task runs,
 * Ctrl-C cancels it; at an idle prompt it closes the interface, ending the
 * REPL as before.
 *
 * At a terminal, an approval prompt (and the first prompt after a cancel)
 * accepts only what is typed after it appears: a `y` typed ahead must never
 * approve a call the user has not seen. Piped input is deliberate scripting
 * and is left alone.
 */

export interface ReplInput {
  on(event: 'line', listener: (line: string) => void): unknown;
  on(event: 'close' | 'SIGINT', listener: () => void): unknown;
  close(): void;
}

export interface SignalSource {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface ReplLinesOptions {
  /** True at a terminal; typeahead is only discarded there. */
  interactive?: boolean;
  /** Clears a partly typed, not yet entered line. */
  clearPartial?: () => void;
  onClose?: () => void;
}

export interface ReplLines {
  /**
   * Next queued or typed line; null once input has closed. With freshInput at
   * a terminal, anything typed before the prompt appeared is discarded.
   */
  nextLine(promptText: string, options?: { freshInput?: boolean }): Promise<string | null>;
  /** Answer every outstanding prompt with null, as EOF would. */
  releaseWaiters(): void;
  /**
   * Run one task with Ctrl-C (readline's, or the process signal when stdin is
   * not a terminal) routed to cancel it: onCancel runs once, the signal
   * aborts, and a pending prompt is released so no later line goes to it.
   */
  runCancellable<T>(
    run: (signal: AbortSignal) => Promise<T>,
    onCancel: () => void,
  ): Promise<{ value: T; cancelled: boolean }>;
}

export function createReplLines(
  rl: ReplInput,
  write: (text: string) => void,
  options: ReplLinesOptions = {},
  processSignals: SignalSource = process,
): ReplLines {
  const pending: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  let activeCancel: (() => void) | null = null;

  const releaseWaiters = (): void => {
    while (waiters.length) waiters.shift()!(null);
  };

  rl.on('line', (line: string) => {
    const w = waiters.shift();
    if (w) w(line);
    else pending.push(line);
  });
  rl.on('close', () => {
    closed = true;
    options.onClose?.();
    releaseWaiters();
  });
  rl.on('SIGINT', () => {
    if (activeCancel !== null) activeCancel();
    else rl.close();
  });

  return {
    nextLine(promptText, lineOptions) {
      if (lineOptions?.freshInput === true && options.interactive === true) {
        pending.length = 0;
        options.clearPartial?.();
      }
      if (pending.length > 0) return Promise.resolve(pending.shift()!);
      if (closed) return Promise.resolve(null);
      write(promptText);
      return new Promise((resolve) => waiters.push(resolve));
    },
    releaseWaiters,
    async runCancellable(run, onCancel) {
      const controller = new AbortController();
      const cancel = (): void => {
        if (controller.signal.aborted) return;
        onCancel();
        controller.abort();
        releaseWaiters();
      };
      activeCancel = cancel;
      processSignals.on('SIGINT', cancel);
      try {
        const value = await run(controller.signal);
        return { value, cancelled: controller.signal.aborted };
      } finally {
        if (activeCancel === cancel) activeCancel = null;
        processSignals.off('SIGINT', cancel);
      }
    },
  };
}
