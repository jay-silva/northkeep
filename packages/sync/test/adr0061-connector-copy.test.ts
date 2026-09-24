import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateDeviceSecret } from '@northkeep/core';
import { LAPSED_UNSHARE_HINT, getManifest, startPairing, unshareScope } from '../src/index.js';

/** ADR 0061 claim 20 at the client library: every connector 402 carries the unshare hint; unshare errors stay status-only. */

afterEach(() => vi.unstubAllGlobals());

describe('ADR 0061 connector-client 402 copy', () => {
  it('pairing and manifest 402s add the hint; a failed unshare does not claim a subscription', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 402 }));
    const deviceSecret = generateDeviceSecret();
    const server = 'http://127.0.0.1:9';
    await expect(startPairing({ server, deviceSecret })).rejects.toThrow(`HTTP 402 on pairing. ${LAPSED_UNSHARE_HINT}`);
    await expect(getManifest({ server, deviceSecret })).rejects.toThrow(LAPSED_UNSHARE_HINT);
    await expect(unshareScope({ server, deviceSecret, scope: 'work' })).rejects.toThrow('HTTP 402 on unshare.');
  });
});
