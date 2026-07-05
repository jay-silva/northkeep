import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEAK_CORPUS } from '../packages/redact/test/corpus.js';

/**
 * M3 acceptance, driven through the real CLI:
 *  - Tier-1 masks every seeded secret (the leak gate, end to end)
 *  - the pseudonym round-trip restores names via a saved map
 *  - degradation is loud
 * Tier-2 here uses a fake local Ollama (CI needs no model); a live model run
 * is covered manually.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

let dir: string;
let fakeOllama: import('node:http').Server;
let fakeUrl: string;

function cli(
  args: string[],
  opts: { stdin?: string; ollama?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      {
        env: {
          PATH: process.env.PATH ?? '',
          NORTHKEEP_NO_KEYCHAIN: '1',
          ...(opts.ollama ? { NORTHKEEP_OLLAMA_URL: opts.ollama } : { NORTHKEEP_OLLAMA_URL: 'http://127.0.0.1:9' }),
        },
        encoding: 'utf8',
      },
      (err, stdout, stderr) => (err && !stderr ? reject(err) : resolve({ stdout, stderr })),
    );
    if (opts.stdin !== undefined) {
      child.stdin!.write(opts.stdin);
      child.stdin!.end();
    }
  });
}

beforeAll(async () => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-m3-'));
  const http = await import('node:http');
  fakeOllama = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }));
        return;
      }
      res.end(JSON.stringify({
        response: JSON.stringify({
          entities: [
            { text: 'Bob Henderson', kind: 'person' },
            { text: 'Acme Corporation', kind: 'org' },
          ],
        }),
      }));
    });
  });
  await new Promise<void>((r) => fakeOllama.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fakeOllama.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => fakeOllama.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('M3 acceptance — redaction', () => {
  it('leak gate: the CLI masks every seeded secret (zero misses)', async () => {
    const blob = LEAK_CORPUS.map((s) => s.sentence).join(' ');
    const { stdout } = await cli(['redact', blob, '--tier', '1']);
    const leaked = LEAK_CORPUS.filter((s) => stdout.includes(s.secret)).map((s) => s.secret);
    expect(leaked, `leaked: ${leaked.join(', ')}`).toEqual([]);
  });

  it('reads from stdin too', async () => {
    const { stdout } = await cli(['redact'], { stdin: 'My SSN is 123-45-6789.' });
    expect(stdout).toContain('[SSN_1]');
    expect(stdout).not.toContain('123-45-6789');
  });

  it('Tier 2 pseudonymizes and round-trips through a saved map', async () => {
    const mapPath = path.join(dir, 'map.json');
    const redacted = await cli(
      ['redact', 'Letter to Bob Henderson at Acme Corporation, SSN 457-55-5462.', '--tier', '2', '--map', mapPath],
      { ollama: fakeUrl },
    );
    expect(redacted.stdout).toContain('Person-1');
    expect(redacted.stdout).toContain('Org-1');
    expect(redacted.stdout).not.toContain('Bob Henderson');
    expect(redacted.stdout).not.toContain('457-55-5462'); // Tier-1 still catches the SSN

    const restored = await cli(
      ['restore', 'Dear Person-1 at Org-1, confirmed.', '--map', mapPath],
    );
    expect(restored.stdout).toContain('Bob Henderson');
    expect(restored.stdout).toContain('Acme Corporation');
  });

  it('degrades LOUDLY to Tier 1 when the local model is unavailable', async () => {
    const { stdout, stderr } = await cli(
      ['redact', 'Letter to Bob Henderson.', '--tier', '2'], // no ollama override → port 9
    );
    expect(stderr).toContain('Tier 2 unavailable');
    expect(stdout).toContain('Bob Henderson'); // name NOT pseudonymized, and we said so
  });
});
