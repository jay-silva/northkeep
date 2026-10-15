import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireTokenStore } from '../src/tools/mcp/oauth.js';
import {
  credentialsOriginMatches,
  deleteCredentials,
  hasRemoteTokens,
  loadCredentials,
  saveCredentials,
  updateCredentials,
} from '../src/tools/mcp/tokens.js';

// ADR 0075. These use the real Keychain store, with a `security` that only logs
// its arguments first on PATH, so no case can reach the real Keychain.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let bin: string;
let log: string;
let saved: { PATH?: string; NORTHKEEP_NO_KEYCHAIN?: string };

beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-tokens-'));
  log = path.join(bin, 'security.log');
  fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 44\n`, { mode: 0o755 });
  saved = { PATH: process.env.PATH, NORTHKEEP_NO_KEYCHAIN: process.env.NORTHKEEP_NO_KEYCHAIN };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  Object.defineProperty(process, 'platform', { value: 'darwin' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(bin, { recursive: true, force: true });
});

describe('remote sign-ins with NORTHKEEP_NO_KEYCHAIN=1 on macOS', () => {
  it('never runs security to read, write or delete a sign-in', async () => {
    expect(loadCredentials('gmail')).toBeNull();
    expect(hasRemoteTokens('gmail')).toBe(false);
    expect(credentialsOriginMatches('gmail', 'https://gmailmcp.googleapis.com')).toBe(false);
    deleteCredentials('gmail');
    expect(() => saveCredentials('gmail', { origin: 'https://gmailmcp.googleapis.com' })).toThrow(/NORTHKEEP_NO_KEYCHAIN=1/);
    await expect(updateCredentials('gmail', () => ({ origin: 'https://gmailmcp.googleapis.com' }))).rejects.toThrow(
      /NORTHKEEP_NO_KEYCHAIN=1/,
    );
    expect(fs.existsSync(log)).toBe(false);
  });

  it('names the opt-out when connect is refused', () => {
    expect(() => requireTokenStore()).toThrow(
      'Remote MCP servers keep their sign-in in the macOS Keychain, and NORTHKEEP_NO_KEYCHAIN=1 turns the Keychain off for NorthKeep. Unset it to connect.',
    );
    expect(fs.existsSync(log)).toBe(false);
  });

  it('still reads the Keychain once the opt-out is cleared', () => {
    delete process.env.NORTHKEEP_NO_KEYCHAIN;
    expect(loadCredentials('gmail')).toBeNull();
    expect(fs.readFileSync(log, 'utf8')).toBe('find-generic-password -s northkeep-mcp-oauth -a gmail -w\n');
  });
});
