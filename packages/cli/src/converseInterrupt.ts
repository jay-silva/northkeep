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
 */

export interface ReplInput {
  on(event: 'line', listener: (line: string) => void): unknown;
  on(event: 'close' | 'SIGINT', listener: () => void): unknown;
  close(): void;
}

export interface ReplLines {
  /** Next queued or typed line; null once input has closed. */
  nextLine(promptText: string): Promise<string | null>;
  /** Answer every outstanding prompt with null, as EOF would. */
  releaseWaiters(): void;
  /** Route Ctrl-C to `cancel` until the returned function is called. */
  beginTask(cancel: () => void): () => void;
}

export function createReplLines(
  rl: ReplInput,
  write: (text: string) => void,
  onClose: () => void = () => {},
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
    onClose();
    releaseWaiters();
  });
  rl.on('SIGINT', () => {
    if (activeCancel !== null) activeCancel();
    else rl.close();
  });

  return {
    nextLine(promptText) {
      if (pending.length > 0) return Promise.resolve(pending.shift()!);
      if (closed) return Promise.resolve(null);
      write(promptText);
      return new Promise((resolve) => waiters.push(resolve));
    },
    releaseWaiters,
    beginTask(cancel) {
      activeCancel = cancel;
      return () => {
        if (activeCancel === cancel) activeCancel = null;
      };
    },
  };
}
