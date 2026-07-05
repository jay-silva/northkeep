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

export interface OllamaClient {
  /** True when Ollama is reachable AND the extraction model is pulled. */
  available(): Promise<boolean>;
  /** Generate with format=json; returns the raw response text. */
  generateJson(prompt: string): Promise<string>;
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
  };
}
