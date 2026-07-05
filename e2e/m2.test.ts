import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * M2 acceptance: the real CLI imports a real-shaped ChatGPT export ZIP.
 * A fake Ollama on localhost plays the extraction model (CI needs no 2GB
 * model); a separate case proves the loud degraded path without it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const PASSPHRASE = 'm2 e2e passphrase';

let home: string;
let zipPath: string;
let fakeOllama: http.Server;
let fakeOllamaUrl: string;

/**
 * ASYNC on purpose: this test process hosts the fake Ollama server, and a
 * synchronous spawn would block the event loop — the server could never
 * answer the CLI child (deadlock → import silently degrades to heuristic).
 */
function cli(
  args: string[],
  env: Record<string, string> = {},
  options: { expectFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          NORTHKEEP_HOME: home,
          NORTHKEEP_PASSPHRASE: PASSPHRASE,
          NORTHKEEP_NO_KEYCHAIN: '1',
          ...env,
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, status: 0 });
          return;
        }
        if (!options.expectFailure) {
          reject(new Error(`CLI failed: ${stderr || stdout}`));
          return;
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          status: (error as { code?: number }).code ?? -1,
        });
      },
    );
  });
}

beforeAll(async () => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-m2-'));
  await cli(['init']);

  // Real-shaped ChatGPT export: conversations.json inside a ZIP.
  const conversations = [
    makeConversation('conv-1', 'STR shopping', [
      "I own a short-term rental in Dartmouth and I'm hunting for a second one with wow factor.",
    ]),
    makeConversation('conv-2', 'Coffee', ['I take my coffee black, remember that.']),
    makeConversation('conv-3', 'Coffee again', ['Reminder: I take my coffee black.']),
  ];
  const jsonPath = path.join(home, 'conversations.json');
  fs.writeFileSync(jsonPath, JSON.stringify(conversations));
  zipPath = path.join(home, 'chatgpt-export.zip');
  execFileSync('zip', ['-j', '-q', zipPath, jsonPath]);
  fs.rmSync(jsonPath);

  // Fake Ollama: echoes a canned extraction derived from the prompt's title.
  fakeOllama = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }));
        return;
      }
      const prompt = (JSON.parse(body || '{}') as { prompt?: string }).prompt ?? '';
      const memories = prompt.includes('STR shopping')
        ? [
            { type: 'semantic', content: 'The user owns a short-term rental in Dartmouth.', confidence: 0.9 },
            { type: 'semantic', content: 'The user wants a second rental with wow factor.', confidence: 0.8 },
          ]
        : [{ type: 'procedural', content: 'The user takes their coffee black.', confidence: 0.9 }];
      res.end(JSON.stringify({ response: JSON.stringify({ memories }) }));
    });
  });
  await new Promise<void>((resolve) => fakeOllama.listen(0, '127.0.0.1', resolve));
  const address = fakeOllama.address() as { port: number };
  fakeOllamaUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  await new Promise((resolve) => fakeOllama.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});

describe('M2 acceptance — importers', () => {
  it('dry-run extracts and dedupes but writes nothing', async () => {
    const result = await cli(['import', 'chatgpt', zipPath, '--dry-run'], {
      NORTHKEEP_OLLAMA_URL: fakeOllamaUrl,
    });
    expect(result.stdout).toContain('Found 3 conversations');
    expect(result.stdout).toContain('memory candidates');
    expect(result.stdout).toContain('duplicates dropped'); // conv-2/conv-3 collapse
    expect(result.stdout).toContain('Dry run — nothing was written');
    expect(result.stdout).not.toContain('DEGRADED');
    expect((await cli(['list'])).stdout).toContain('No memories found');
  });

  it('imports with --yes: vault populated with provenance, chain verified', async () => {
    const result = await cli(['import', 'chatgpt', zipPath, '--yes'], {
      NORTHKEEP_OLLAMA_URL: fakeOllamaUrl,
    });
    expect(result.stdout).toMatch(/Imported 3 memories/);
    expect(result.stdout).toContain('Provenance chain verified');

    const list = (await cli(['list'])).stdout;
    expect(list).toContain('short-term rental in Dartmouth');
    expect(list).toContain('coffee black');
    expect(list).toContain('source import:chatgpt');
    expect(list).toContain('3 memories.');

    const exported = JSON.parse((await cli(['export'])).stdout) as {
      memories: Array<{ provenance: { source: string; source_model: string }; metadata: { conversation_title?: string } | null }>;
    };
    expect(exported.memories[0]!.provenance.source).toBe('import:chatgpt');
    expect(exported.memories[0]!.metadata?.conversation_title).toBeDefined();
  });

  it('re-import is idempotent: everything dedupes against the vault', async () => {
    const result = await cli(['import', 'chatgpt', zipPath, '--yes'], {
      NORTHKEEP_OLLAMA_URL: fakeOllamaUrl,
    });
    expect(result.stdout).toMatch(/duplicates dropped/);
    expect((await cli(['list'])).stdout).toContain('3 memories.');
  });

  it('degrades LOUDLY without Ollama and still extracts heuristically', async () => {
    const result = await cli(['import', 'chatgpt', zipPath, '--dry-run'], {
      NORTHKEEP_OLLAMA_URL: 'http://127.0.0.1:9', // nothing listens on port 9
    });
    expect(result.stdout).toContain('DEGRADED EXTRACTION');
    expect(result.stdout).toContain('memory candidates');
  });

  it('refuses a non-loopback Ollama URL outright', async () => {
    const result = await cli(
      ['import', 'chatgpt', zipPath, '--dry-run'],
      { NORTHKEEP_OLLAMA_URL: 'http://evil.example.com:11434' },
      { expectFailure: true },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('never leaves this machine');
  });

  it('paste flow: prompt output round-trips into candidates', async () => {
    const pasteFile = path.join(home, 'gemini-said.md');
    fs.writeFileSync(
      pasteFile,
      '- [identity] The user is a firefighter and paramedic.\n- [semantic] The user has two kids.\n',
    );
    const result = await cli(['import', 'paste', pasteFile, '--yes']);
    expect(result.stdout).toMatch(/Imported 2 memories/);
    expect((await cli(['list'])).stdout).toContain('firefighter');
  });
});

function makeConversation(id: string, title: string, userTexts: string[]): unknown {
  const mapping: Record<string, unknown> = {
    root: { id: 'root', message: null, parent: null, children: ['u0'] },
  };
  let prev = 'root';
  let last = 'root';
  userTexts.forEach((text, index) => {
    const uid = `u${index}`;
    const aid = `a${index}`;
    mapping[uid] = {
      id: uid,
      message: { author: { role: 'user' }, content: { content_type: 'text', parts: [text] } },
      parent: prev,
      children: [aid],
    };
    mapping[aid] = {
      id: aid,
      message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Noted.'] } },
      parent: uid,
      children: [],
    };
    prev = aid;
    last = aid;
  });
  return { conversation_id: id, title, create_time: 1750000000, mapping, current_node: last };
}
