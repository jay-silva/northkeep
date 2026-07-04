import { defineConfig } from 'vitest/config';

// Drives the real built CLI as a child process with production KDF cost —
// each invocation pays a full Argon2id derivation, hence the long timeouts.
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
