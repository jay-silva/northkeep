import { describe, expect, it } from 'vitest';
import type { ImportedConversation, MemoryCandidate } from '@northkeep/importers';
import type { MemoryEntry } from '@northkeep/core';
import { dedupeCandidates, jaccard, tokenize } from '../src/dedupe.js';
import { heuristicExtract, sanitizeCandidates } from '../src/extract.js';
import { runImport } from '../src/import.js';
import { ollamaUrl } from '../src/ollama.js';

function conversation(texts: string[]): ImportedConversation {
  return {
    id: 'conv-x',
    title: 'Test',
    source: 'chatgpt',
    created_at: null,
    messages: texts.map((text) => ({ role: 'user' as const, text, created_at: null })),
  };
}

function candidate(content: string, confidence = 0.8): MemoryCandidate {
  return { type: 'semantic', content, confidence, origin: { source: 'chatgpt' } };
}

function entry(content: string): MemoryEntry {
  return {
    id: 'e', type: 'semantic', content, scope: 'personal', source: 'cli',
    source_model: null, confidence: 1, created_at: '2026-01-01T00:00:00Z',
    valid_from: null, superseded_at: null, superseded_by: null, forgotten_at: null,
    prev_hash: '0'.repeat(64), entry_hash: '0'.repeat(64), metadata: null,
  };
}

describe('sanitizeCandidates', () => {
  const conv = conversation(['hello']);

  it('accepts well-formed model output', () => {
    const raw = JSON.stringify({
      memories: [{ type: 'identity', content: 'The user is a paramedic.', confidence: 0.9 }],
    });
    const result = sanitizeCandidates(raw, conv);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'identity', confidence: 0.9 });
    expect(result[0]!.origin.conversation_id).toBe('conv-x');
  });

  it('survives garbage: bad JSON, wrong shapes, out-of-range values', () => {
    expect(sanitizeCandidates('not json at all', conv)).toEqual([]);
    expect(sanitizeCandidates('{"memories": "nope"}', conv)).toEqual([]);
    const sloppy = JSON.stringify({
      memories: [
        { type: 'opinions', content: 'Unknown type becomes semantic.', confidence: 5 },
        { type: 'semantic', content: 'ok' }, // too short — dropped
        { content: 42 }, // not a string — dropped
        { type: 'semantic', content: 'x'.repeat(3000) }, // too long — dropped
      ],
    });
    const result = sanitizeCandidates(sloppy, conv);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'semantic', confidence: 0.5 });
  });

  it('strips terminal escape sequences so review shows what gets stored', () => {
    const sneaky = JSON.stringify({
      memories: [
        {
          type: 'semantic',
          content: 'Looks harmless\u001b[8m but this part renders invisible\u001b[0m in a terminal.',
          confidence: 0.9,
        },
      ],
    });
    const result = sanitizeCandidates(sneaky, conv);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).not.toMatch(/\u001b/);
    expect(result[0]!.content).toContain('but this part renders invisible');
  });

  it('caps candidates per conversation', () => {
    const many = JSON.stringify({
      memories: Array.from({ length: 20 }, (_, i) => ({
        type: 'semantic',
        content: `Distinct durable fact number ${i} about the user.`,
        confidence: 0.7,
      })),
    });
    expect(sanitizeCandidates(many, conv).length).toBeLessThanOrEqual(8);
  });
});

