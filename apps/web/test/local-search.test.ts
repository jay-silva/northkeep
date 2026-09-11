import { describe, expect, it, vi } from 'vitest';
import { createLocalSearchHandler, embeddingModelInstalled } from '../src/local-search.js';
import type { UiSession } from '../src/session.js';

const UUID_A = '00000000-0000-4000-8000-000000000001';

function session(unlocked = true): UiSession {
  return { isUnlocked: () => unlocked } as UiSession;
}

function request(
  handler: ReturnType<typeof createLocalSearchHandler>,
  method: string,
  route: string,
  body = '',
) {
  return handler(session(), method, route, Buffer.from(body));
}

function dependencies(overrides: Parameters<typeof createLocalSearchHandler>[0] = {}) {
  return {
    model: 'nomic-embed-text',
    isDesktop: () => true,
    platform: () => 'darwin' as const,
    listModels: async () => [] as string[],
    launchOllama: async () => undefined,
    pullModel: async () => undefined,
    wait: async () => undefined,
    now: () => 0,
    id: () => UUID_A,
    startupPollMs: 1,
    startupTimeoutMs: 2,
    completedJobRetentionMs: 100,
    ...overrides,
  };
}

describe('local search controls', () => {
  it('matches only the configured model and its implicit latest tag', () => {
    expect(embeddingModelInstalled('nomic-embed-text', ['nomic-embed-text'])).toBe(true);
    expect(embeddingModelInstalled('nomic-embed-text', ['nomic-embed-text:latest'])).toBe(true);
    expect(embeddingModelInstalled('nomic-embed-text', ['nomic-embed-text-v2'])).toBe(false);
    expect(embeddingModelInstalled('nomic-embed-text:v1', ['nomic-embed-text:v1'])).toBe(true);
    expect(embeddingModelInstalled('nomic-embed-text:v1', ['nomic-embed-text:latest'])).toBe(false);
  });

  it('requires unlock for every route before probing or launching', async () => {
    const listModels = vi.fn(async () => null);
    const launchOllama = vi.fn(async () => undefined);
    const handler = createLocalSearchHandler(dependencies({ listModels, launchOllama }));
    const routes = [
      ['GET', '/api/local/search/status'],
      ['POST', '/api/local/search/start'],
      ['POST', '/api/local/search/pull'],
      ['GET', `/api/local/search/pull/${UUID_A}`],
    ];
    for (const [method, route] of routes) {
      const result = await handler(session(false), method!, route!, Buffer.alloc(0));
      expect(result).toEqual({ status: 423, body: { error: 'Vault is locked.' } });
    }
    expect(listModels).not.toHaveBeenCalled();
    expect(launchOllama).not.toHaveBeenCalled();
  });

  it('reports runtime and model states separately', async () => {
    let models: string[] | null = null;
    const handler = createLocalSearchHandler(dependencies({ listModels: async () => models }));
    expect((await request(handler, 'GET', '/api/local/search/status'))?.body).toEqual({
      runtime: 'unavailable', embedding_model: 'unknown', can_start: true, model: 'nomic-embed-text',
    });
    models = ['llama3.2:3b'];
    expect((await request(handler, 'GET', '/api/local/search/status'))?.body).toMatchObject({
      runtime: 'running', embedding_model: 'missing',
    });
    models = ['nomic-embed-text:latest'];
    expect((await request(handler, 'GET', '/api/local/search/status'))?.body).toMatchObject({
      runtime: 'running', embedding_model: 'installed',
    });
  });

  it('coalesces startup, skips launch when running, and controls failures', async () => {
    let resolveLaunch!: () => void;
    const launch = new Promise<void>((resolve) => { resolveLaunch = resolve; });
    let running = false;
    const launchOllama = vi.fn(() => launch);
    const handler = createLocalSearchHandler(dependencies({
      listModels: async () => running ? [] : null,
      launchOllama,
      wait: async () => { running = true; },
      now: (() => { let value = 0; return () => value++; })(),
      startupTimeoutMs: 10,
    }));
    const first = request(handler, 'POST', '/api/local/search/start', '{}');
    const second = request(handler, 'POST', '/api/local/search/start');
    await vi.waitFor(() => expect(launchOllama).toHaveBeenCalledOnce());
    resolveLaunch();
    expect((await first)?.status).toBe(200);
    expect((await second)?.status).toBe(200);
    expect(launchOllama).toHaveBeenCalledOnce();
    expect((await request(handler, 'POST', '/api/local/search/start'))?.status).toBe(200);
    expect(launchOllama).toHaveBeenCalledOnce();

    const failed = createLocalSearchHandler(dependencies({
      listModels: async () => null,
      launchOllama: async () => { throw new Error('private child stderr'); },
    }));
    const failure = await request(failed, 'POST', '/api/local/search/start');
    expect(failure).toEqual({
      status: 502,
      body: { error: 'NorthKeep could not open Ollama. Open it manually and try again.' },
    });
    expect(JSON.stringify(failure)).not.toContain('private child stderr');
  });

  it('does not launch or pull if the vault locks during the readiness probe', async () => {
    let unlocked = true;
    let releaseStartProbe!: () => void;
    const startProbe = new Promise<void>((resolve) => { releaseStartProbe = resolve; });
    const launchOllama = vi.fn(async () => undefined);
    const startHandler = createLocalSearchHandler(dependencies({
      listModels: async () => { await startProbe; return null; },
      launchOllama,
    }));
    const mutableSession = { isUnlocked: () => unlocked } as UiSession;
    const starting = startHandler(mutableSession, 'POST', '/api/local/search/start', Buffer.alloc(0));
    unlocked = false;
    releaseStartProbe();
    expect(await starting).toEqual({ status: 423, body: { error: 'Vault is locked.' } });
    expect(launchOllama).not.toHaveBeenCalled();

    unlocked = true;
    let releasePullProbe!: () => void;
    const pullProbe = new Promise<void>((resolve) => { releasePullProbe = resolve; });
    const pullModel = vi.fn(async () => undefined);
    const pullHandler = createLocalSearchHandler(dependencies({
      listModels: async () => { await pullProbe; return ['llama3.2:3b']; },
      pullModel,
    }));
    const pulling = pullHandler(mutableSession, 'POST', '/api/local/search/pull', Buffer.alloc(0));
    unlocked = false;
    releasePullProbe();
    expect(await pulling).toEqual({ status: 423, body: { error: 'Vault is locked.' } });
    expect(pullModel).not.toHaveBeenCalled();
  });

  it('rejects arguments and prevents writes outside the desktop Mac app', async () => {
    const launchOllama = vi.fn(async () => undefined);
    const pullModel = vi.fn(async () => undefined);
    const handler = createLocalSearchHandler(dependencies({
      isDesktop: () => false,
      launchOllama,
      pullModel,
    }));
    expect(await request(handler, 'POST', '/api/local/search/start', '{"app":"Calculator"}')).toEqual({
      status: 400, body: { error: 'This action does not accept arguments.' },
    });
    expect((await request(handler, 'POST', '/api/local/search/start'))?.status).toBe(400);
    expect((await request(handler, 'POST', '/api/local/search/pull'))?.status).toBe(400);
    expect(launchOllama).not.toHaveBeenCalled();
    expect(pullModel).not.toHaveBeenCalled();
  });

  it('pulls only the fixed embedding model, coalesces active jobs, and sanitizes errors', async () => {
    let rejectPull!: (error: Error) => void;
    const pending = new Promise<void>((_, reject) => { rejectPull = reject; });
    const pullModel = vi.fn((_model, onProgress) => {
      onProgress({ status: 'private registry phase', completedBytes: 10, totalBytes: 20 });
      return pending;
    });
    const handler = createLocalSearchHandler(dependencies({
      listModels: async () => ['llama3.2:3b'],
      pullModel,
    }));
    const first = await request(handler, 'POST', '/api/local/search/pull', '{}');
    const second = await request(handler, 'POST', '/api/local/search/pull');
    expect(first).toEqual({ status: 200, body: { job_id: UUID_A } });
    expect(second).toEqual(first);
    expect(pullModel).toHaveBeenCalledOnce();
    expect(pullModel).toHaveBeenCalledWith('nomic-embed-text', expect.any(Function));
    expect((await request(handler, 'GET', `/api/local/search/pull/${UUID_A}`))?.body).toEqual({
      done: false, completed: 10, total: 20, status: 'downloading',
    });

    rejectPull(new Error('registry leaked detail'));
    await vi.waitFor(async () => {
      const result = await request(handler, 'GET', `/api/local/search/pull/${UUID_A}`);
      expect(result?.body).toMatchObject({
        done: true, status: 'failed', error: 'The search model download failed. Try again.',
      });
      expect(JSON.stringify(result)).not.toContain('registry leaked detail');
    });
  });

  it('coalesces pulls that race while runtime status is pending', async () => {
    let releaseProbe!: () => void;
    const probe = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const pullModel = vi.fn(() => new Promise<void>(() => undefined));
    const handler = createLocalSearchHandler(dependencies({
      listModels: async () => { await probe; return ['llama3.2:3b']; },
      pullModel,
    }));
    const first = request(handler, 'POST', '/api/local/search/pull');
    const second = request(handler, 'POST', '/api/local/search/pull');
    releaseProbe();
    expect(await first).toEqual({ status: 200, body: { job_id: UUID_A } });
    expect(await second).toEqual({ status: 200, body: { job_id: UUID_A } });
    expect(pullModel).toHaveBeenCalledOnce();
  });

  it('does not download an already installed embedding model', async () => {
    const pullModel = vi.fn(async () => undefined);
    const handler = createLocalSearchHandler(dependencies({
      listModels: async () => ['nomic-embed-text:latest'],
      pullModel,
    }));
    const started = await request(handler, 'POST', '/api/local/search/pull');
    expect(started).toEqual({ status: 200, body: { job_id: UUID_A } });
    expect((await request(handler, 'GET', `/api/local/search/pull/${UUID_A}`))?.body).toMatchObject({
      done: true, status: 'success',
    });
    expect(pullModel).not.toHaveBeenCalled();
  });

  it('contains a synchronous pull-client failure and releases single-flight', async () => {
    const pullModel = vi.fn((): Promise<void> => { throw new Error('raw configured URL failure'); });
    const handler = createLocalSearchHandler(dependencies({
      listModels: async () => ['llama3.2:3b'],
      pullModel,
    }));
    const first = await request(handler, 'POST', '/api/local/search/pull');
    expect(first).toEqual({ status: 200, body: { job_id: UUID_A } });
    const progress = await request(handler, 'GET', `/api/local/search/pull/${UUID_A}`);
    expect(progress?.body).toMatchObject({
      done: true,
      status: 'failed',
      error: 'The search model download failed. Try again.',
    });
    expect(JSON.stringify(progress)).not.toContain('raw configured URL failure');
    await request(handler, 'POST', '/api/local/search/pull');
    expect(pullModel).toHaveBeenCalledTimes(2);
  });
  it('caps completed receipts without initiating any download', async () => {
    let nextId = 0;
    const pullModel = vi.fn(async () => undefined);
    const handler = createLocalSearchHandler(dependencies({
      listModels: async () => ['nomic-embed-text:latest'],
      id: () => '00000000-0000-4000-8000-' + String(++nextId).padStart(12, '0'),
      pullModel,
    }));
    for (let count = 0; count < 40; count += 1) {
      expect((await request(handler, 'POST', '/api/local/search/pull'))?.status).toBe(200);
    }
    expect((await request(handler, 'GET', '/api/local/search/pull/' + UUID_A))?.status).toBe(404);
    expect((await request(handler, 'GET', '/api/local/search/pull/00000000-0000-4000-8000-000000000040'))?.body).toMatchObject({ done: true, status: 'success' });
    expect(pullModel).not.toHaveBeenCalled();
  });

});
