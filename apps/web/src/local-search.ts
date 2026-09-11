import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EMBED_MODEL, createOllamaClient, ollamaUrl, type PullProgress } from '@northkeep/librarian';
import type { UiSession } from './session.js';

export interface LocalSearchResponse {
  status: number;
  body: unknown;
}

export interface LocalSearchStatus {
  runtime: 'running' | 'unavailable';
  embedding_model: 'installed' | 'missing' | 'unknown';
  can_start: boolean;
  model: string;
}

interface PullJob {
  id: string;
  createdAt: number;
  finishedAt?: number;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error?: string;
}

class LocalSearchLockedError extends Error {}

export interface LocalSearchDependencies {
  model: string;
  isDesktop: () => boolean;
  platform: () => NodeJS.Platform;
  listModels: () => Promise<string[] | null>;
  launchOllama: () => Promise<void>;
  pullModel: (model: string, onProgress: (progress: PullProgress) => void) => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
  now: () => number;
  id: () => string;
  startupPollMs: number;
  startupTimeoutMs: number;
  completedJobRetentionMs: number;
}

function response(status: number, body: unknown): LocalSearchResponse {
  return { status, body };
}

function error(status: number, message: string): LocalSearchResponse {
  return response(status, { error: message });
}

function acceptsConfiguredModel(configured: string, installed: string): boolean {
  if (configured.includes(':')) return installed === configured;
  return installed === configured || installed === `${configured}:latest`;
}

export function embeddingModelInstalled(configured: string, installed: readonly string[]): boolean {
  return installed.some((name) => acceptsConfiguredModel(configured, name));
}

async function defaultListModels(): Promise<string[] | null> {
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: Array<{ name?: unknown }> };
    if (!Array.isArray(body.models)) return [];
    return body.models.flatMap((item) => (typeof item.name === 'string' ? [item.name] : []));
  } catch {
    return null;
  }
}

function defaultLaunchOllama(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/open',
      ['-g', '-a', 'Ollama'],
      { timeout: 5000, windowsHide: true, maxBuffer: 1024 },
      (launchError) => (launchError ? reject(launchError) : resolve()),
    );
  });
}

const defaults: LocalSearchDependencies = {
  model: EMBED_MODEL,
  isDesktop: () => process.env.NORTHKEEP_DESKTOP === '1',
  platform: () => process.platform,
  listModels: defaultListModels,
  launchOllama: defaultLaunchOllama,
  pullModel: (model, onProgress) => createOllamaClient().pull(model, onProgress),
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
  id: () => randomUUID(),
  startupPollMs: 500,
  startupTimeoutMs: 10_000,
  completedJobRetentionMs: 30 * 60_000,
};

