/**
 * Warm search-by-meaning when NorthKeep opens (owner decision 2026-09-12,
 * ADR 0049 addendum). Once the vault is unlocked: make sure the local runtime
 * is up (starting the installed Ollama app on desktop macOS through the same
 * gated path the Start button uses), then embed every searchable memory into
 * the process-level cache so the first search does not pay the ~20 s cost.
 *
 * Boundaries: the vault is opened only long enough to read contents; every
 * embedding call happens OUTSIDE the vault lock so sync and the MCP server are
 * never blocked. Embeddings go to the loopback embedder only. Nothing is
 * written. The pass stops as soon as the vault locks or the embedder fails,
 * and backs off before trying again so a stopped runtime is not hammered.
 */
export interface WarmDependencies {
  isUnlocked: () => boolean;
  /** Runtime and model availability, from the local-search status route. */
  status: () => Promise<{ runtime: string; embedding_model: string; can_start: boolean }>;
  /** Launch the runtime through the gated start route. Resolves when reachable. */
  start: () => Promise<void>;
  /** Contents of every live, non-project memory. Opens the vault briefly. */
  listContents: () => Promise<string[]>;
  embed: (text: string) => Promise<unknown>;
  now: () => number;
  retryAfterMs: number;
}

export type WarmState = 'idle' | 'running' | 'done';

export interface SearchWarmer {
  /** Kick a warm-up if one is due. Never throws; returns without waiting. */
  poke(): void;
  /** Forget everything (call on lock). */
  reset(): void;
  readonly state: WarmState;
  /** Resolves when the current pass settles; for tests. */
  settled(): Promise<void>;
}

export function createSearchWarmer(deps: WarmDependencies): SearchWarmer {
  let state: WarmState = 'idle';
  let notBefore = 0;
  let current: Promise<void> = Promise.resolve();

  const pass = async (): Promise<void> => {
    let finished = false;
    try {
      if (!deps.isUnlocked()) return;
      let info = await deps.status();
      if (info.runtime !== 'running') {
        if (!info.can_start) return;
        await deps.start();
        info = await deps.status();
        if (info.runtime !== 'running') return;
      }
      if (info.embedding_model !== 'installed') return;
      const contents = await deps.listContents();
      for (const text of contents) {
        if (!deps.isUnlocked()) return;
        await deps.embed(text);
      }
      finished = deps.isUnlocked();
    } catch {
      // A failed launch, a missing model, or an embedder error all mean "not now".
    } finally {
      if (finished) {
        state = 'done';
      } else {
        state = 'idle';
        notBefore = deps.now() + deps.retryAfterMs;
      }
    }
  };

  return {
    poke(): void {
      if (state !== 'idle') return;
      if (deps.now() < notBefore) return;
      if (!deps.isUnlocked()) return;
      state = 'running';
      current = pass();
    },
    reset(): void {
      state = 'idle';
      notBefore = 0;
    },
    get state(): WarmState {
      return state;
    },
    settled(): Promise<void> {
      return current;
    },
  };
}
