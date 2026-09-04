import { describe, expect, it } from 'vitest';
import { createVaultGate, vaultGate } from '../src/lib/vault-gate.js';

/**
 * The in-process vault gate (ADR 0044, fourth adversarial review kill shot).
 * The gate is what makes a pull install and a vault save mutually exclusive on
 * the phone; these run it under Node with deferred promises, no fake timers, so
 * the ORDER is asserted from real microtask scheduling.
 */

/** Drain n microtask turns, so queued sections get a chance to start. */
async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

/** A promise plus its resolver: lets a test hold a section open indefinitely. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('vault gate', () => {
  it('runs sections FIFO, in call order, never overlapping', async () => {
    const gate = createVaultGate();
    const order: string[] = [];
    const started: string[] = [];
    const section = (name: string, ticks: number) =>
      gate.run(async () => {
        started.push(name);
        for (let i = 0; i < ticks; i += 1) await Promise.resolve();
        order.push(name);
        return name;
      });

    // Queued in order, with the FIRST one deliberately the slowest: without a
    // gate 'c' would finish first.
    const all = Promise.all([section('a', 40), section('b', 5), section('c', 0)]);
    // Only the first section may have started while it still holds the gate.
    await flush();
    expect(started).toEqual(['a']);
    await expect(all).resolves.toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('never lets two sections interleave, even when both await inside', async () => {
    const gate = createVaultGate();
    let inside = 0;
    let maxInside = 0;
    const section = async () =>
      gate.run(async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await Promise.resolve();
        await Promise.resolve();
        inside -= 1;
      });
    await Promise.all([section(), section(), section(), section()]);
    expect(maxInside).toBe(1);
    expect(gate.held).toBe(false);
    expect(gate.pending).toBe(0);
  });

  it('releases on error: the thrower rejects, the queue keeps draining, the gate is not wedged', async () => {
    const gate = createVaultGate();
    const order: string[] = [];
    const first = gate.run(async () => {
      order.push('first');
      throw new Error('install failed');
    });
    const second = gate.run(() => {
      order.push('second');
      return 'ok';
    });
    await expect(first).rejects.toThrow('install failed');
    await expect(second).resolves.toBe('ok');
    expect(order).toEqual(['first', 'second']);
    expect(gate.held).toBe(false);
    // And the gate still works afterwards.
    await expect(gate.run(() => 42)).resolves.toBe(42);
  });

  it('releases on a synchronous throw too', async () => {
    const gate = createVaultGate();
    await expect(
      gate.run(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(gate.held).toBe(false);
    await expect(gate.run(() => 'after')).resolves.toBe('after');
  });

  it('a save queued behind an in-progress install waits for the WHOLE install', async () => {
    // The kill shot in miniature. The install is: re-hash the file (an AWAIT on
    // the native digest), write it, then reopen the session vault (another
    // await). Before the gate, a save landing in either window was hashed as
    // absent and then overwritten. Here the save is queued while the install is
    // parked mid-hash and must not touch the "file" until the install finishes.
    const gate = createVaultGate();
    const events: string[] = [];
    let file = 'pre-pull';
    const digest = deferred();
    const reopen = deferred();

    const install = gate.run(async () => {
      events.push('install:hash-start');
      await digest.promise; // the native sha256 await: the original race window
      events.push(`install:hash-saw:${file}`);
      file = 'server-copy';
      events.push('install:wrote');
      await reopen.promise; // close + reopen the session vault
      events.push('install:reopened');
    });

    // The save arrives while the install is parked on the digest.
    const save = gate.run(() => {
      events.push(`save:writing-over:${file}`);
      file = 'local-edit';
    });

    await flush();
    expect(events).toEqual(['install:hash-start']);

    digest.resolve();
    await flush();
    // The install has written, but the save still must not run: the reopen has
    // not happened, and that is the second window the fourth review named.
    expect(events).not.toContain('save:writing-over:server-copy');

    reopen.resolve();
    await Promise.all([install, save]);

    expect(events).toEqual([
      'install:hash-start',
      'install:hash-saw:pre-pull', // the hash saw the file it re-checked, unchanged
      'install:wrote',
      'install:reopened', // the reopen happened BEFORE the save was let through
      'save:writing-over:server-copy',
    ]);
    // The save wins the file, as it should: it is the newer write, and it is
    // now written through the REOPENED vault, not a stale handle.
    expect(file).toBe('local-edit');
  });

  it('exports one shared gate for the app (two gates would serialize nothing)', async () => {
    expect(vaultGate).toBeDefined();
    expect(vaultGate).not.toBe(createVaultGate());
    await expect(vaultGate.run(() => 'shared')).resolves.toBe('shared');
  });
});
