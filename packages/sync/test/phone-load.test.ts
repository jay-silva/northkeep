import { describe, expect, it, vi } from 'vitest';

// Build 31 crashed on launch: these modules ran devicePhrase(process.platform) at load, and the phone has no platform.
describe('sync modules load on the phone', () => {
  it('imports the connector modules when process.platform is undefined', async () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: undefined, configurable: true });
    try {
      vi.resetModules();
      const auto = await import('../src/connector-auto.js');
      await import('../src/connector-push.js');
      await import('../src/connector-client.js');
      expect(auto.CONNECTOR_AUTO_PUSH_MESSAGES.behind).toMatch(/^This device is behind/);
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
  });
});
