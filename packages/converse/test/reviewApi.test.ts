import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createReviewApiGenerator,
  listReviewApiEndpoints,
  type EndpointConfig,
} from '../src/index.js';

const LOOPBACK: EndpointConfig = {
  id: 'local-ollama',
  label: 'Local Ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen2.5:14b',
  kind: 'openai-compatible',
  hasKey: false,
};

const LAN: EndpointConfig = {
  id: 'lan-box',
  label: 'LAN box',
  baseUrl: 'http://192.168.1.10:11434',
  model: 'qwen2.5:14b',
  kind: 'openai-compatible',
  hasKey: false,
};

const CLOUD: EndpointConfig = {
  id: 'openai-test',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-4o-mini',
  kind: 'openai-compatible',
  hasKey: true,
};

function writeProviders(home: string, endpoints: EndpointConfig[]): void {
  fs.writeFileSync(
    path.join(home, 'providers.json'),
    `${JSON.stringify({ endpoints }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

describe('listReviewApiEndpoints', () => {
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-api-'));
    process.env.NORTHKEEP_HOME = home;
    process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('excludes loopback and LAN, keeps a public https endpoint', () => {
    writeProviders(home, [LOOPBACK, LAN, CLOUD]);
    const listed = listReviewApiEndpoints();
    expect(listed.map((e) => e.id)).toEqual(['openai-test']);
    expect(listed[0]!.baseUrl).toBe('https://api.openai.com');
  });
});

describe('createReviewApiGenerator', () => {
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-api-gen-'));
    process.env.NORTHKEEP_HOME = home;
    process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    vi.unstubAllGlobals();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('throws on a loopback endpoint', () => {
    expect(() => createReviewApiGenerator(LOOPBACK)).toThrow(
      /That endpoint is local\. Use Review pass for on-device models\./,
    );
  });

  it('refuses when no API key is stored', () => {
    expect(() => createReviewApiGenerator(CLOUD)).toThrow(/No API key is stored/);
  });

  // A live generateJson against Jay's xAI endpoint was skipped here (no CI
  // cloud call; no vault contents). The fetch stub below mirrors the
  // openai-compatible non-SSE JSON reply shape.
  it('omits tools from the wire body and strips markdown fences', async () => {
    process.env.NORTHKEEP_PROVIDER_KEY_OPENAI_TEST = 'sk-test-not-a-real-key';
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      async (_input: unknown, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '```json\n{"proposals":[]}\n```' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );
    const gen = createReviewApiGenerator(CLOUD);
    const text = await gen.generateJson('{"planted":true}');
    expect(text).toBe('{"proposals":[]}');
    expect(bodies).toHaveLength(1);
    const wire = bodies[0] as Record<string, unknown>;
    expect(wire).not.toHaveProperty('tools');
    expect(JSON.stringify(wire)).not.toContain('"tools"');
  });
});
