/**
 * The in-process vault gate: a FIFO async mutex around every operation that
 * touches the vault FILE on this phone.
 *
 * WHY (ADR 0044, fourth adversarial review kill shot). The wake pull's
 * "did the file move?" re-check reads the bytes and then AWAITS the native
 * sha256 digest. A save landing inside that await was hashed as absent, the
 * install overwrote it, and the save's own conflict re-push then overwrote the
 * rolling `.bak`: the memory existed nowhere while the pill said "Your edit was
 * kept and pushed". The same window sits between `writeAtomic` and the
 * session's vault reopen, where the OLD Vault instance could save pre-pull
 * content back over the installed file.
 *
 * The fix is not a smaller window, it is no window: the whole install
 * (re-hash, verify, write, close+reopen, the SecureStore bookkeeping) runs
 * inside one gated section, and so does every vault mutation and every push's
 * stamp-and-read. JS is single-threaded, so only the AWAITS interleave, and
 * this is what serializes them.
 *
 * NETWORK CALLS STAY OUTSIDE. A PUT can take up to 120 s; holding the gate
 * across it would make every save on the phone wait on the server, which is
 * the desktop lock-scope bug from the second review. Hence the push is split
 * into `preparePushMobile` (gated: stamp, read, hash) and
 * `uploadPreparedMobile` (ungated: the PUT), and the pull downloads before it
 * takes the gate.
 *
 * Deliberately pure TypeScript: no React Native, no Expo, no @northkeep
 * imports, so it runs unmodified under Node in apps/mobile/test/vault-gate.test.ts.
 *
 * CONTRACT
 *  - FIFO: sections run in the order `run()` was called, one at a time.
 *  - Errors release: a section that throws (or rejects) frees the gate and the
 *    error propagates to ITS caller only; the queue keeps draining.
 *  - NOT reentrant: calling `run()` from inside a section deadlocks that
 *    section forever. Never call a gated function (a mutation,
 *    `preparePushMobile`, `pullVaultMobile`'s install hook) from inside another
 *    gated section. In particular, release the gate before `pushAfterSave()`.
 */

export interface VaultGate {
  /** Run `fn` with exclusive access to the vault file. Resolves/rejects with fn's result. */
  run<T>(fn: () => T | Promise<T>): Promise<T>;
  /** True while a section holds the gate. Diagnostics and tests only. */
  readonly held: boolean;
  /** Sections waiting or running. Diagnostics and tests only. */
  readonly pending: number;
}

export function createVaultGate(): VaultGate {
  // The tail of the chain: resolves when the last-queued section has finished.
  // Assigning `tail` synchronously inside run() is what makes the order FIFO —
  // each caller awaits exactly the section queued before it.
  let tail: Promise<void> = Promise.resolve();
  let held = false;
  let pending = 0;

  async function run<T>(fn: () => T | Promise<T>): Promise<T> {
    pending += 1;
    const previous = tail;
    // Initialized so TS knows it is assigned before the finally block uses it.
    let release: () => void = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A rejected predecessor must not poison the chain; predecessors settle
    // their own promise in their finally, so this never actually rejects, but
    // the catch keeps that true even if someone resolves `tail` differently.
    await previous.catch(() => undefined);
    held = true;
    try {
      return await fn();
    } finally {
      held = false;
      pending -= 1;
      release();
    }
  }

  return {
    run,
    get held() {
      return held;
    },
    get pending() {
      return pending;
    },
  };
}

/**
 * The one gate for this process. Every module that writes the vault file must
 * import THIS instance; a second gate would serialize nothing.
 */
export const vaultGate: VaultGate = createVaultGate();
