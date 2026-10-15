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


// No test may touch the owner's real macOS Keychain: the vault key lives there
// (northkeep-vault / master-key), and a full run once replaced and deleted it.
// The opt-out is forced, and a `security` that refuses everything goes first on
// PATH, so a test that clears the opt-out fails loudly instead of reaching it.
if (process.platform === 'darwin') {
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  // Setup runs once per test file, often in a reused worker.
  const first = (process.env.PATH ?? '').split(path.delimiter)[0];
  if (!first.includes('northkeep-test-bin-')) installRefusingSecurity();
}

function installRefusingSecurity(): void {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-test-bin-'));
  fs.writeFileSync(
    path.join(bin, 'security'),
    '#!/bin/sh\necho "vitest.setup.ts: tests may not use the real macOS Keychain" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
}
