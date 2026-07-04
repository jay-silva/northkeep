import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * M0 acceptance, per 04-CLAUDE-CODE-KICKOFF.md:
 *   1. init creates an encrypted vault
 *   2. wrong passphrase fails cleanly
 *   3. remember/list round-trips all five types
 *   4. export matches the schema spec
 *   5. the vault file contains no plaintext (grep test)
 * Runs the real built CLI in a temp NORTHKEEP_HOME with production crypto cost.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const PASSPHRASE = 'e2e test passphrase';

// Distinctive markers that must NEVER appear in the vault file bytes.
const MARKERS = {
  ssn: '000-12-3456',
  name: 'Roberta Plaintext-Henderson',
  scope: 'client:henderson-e2e',
  apiKey: 'sk-fake-4242424242424242',
};

let home: string;
let vaultPath: string;

function cli(
  args: string[],
  options: { passphrase?: string; expectFailure?: boolean } = {},
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        NORTHKEEP_HOME: home,
        NORTHKEEP_PASSPHRASE: options.passphrase ?? PASSPHRASE,
      },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const failure = err as { status: number | null; stdout: string; stderr: string };
    if (!options.expectFailure) {
      throw new Error(`CLI failed unexpectedly: ${failure.stderr || failure.stdout}`);
    }
    return {
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
      status: failure.status ?? -1,
    };
  }
}

beforeAll(() => {
  expect(fs.existsSync(cliPath), `CLI not built at ${cliPath} — run pnpm build first`).toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-e2e-'));
  vaultPath = path.join(home, 'vault.nkv');
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('M0 acceptance', () => {
  it('1. init creates an encrypted vault and a device secret', () => {
    const result = cli(['init']);
    expect(result.stdout).toContain('Vault created');
    expect(result.stdout).toContain('BACK UP YOUR DEVICE SECRET');
    expect(fs.existsSync(vaultPath)).toBe(true);
    expect(fs.existsSync(path.join(home, 'device.secret'))).toBe(true);

    const bytes = fs.readFileSync(vaultPath);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('NKV1');
    expect(bytes.includes(Buffer.from('SQLite format 3'))).toBe(false);
  });

  it('1b. init refuses to overwrite an existing vault', () => {
    const result = cli(['init'], { expectFailure: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exists/);
  });

  it('2. wrong passphrase fails cleanly — one friendly line, no stack trace', () => {
    const result = cli(['list'], { passphrase: 'totally wrong passphrase', expectFailure: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Could not unlock vault/);
    expect(result.stderr).not.toMatch(/at .*\.js:\d+/); // no stack frames
    expect(result.stdout).toBe('');
  });

  it('3. remember/list round-trips all five memory types', () => {
    const memories: Array<[string, string, string]> = [
      ['episodic', `On 2026-07-04 discussed the custody filing with ${MARKERS.name}`, MARKERS.scope],
      ['semantic', `The client's SSN is ${MARKERS.ssn}`, MARKERS.scope],
      ['procedural', 'Draft letters in a formal register, no bullet points', 'work'],
      ['working', `This week: rotate the leaked key ${MARKERS.apiKey}`, 'work'],
      ['identity', 'Jay is a compliance professional and EMS lieutenant', 'personal'],
    ];
    for (const [type, content, scope] of memories) {
      const result = cli(['remember', content, '--type', type, '--scope', scope]);
      expect(result.stdout).toMatch(new RegExp(`Remembered \\[${type} / ${scope}\\]`));
    }

    const list = cli(['list']);
    for (const [, content] of memories) {
      expect(list.stdout).toContain(content);
    }
    expect(list.stdout).toContain('5 memories.');
    expect(list.stdout).toContain('Provenance chain verified');

    const filtered = cli(['list', '--type', 'semantic', '--scope', MARKERS.scope]);
    expect(filtered.stdout).toContain(MARKERS.ssn);
    expect(filtered.stdout).toContain('1 memory.');
  });

  it('3b. remember rejects an invalid type', () => {
    const result = cli(['remember', 'x', '--type', 'opinions'], { expectFailure: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid memory type/);
  });

  it('4. export matches SPEC/memory-schema.md', () => {
    const result = cli(['export']);
    const doc = JSON.parse(result.stdout) as {
      northkeep_export: Record<string, string>;
      memories: Array<Record<string, unknown>>;
    };

    expect(doc.northkeep_export.schema_version).toBe('0.1');
    expect(doc.northkeep_export.vault_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc.northkeep_export.chain_head).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.northkeep_export.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(doc.memories).toHaveLength(5);

    let prevHash = '0'.repeat(64);
    for (const memory of doc.memories) {
      expect(memory).toHaveProperty('id');
      expect(memory).toHaveProperty('type');
      expect(memory).toHaveProperty('content');
      expect(memory).toHaveProperty('scope');
      const provenance = memory.provenance as Record<string, unknown>;
      for (const field of ['source', 'source_model', 'confidence', 'created_at', 'prev_hash', 'entry_hash']) {
        expect(provenance).toHaveProperty(field);
      }
      const validity = memory.validity as Record<string, unknown>;
      for (const field of ['valid_from', 'superseded_at', 'superseded_by']) {
        expect(validity).toHaveProperty(field);
      }
      // Export is chain-ordered and internally linked.
      expect(provenance.prev_hash).toBe(prevHash);
      prevHash = provenance.entry_hash as string;
    }
    expect(prevHash).toBe(doc.northkeep_export.chain_head);

    // Embeddings are cache and must never appear in an export.
    expect(result.stdout).not.toContain('"embeddings"');
  });

  it('5. grep test — no plaintext in the vault file (or its backup)', () => {
    for (const file of [vaultPath, `${vaultPath}.bak`]) {
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file);
      for (const [label, marker] of Object.entries(MARKERS)) {
        expect(bytes.includes(Buffer.from(marker, 'utf8')), `${label} leaked into ${file}`).toBe(
          false,
        );
      }
      expect(bytes.includes(Buffer.from('SQLite format 3'))).toBe(false);
    }
  });
});
