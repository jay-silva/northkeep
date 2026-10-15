/**
 * Shared Vitest setup: register the Node platform adapters before any test opens
 * a vault or touches crypto (ADR 0018 platform seam). Loaded by both the unit
 * (vitest.config.ts) and e2e (e2e/vitest.config.ts) configs.
 *
 * It sets the platform on TWO module instances on purpose:
 *   - `@northkeep/core` (built dist) — what cross-package tests (sync, apps) and
 *     the in-process e2e tests import.
 *   - `packages/core/src/platform-context` (source) — what core's OWN tests use,
 *     since they import from `../src`. These are distinct module instances with
 *     separate module-level state, so both must be registered.
 * The Platform is a stateless bundle of adapters, so registering the same one in
 * both places is safe.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodePlatform } from '@northkeep/platform-node';
import { setPlatform as setPackagePlatform } from '@northkeep/core';
import { setPlatform as setSourcePlatform } from './packages/core/src/platform-context.js';

const platform = nodePlatform();
setPackagePlatform(platform);
setSourcePlatform(platform);

// No test may write to the owner's real NorthKeep home. A test that sets its own
// NORTHKEEP_HOME still wins; this only replaces an unset one, or one pointing at
// the real default, with a fresh throwaway folder per test file. Without it the
// converse suites appended about 1,000 fixture rows to the real call log.
const realHome = path.join(os.homedir(), '.northkeep');
const current = process.env.NORTHKEEP_HOME;
if (!current || path.resolve(current) === realHome) {
  process.env.NORTHKEEP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-test-home-'));
}


// No test may touch the owner's real key store: on macOS the vault key lives in
// the Keychain (northkeep-vault / master-key), and a full run once replaced and
// deleted it. On macOS the opt-out is forced. On both systems, key-store tools
// that refuse everything go first on PATH, so a test that clears the opt-out or
// forces a Linux backend fails loudly instead of reaching the real store.
if (process.platform === 'darwin') {
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  installRefusingTools(['security']);
} else if (process.platform === 'linux') {
  // A lock probes and clears the Secret Service whatever backend is forced.
  installRefusingTools(['secret-tool', 'gdbus']);
}

function installRefusingTools(names: string[]): void {
  // Setup runs once per test file, often in a reused worker.
  const first = (process.env.PATH ?? '').split(path.delimiter)[0];
  if (first.includes('northkeep-test-bin-')) return;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-test-bin-'));
  for (const name of names) {
    fs.writeFileSync(
      path.join(bin, name),
      '#!/bin/sh\necho "vitest.setup.ts: tests may not use the real key store" >&2\nexit 1\n',
      { mode: 0o755 },
    );
  }
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
}
