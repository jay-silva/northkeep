import { defineConfig } from 'vitest/config';

// Unit tests only. E2E lives in e2e/vitest.config.ts and requires a build.
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
