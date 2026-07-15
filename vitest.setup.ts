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
import { nodePlatform } from '@northkeep/platform-node';
import { setPlatform as setPackagePlatform } from '@northkeep/core';
import { setPlatform as setSourcePlatform } from './packages/core/src/platform-context.js';

const platform = nodePlatform();
setPackagePlatform(platform);
setSourcePlatform(platform);
