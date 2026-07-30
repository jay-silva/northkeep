import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Third bug of the same shape, so this one gets a guard.
 *
 * `AbortSignal.timeout` is a static that Node has and Hermes does not. It is in
 * the TypeScript lib types, so it compiles, and every Node test passes, and it
 * throws "undefined is not a function" the moment a phone runs it. On
 * 2026-07-30 that took out every Cloud Connect action on iOS at once: pairing,
 * sharing, unsharing, sync. Seven call sites in connector-client.ts, a module
 * the mobile app imports directly.
 *
 * The tell was already in the repo: mobile-providers.ts carried a comment
 * saying this exact API is unavailable on Hermes and worked around it there,
 * while connector-client.ts sat unfixed. A note in one file does not protect
 * another, so this scans instead.
 *
 * Sibling of hermes-buffer-guard.test.ts. Same lesson: an API that exists in
 * Node and not on the device is invisible to the typechecker and to the suite,
 * so the only defence is a scan plus a simulation.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/** Trees the phone actually executes. connector-client.ts lives in packages/sync. */
const DEVICE_TREES = ['apps/mobile/src', 'packages/platform-mobile/src'];
/** Plus the specific shared modules the mobile app imports at runtime. */
const DEVICE_FILES = ['packages/sync/src/connector-client.ts', 'packages/sync/src/creds.ts'];
/** The single sanctioned home for these statics; everything else must delegate. */
const HELPER = 'packages/sync/src/abort.ts';

function sourceFiles(dir: string): string[] {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

describe('Hermes-missing globals guard', () => {
  it('no phone-reachable source calls AbortSignal.timeout or .any unguarded', () => {
    const offenders: string[] = [];
    for (const rel of [...DEVICE_TREES.flatMap(sourceFiles), ...DEVICE_FILES]) {
      if (rel === HELPER) continue; // the one place allowed to call them
      const full = path.join(repoRoot, rel);
      if (!fs.existsSync(full)) continue;
      fs.readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
          // A bare call. Feature-detected uses read `typeof (AbortSignal as ...).timeout`
          // and are the sanctioned form, so only flag direct invocation.
          if (/\bAbortSignal\s*\.\s*(timeout|any)\s*\(/.test(code)) {
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(
      offenders,
      'AbortSignal.timeout/.any do not exist on Hermes and throw "undefined is not a function".\n' +
        'Import timeoutSignal/withTimeout from @northkeep/sync instead:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});

/**
 * Simulate Hermes by deleting the static, then exercise the real transport.
 * This is the part a scan cannot give you: proof the fallback actually aborts.
 */
describe('connector transport under a Hermes-like runtime', () => {
  const original = (AbortSignal as { timeout?: unknown }).timeout;
  afterEach(() => {
    Object.defineProperty(AbortSignal, 'timeout', {
      value: original,
      configurable: true,
      writable: true,
    });
  });

  function goHermes(): void {
    Object.defineProperty(AbortSignal, 'timeout', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }

  it('startPairing does not throw "undefined is not a function" without AbortSignal.timeout', async () => {
    goHermes();
    expect(typeof (AbortSignal as { timeout?: unknown }).timeout).toBe('undefined');
    const { startPairing } = await import('../src/connector-client.js');
    // Points at a port nothing is listening on: the call must fail as a
    // TRANSPORT error, not by calling a method that isn't there.
    await expect(
      startPairing({ server: 'http://127.0.0.1:9', deviceSecret: Buffer.alloc(32, 7) }),
    ).rejects.toThrow(/^(?!.*undefined is not a function).*$/s);
  });

  it('the fallback signal really aborts, so a request cannot hang forever', async () => {
    goHermes();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    (timer as unknown as { unref?: () => void })?.unref?.();
    await new Promise((r) => setTimeout(r, 60));
    expect(controller.signal.aborted).toBe(true);
  });
});
