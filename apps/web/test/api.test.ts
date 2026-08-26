import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';

// A disk-free session: /api/unlock parses the JSON body BEFORE any vault access,
// so these hit the parse path without a real vault on disk.
function newSession(): UiSession {
  return new UiSession('/tmp/northkeep-api-test.nkv');
}

describe('handleApi malformed JSON', () => {
  it('returns 400 (bad request), not the 500 fallback, on malformed JSON', async () => {
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/unlock',
      new URLSearchParams(),
      Buffer.from('{ not valid json'),
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON body.' });
  });

  it('still validates well-formed bodies normally (400 for a missing field)', async () => {
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/unlock',
      new URLSearchParams(),
      Buffer.from(JSON.stringify({})),
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Passphrase required.' });
  });
});

describe('handleApi Connect targets (M15)', () => {
  it('POST /api/connect/unknown returns 400', async () => {
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/connect/not-a-target',
      new URLSearchParams(),
      Buffer.from(JSON.stringify({ scopes: [] })),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/Unknown target/i);
  });
});

describe('handleApi contract targets (M16)', () => {
  it('POST /api/contract/install/unknown returns 400', async () => {
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/contract/install/cursor',
      new URLSearchParams(),
      Buffer.from('{}'),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/Unknown target/i);
  });
});
