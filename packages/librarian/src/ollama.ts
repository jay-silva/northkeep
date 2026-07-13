/**
 * Minimal Ollama client over Node's built-in fetch — no dependencies.
 *
 * INVARIANT (#1, ADR 0003): plaintext conversation content goes to this URL,
 * so the URL must be loopback. NORTHKEEP_OLLAMA_URL exists for tests and
 * non-default ports, but any non-loopback host is refused outright — there
 * is deliberately no override.
 */
const DEFAULT_URL = 'http://127.0.0.1:11434';
export const EXTRACT_MODEL = process.env.NORTHKEEP_EXTRACT_MODEL ?? 'llama3.2:3b';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function ollamaUrl(): string {
  const url = process.env.NORTHKEEP_OLLAMA_URL ?? DEFAULT_URL;
  const parsed = new URL(url);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Refusing non-local Ollama URL "${url}": conversation plaintext never leaves this machine.`,
    );
  }
  return url.replace(/\/$/, '');
}

/** One progress tick from a streaming model pull. */
export interface PullProgress {
  status: string;
  completedBytes?: number;
  totalBytes?: number;
}

export interface OllamaClient {
  /** True when Ollama is reachable AND the extraction model is pulled. */
  available(): Promise<boolean>;
  /** Generate with format=json; returns the raw response text. */
  generateJson(prompt: string): Promise<string>;
  /**
   * Pull a model, streaming NDJSON progress via onProgress. Loopback-locked
   * (reuses ollamaUrl()). Throws if the server or the pull reports an error.
   */
  pull(model: string, onProgress?: (p: PullProgress) => void): Promise<void>;
}

/**
 * Parse one line of Ollama's NDJSON pull stream into a PullProgress, or null
 * for blank/unparseable/statusless lines. Split out so the line handling can be
 * unit-tested without a live server. Throws on an explicit {error} line.
 */
export function parseOllamaProgressLine(line: string): PullProgress | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: { status?: unknown; error?: unknown; completed?: unknown; total?: unknown };
  try {
    obj = JSON.parse(trimmed) as typeof obj;
  } catch {
    return null;
  }
  if (typeof obj.error === 'string') throw new Error(`Ollama pull failed: ${obj.error}`);
  if (typeof obj.status !== 'string') return null;
  const progress: PullProgress = { status: obj.status };
  if (typeof obj.completed === 'number') progress.completedBytes = obj.completed;
  if (typeof obj.total === 'number') progress.totalBytes = obj.total;
  return progress;
}

export function createOllamaClient(): OllamaClient {
  const base = ollamaUrl();
  return {
    async available(): Promise<boolean> {
      try {
        // redirect:'error' everywhere — a 307 from a hostile process squatting
        // the port would otherwise re-send our plaintext to its Location.
        const res = await fetch(`${base}/api/tags`, {
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { models?: Array<{ name?: string }> };
        const wanted = EXTRACT_MODEL.split(':')[0]!;
        return (body.models ?? []).some((m) => (m.name ?? '').startsWith(wanted));
      } catch {
        return false;
      }
    },
    async generateJson(prompt: string): Promise<string> {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: EXTRACT_MODEL,
          prompt,
          format: 'json',
          stream: false,
          options: { temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(120_000),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}.`);
      const body = (await res.json()) as { response?: string };
      return body.response ?? '';
    },
    async pull(model: string, onProgress?: (p: PullProgress) => void): Promise<void> {
      // First streaming handler in this client. redirect:'error' as elsewhere —
      // a 307 from a hostile squatter must never re-send our request body.
      const res = await fetch(`${base}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true }),
        // Pulls stream for minutes over gigabytes; give a generous overall cap.
        signal: AbortSignal.timeout(60 * 60_000),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`Ollama pull returned HTTP ${res.status}.`);
      if (!res.body) throw new Error('Ollama pull returned no response body.');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const drain = (chunk: string): void => {
        buffer += chunk;
        // Emit every COMPLETE line; the partial tail stays buffered across chunks.
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const progress = parseOllamaProgressLine(line);
          if (progress) onProgress?.(progress);
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        drain(decoder.decode(value, { stream: true }));
      }
      drain(decoder.decode()); // flush any multi-byte remainder
      const tail = parseOllamaProgressLine(buffer); // final line without a newline
      if (tail) onProgress?.(tail);
    },
  };
}

/**
 * Distinguish the three states the GUI/CLI must tell apart (M9c): Ollama is not
 * installed/running, is running but has no models, or is ready with ≥1 model.
 * The primary signal is the loopback connection itself — a refused/failed fetch
 * means not-installed (a stopped daemon reads the same, which is fine: the
 * remedy surface is identical). Reachable → count models. Loopback-locked.
 */
export async function ollamaState(): Promise<'not-installed' | 'no-models' | 'ready'> {
  const base = ollamaUrl();
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!res.ok) return 'no-models'; // reachable daemon, unexpected reply — not "uninstalled"
    const body = (await res.json()) as { models?: unknown };
    const count = Array.isArray(body.models) ? body.models.length : 0;
    return count > 0 ? 'ready' : 'no-models';
  } catch {
    // ECONNREFUSED / DNS / timeout — the port isn't answering: treat as absent.
    return 'not-installed';
  }
}
