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

