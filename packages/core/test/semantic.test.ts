import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import type { Embedder } from '../src/types.js';
import { Vault } from '../src/vault.js';

/**
 * Semantic (embedding-blended) retrieval. Uses an injected fake embedder so the
 * tests are deterministic and need no live Ollama. Vectors are hand-picked so
 * cosine geometry is obvious.
 */

const PASSPHRASE = 'a strong test passphrase';
const kdf = KDF_INTERACTIVE;

let dir: string;
let vaultPath: string;
let deviceSecret: Buffer;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-sem-'));
  vaultPath = path.join(dir, 'vault.nkv');
  deviceSecret = generateDeviceSecret();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function createVault(): Vault {
  return Vault.create({ path: vaultPath, passphrase: PASSPHRASE, deviceSecret, kdf });
}

/** Maps a text to a vector by first matching substring; default is orthogonal. */
function fakeEmbedder(map: Array<[string, number[]]>, model = 'fake-embed'): Embedder {
  return {
    model,
    async embed(text: string): Promise<number[]> {
      const lower = text.toLowerCase();
      for (const [needle, vec] of map) {
        if (lower.includes(needle)) return vec;
      }
      return [0, 0, 0, 1]; // unrelated axis
    },
  };
}

/** An embedder that is "down": every call rejects. */
const brokenEmbedder: Embedder = {
  model: 'broken',
  embed: () => Promise.reject(new Error('ollama not running')),
};

describe('retrieveSemantic (embedding-blended ranking)', () => {
  it('ranks the semantically-closer memory first even with no shared keywords', async () => {
    const vault = createVault();
    // Neither memory shares the word "car" — only meaning connects them.
    vault.remember({ content: 'I drive a vehicle to work', type: 'semantic' });
    vault.remember({ content: 'I enjoy cooking pasta on weekends', type: 'semantic' });

    const embedder = fakeEmbedder([
      ['car', [1, 0, 0, 0]],
      ['vehicle', [0.96, 0.28, 0, 0]], // close to "car"
      ['pasta', [0, 1, 0, 0]], // orthogonal to "car"
    ]);

    const out = await vault.retrieveSemantic('car', embedder);
    expect(out.mode).toBe('semantic');
    expect(out.semanticAvailable).toBe(true);
    expect(out.results.length).toBe(1); // pasta is below the semantic floor and has no keyword hit
    expect(out.results[0]!.entry.content).toContain('vehicle');
    vault.close();
  });

  it('falls back to keyword ranking (loudly) when the embedder is unavailable', async () => {
    const vault = createVault();
    vault.remember({ content: 'Jay owns a rental in Dartmouth', type: 'semantic' });
    vault.remember({ content: 'unrelated note about zebras', type: 'semantic' });

    const out = await vault.retrieveSemantic('rental', brokenEmbedder);
    expect(out.mode).toBe('keyword');
    expect(out.semanticAvailable).toBe(false);
    if (out.mode === 'keyword') expect(out.reason).toMatch(/unavailable/i);
    // Keyword path still works: the rental note matches, the zebra note doesn't.
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.entry.content).toContain('Dartmouth');
    vault.close();
  });

  it('honors the scope allowlist in semantic mode', async () => {
    const vault = createVault();
    vault.remember({ content: 'personal vehicle note', type: 'semantic', scope: 'personal' });
    vault.remember({ content: 'work vehicle note', type: 'semantic', scope: 'work' });
    // "car" ~ "vehicle" (same dimensionality as the other ranking tests), so both
    // notes are strong semantic hits — the allowlist is what limits it to 'work'.
    const embedder = fakeEmbedder([
      ['car', [1, 0, 0, 0]],
      ['vehicle', [0.96, 0.28, 0, 0]],
    ]);
    const out = await vault.retrieveSemantic('car', embedder, { allowedScopes: ['work'] });
    expect(out.results.every((s) => s.entry.scope === 'work')).toBe(true);
    expect(out.results).toHaveLength(1);
    vault.close();
  });

  it('never throws even if a candidate embedding fails mid-scan', async () => {
    const vault = createVault();
    vault.remember({ content: 'first fact about sailing', type: 'semantic' });
    vault.remember({ content: 'second fact about sailing', type: 'semantic' });

    // Query embeds fine; the per-candidate embed throws.
    let call = 0;
    const flaky: Embedder = {
      model: 'flaky',
      async embed(): Promise<number[]> {
        call += 1;
        if (call === 1) return [1, 0, 0]; // the query
        throw new Error('embed died on a candidate');
      },
    };
    const out = await vault.retrieveSemantic('sailing', flaky);
    expect(out.mode).toBe('keyword');
    expect(out.semanticAvailable).toBe(false);
    expect(out.results.length).toBeGreaterThan(0); // keyword still ranks both
    vault.close();
  });

  it('caches embeddings and regenerates after the cache is dropped', async () => {
    const vault = createVault();
    vault.remember({ content: 'a note about vehicles', type: 'semantic' });
    let embedCalls = 0;
    const counting: Embedder = {
      model: 'count',
      async embed(): Promise<number[]> {
        embedCalls += 1;
        // Vector value is irrelevant here — this test only asserts call counts
        // (cache hit vs. miss), so a constant unit vector keeps it honest.
        return [1, 0, 0];
      },
    };

    await vault.retrieveSemantic('vehicle', counting); // 1 query + 1 candidate = 2
    const afterFirst = embedCalls;
    expect(afterFirst).toBe(2);

    await vault.retrieveSemantic('vehicle', counting); // query re-embedded, candidate cached
    expect(embedCalls).toBe(afterFirst + 1); // only the query, candidate hit the cache

    vault.clearEmbeddingCache();
    await vault.retrieveSemantic('vehicle', counting); // cache gone -> candidate recomputed
    expect(embedCalls).toBe(afterFirst + 1 + 2);
    vault.close();
  });
});

describe('embeddings are disposable cache (invariant #4)', () => {
  it('export() is unchanged in shape and carries no embedding data', async () => {
    const vault = createVault();
    vault.remember({ content: 'exportable fact about vehicles', type: 'semantic' });
    const before = vault.export();

    await vault.retrieveSemantic('vehicle', fakeEmbedder([['vehicle', [1, 0, 0]]]));

    const after = vault.export();
    // The exported document is byte-identical except its timestamp.
    const norm = (e: ReturnType<Vault['export']>): unknown => ({
      ...e,
      northkeep_export: { ...e.northkeep_export, exported_at: 'X' },
    });
    expect(JSON.stringify(norm(after))).toBe(JSON.stringify(norm(before)));
    // And no vector/embedding leaks into the export payload.
    const blob = JSON.stringify(after);
    expect(blob).not.toMatch(/embedding|vector|"vec"/i);
    expect(after.memories).toHaveLength(1);
    vault.close();
  });

  it('leaves the provenance chain valid after embeddings are written', async () => {
    const vault = createVault();
    vault.remember({ content: 'chain check one', type: 'semantic' });
    vault.remember({ content: 'chain check two', type: 'episodic' });
    const headBefore = vault.export().northkeep_export.chain_head;

    await vault.retrieveSemantic('chain', fakeEmbedder([['chain', [1, 0, 0]]]));

    expect(vault.verifyChain().ok).toBe(true);
    // Writing cache must not advance or alter the hash chain head.
    expect(vault.export().northkeep_export.chain_head).toBe(headBefore);
    vault.close();
  });
});
