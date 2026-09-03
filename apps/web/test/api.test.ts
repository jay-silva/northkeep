import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('handleApi review pass (ADR 0043)', () => {
  const prevHome = process.env.NORTHKEEP_HOME;
  let dir: string | undefined;
  afterEach(() => {
    if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
    else process.env.NORTHKEEP_HOME = prevHome;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('unknown review routes return 404', async () => {
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/review/accept-all',
      new URLSearchParams(),
      Buffer.from('{}'),
    );
    expect(res.status).toBe(404);
    const missing = await handleApi(
      newSession(),
      'GET',
      '/api/review/no-such-route',
      new URLSearchParams(),
      Buffer.from(''),
    );
    expect(missing.status).toBe(404);
  });

  it('GET /api/review/report is 404 when no report exists', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const res = await handleApi(
      newSession(),
      'GET',
      '/api/review/report',
      new URLSearchParams(),
      Buffer.from(''),
    );
    expect(res.status).toBe(404);
  });

  it('GET /api/review/api-options returns an endpoints list', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const res = await handleApi(
      newSession(),
      'GET',
      '/api/review/api-options',
      new URLSearchParams(),
      Buffer.from(''),
    );
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { endpoints: unknown[] }).endpoints)).toBe(true);
  });

  it('POST /api/review/preflight unknown endpoint is 400', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/review/preflight',
      new URLSearchParams(),
      Buffer.from(JSON.stringify({ endpoint_id: 'no-such-endpoint' })),
    );
    expect(res.status).toBe(400);
  });

  it('POST /api/review/run mode=api with a loopback endpoint is 400', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    fs.writeFileSync(
      path.join(dir, 'providers.json'),
      `${JSON.stringify({
        endpoints: [
          {
            id: 'local-ollama',
            label: 'Local Ollama',
            baseUrl: 'http://127.0.0.1:11434',
            model: 'qwen2.5:14b',
            kind: 'openai-compatible',
            hasKey: false,
          },
        ],
      }, null, 2)}\n`,
    );
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/review/run',
      new URLSearchParams(),
      Buffer.from(
        JSON.stringify({
          mode: 'api',
          endpoint_id: 'local-ollama',
          selection_fingerprint: 'abc',
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/That endpoint is local/);
  });

  it('POST /api/review/run mode=api without a fingerprint is 400', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/review/run',
      new URLSearchParams(),
      Buffer.from(JSON.stringify({ mode: 'api', endpoint_id: 'openai-test' })),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/selection_fingerprint/);
  });

  it('POST /api/review/run with no body stays on the local path', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/review/run',
      new URLSearchParams(),
      Buffer.from(''),
    );
    // Local path: started job (200), locked (423), or no vault on this
    // throwaway session (500). Never an API-path 400, never a silent hop.
    expect(res.status).not.toBe(400);
    const err = (res.body as { error?: string }).error ?? '';
    expect(err).not.toMatch(/endpoint_id|selection_fingerprint|That endpoint is local/);
    if (res.status === 200) {
      expect((res.body as { job_id?: string }).job_id).toEqual(expect.any(String));
    }
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