export function createLocalSearchHandler(
  overrides: Partial<LocalSearchDependencies> = {},
): (
  session: UiSession,
  method: string,
  route: string,
  body: Buffer,
) => Promise<LocalSearchResponse | null> {
  const deps = { ...defaults, ...overrides };
  const jobs = new Map<string, PullJob>();
  let startInFlight: Promise<LocalSearchStatus> | null = null;
  let pullInFlight: PullJob | null = null;
  const activePull = (): PullJob | null => pullInFlight;

  const canStart = (): boolean => deps.isDesktop() && deps.platform() === 'darwin';

  const status = async (): Promise<LocalSearchStatus> => {
    const installed = await deps.listModels();
    if (installed === null) {
      return {
        runtime: 'unavailable',
        embedding_model: 'unknown',
        can_start: canStart(),
        model: deps.model,
      };
    }
    return {
      runtime: 'running',
      embedding_model: embeddingModelInstalled(deps.model, installed) ? 'installed' : 'missing',
      can_start: canStart(),
      model: deps.model,
    };
  };

  const requireEmptyBody = (body: Buffer): LocalSearchResponse | null => {
    const text = body.toString('utf8').trim();
    if (text === '') return null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).length === 0
      ) return null;
    } catch {
      // The same controlled response covers malformed and argument-bearing bodies.
    }
    return error(400, 'This action does not accept arguments.');
  };

  const requireDesktopMac = (): LocalSearchResponse | null => {
    if (!deps.isDesktop()) return error(400, 'Only available in the desktop app.');
    if (deps.platform() !== 'darwin') return error(400, 'Only available on macOS.');
    return null;
  };

  const waitForRuntime = async (): Promise<LocalSearchStatus> => {
    const deadline = deps.now() + deps.startupTimeoutMs;
    for (;;) {
      const current = await status();
      if (current.runtime === 'running') return current;
      if (deps.now() >= deadline) throw new Error('startup-timeout');
      await deps.wait(Math.min(deps.startupPollMs, Math.max(0, deadline - deps.now())));
    }
  };

  const start = async (session: UiSession): Promise<LocalSearchStatus> => {
    const current = await status();
    if (!session.isUnlocked()) throw new LocalSearchLockedError();
    if (current.runtime === 'running') return current;
    await deps.launchOllama();
    return waitForRuntime();
  };

  const evictCompletedJobs = (): void => {
    const now = deps.now();
    for (const [id, job] of jobs) {
      if (job.done && job.finishedAt !== undefined && now - job.finishedAt > deps.completedJobRetentionMs) {
        jobs.delete(id);
      }
    }
    const completed = [...jobs.values()].filter((job) => job.done);
    for (const job of completed.slice(0, Math.max(0, completed.length - 32))) jobs.delete(job.id);
  };

  const beginPull = async (session: UiSession): Promise<LocalSearchResponse> => {
    evictCompletedJobs();
    const existing = activePull();
    if (existing !== null) return response(200, { job_id: existing.id });
    const current = await status();
    if (!session.isUnlocked()) return error(423, 'Vault is locked.');
    if (current.runtime !== 'running') return error(409, 'Start Ollama before downloading the search model.');
    // Status probing yields. A competing request may have started the same pull
    // while this one waited, so close the race before creating another job.
    const raced = activePull();
    if (raced !== null) return response(200, { job_id: raced.id });

    const job: PullJob = {
      id: deps.id(),
      createdAt: deps.now(),
      status: current.embedding_model === 'installed' ? 'success' : 'starting',
      completed: 0,
      total: 0,
      done: current.embedding_model === 'installed',
    };
    if (job.done) job.finishedAt = deps.now();
    jobs.set(job.id, job);
    if (job.done) { evictCompletedJobs(); return response(200, { job_id: job.id }); }

    pullInFlight = job;
    const failPull = (): void => {
      job.status = 'failed';
      job.error = 'The search model download failed. Try again.';
      job.done = true;
      job.finishedAt = deps.now();
      pullInFlight = null;
      evictCompletedJobs();
    };
    let pulling: Promise<void>;
    try {
      // Keep this invocation synchronous with the lock recheck above. The
      // injected/default client may throw before returning a Promise.
      pulling = deps.pullModel(deps.model, (progress) => {
        job.status = 'downloading';
        if (typeof progress.completedBytes === 'number' && Number.isFinite(progress.completedBytes)) {
          job.completed = Math.max(0, progress.completedBytes);
        }
        if (typeof progress.totalBytes === 'number' && Number.isFinite(progress.totalBytes)) {
          job.total = Math.max(0, progress.totalBytes);
        }
        if (job.total > 0) job.completed = Math.min(job.completed, job.total);
      });
    } catch {
      failPull();
      return response(200, { job_id: job.id });
    }
    void pulling.then(() => {
      job.status = 'success';
      job.done = true;
      job.finishedAt = deps.now();
      pullInFlight = null;
      evictCompletedJobs();
    }).catch(failPull);
    return response(200, { job_id: job.id });
  };

  return async (session, method, route, body) => {
    const isRoute = route === '/api/local/search/status' ||
      route === '/api/local/search/start' ||
      route === '/api/local/search/pull' ||
      /^\/api\/local\/search\/pull\/[0-9a-f-]{36}$/.test(route);
    if (!isRoute) return null;
    if (!session.isUnlocked()) return error(423, 'Vault is locked.');

    if (method === 'GET' && route === '/api/local/search/status') return response(200, await status());

    if (method === 'POST' && route === '/api/local/search/start') {
      const invalidBody = requireEmptyBody(body);
      if (invalidBody) return invalidBody;
      const unsupported = requireDesktopMac();
      if (unsupported) return unsupported;
      startInFlight ??= start(session).finally(() => { startInFlight = null; });
      try {
        return response(200, await startInFlight);
      } catch (launchError) {
        if (launchError instanceof LocalSearchLockedError) return error(423, 'Vault is locked.');
        return error(
          502,
          launchError instanceof Error && launchError.message === 'startup-timeout'
            ? 'Ollama did not become available. Open it and try again.'
            : 'NorthKeep could not open Ollama. Open it manually and try again.',
        );
      }
    }

    if (method === 'POST' && route === '/api/local/search/pull') {
      const invalidBody = requireEmptyBody(body);
      if (invalidBody) return invalidBody;
      const unsupported = requireDesktopMac();
      if (unsupported) return unsupported;
      return beginPull(session);
    }

    const progress = /^\/api\/local\/search\/pull\/([0-9a-f-]{36})$/.exec(route);
    if (method === 'GET' && progress) {
      evictCompletedJobs();
      const job = jobs.get(progress[1]!);
      if (!job) return error(404, 'Unknown search model download.');
      return response(200, {
        done: job.done,
        completed: job.completed,
        total: job.total,
        status: job.status,
        ...(job.error ? { error: job.error } : {}),
      });
    }

    return error(405, 'Method not allowed.');
  };
}

export const handleLocalSearchApi = createLocalSearchHandler();