describe('heuristicExtract', () => {
  it('extracts first-person fact sentences with low confidence', () => {
    const result = heuristicExtract(
      conversation([
        'I own a short-term rental in Dartmouth. What is a cap rate?',
        'Please write a haiku about clouds.',
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ confidence: 0.4, type: 'semantic' });
    expect(result[0]!.content).toContain('short-term rental');
  });
});

describe('dedupe', () => {
  it('jaccard basics', () => {
    expect(jaccard(tokenize('the user takes coffee black'), tokenize('The user takes their coffee black.'))).toBeGreaterThan(0.6);
    expect(jaccard(tokenize('coffee black'), tokenize('owns rental property'))).toBe(0);
  });

  it('drops near-duplicates within a batch, keeping the higher confidence', () => {
    const result = dedupeCandidates(
      [
        candidate('The user takes their coffee black.', 0.6),
        candidate('The user takes coffee black.', 0.9),
        candidate('The user owns a rental property in Dartmouth.', 0.8),
      ],
      [],
    );
    expect(result.unique).toHaveLength(2);
    expect(result.duplicatesDropped).toBe(1);
    expect(result.unique[0]!.confidence).toBe(0.9);
  });

  it('drops candidates already in the vault and flags related-but-different ones', () => {
    const existing = [entry('The user takes their coffee black.'), entry('The user owns one rental property in New Bedford Massachusetts.')];
    const result = dedupeCandidates(
      [
        candidate('The user takes coffee black.'), // duplicate of vault entry
        candidate('The user owns three rental buildings in New Bedford Massachusetts.'), // related — possible conflict
      ],
      existing,
    );
    expect(result.duplicatesDropped).toBe(1);
    expect(result.unique).toHaveLength(1);
    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('runImport', () => {
  it('pools, dedupes, and reports degraded mode with a null ollama client', async () => {
    const result = await runImport(
      [conversation(['I always take my coffee black.']), conversation(['I always take my coffee black!'])],
      { existing: [], ollama: null },
    );
    expect(result.degraded).toBe(true);
    expect(result.conversationsProcessed).toBe(2);
    expect(result.candidates).toHaveLength(1); // deduped across conversations
    expect(result.duplicatesDropped).toBe(1);
  });

  it('uses an injected llm client and does not degrade', async () => {
    const fake = {
      available: async () => true,
      generateJson: async () =>
        JSON.stringify({ memories: [{ type: 'semantic', content: 'The user takes coffee black.', confidence: 0.9 }] }),
    };
    const result = await runImport([conversation(['I take my coffee black.'])], {
      existing: [],
      ollama: fake,
    });
    expect(result.degraded).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.confidence).toBe(0.9);
  });
});

describe('ollamaUrl loopback enforcement', () => {
  function withUrl(url: string, fn: () => void): void {
    const prev = process.env.NORTHKEEP_OLLAMA_URL;
    process.env.NORTHKEEP_OLLAMA_URL = url;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.NORTHKEEP_OLLAMA_URL;
      else process.env.NORTHKEEP_OLLAMA_URL = prev;
    }
  }

  it('refuses non-local URLs — plaintext never leaves the machine', () => {
    for (const url of [
      'http://evil.example.com:11434',
      'http://localhost@evil.com:11434', // userinfo trick — hostname is evil.com
      'http://127.0.0.1.evil.com:11434', // lookalike subdomain
    ]) {
      withUrl(url, () => expect(() => ollamaUrl(), url).toThrow(/never leaves this machine/));
    }
  });

  it('accepts genuine loopback forms', () => {
    for (const url of ['http://127.0.0.1:11434', 'http://localhost:9999', 'http://[::1]:11434']) {
      withUrl(url, () => expect(() => ollamaUrl(), url).not.toThrow());
    }
  });
});

describe('redirect hardening', () => {
  it('refuses to follow a redirect from a hostile local server', async () => {
    const http = await import('node:http');
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }));
        return;
      }
      // A 307 re-sends the POST body to Location — the exfiltration vector.
      res.statusCode = 307;
      res.setHeader('location', 'http://evil.example.com/steal');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const prev = process.env.NORTHKEEP_OLLAMA_URL;
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${port}`;
    try {
      const { createOllamaClient } = await import('../src/ollama.js');
      const client = createOllamaClient();
      await expect(client.generateJson('secret plaintext')).rejects.toThrow();
      expect(hits).toContain('/api/generate'); // it reached the hostile server…
      // …but the failure proves the body was never forwarded to Location.
    } finally {
      if (prev === undefined) delete process.env.NORTHKEEP_OLLAMA_URL;
      else process.env.NORTHKEEP_OLLAMA_URL = prev;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
