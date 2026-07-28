import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret } from '@northkeep/core';
import {
  assertConnectorUrl,
  connectorConfigPath,
  foldSidecarScopesIntoVault,
  loadConnectorConfig,
  setConnectorServer,
} from '../src/connector-config.js';

// Each test runs with an isolated NORTHKEEP_HOME so the sidecar never touches the
// real home dir.
let home = '';
const priorHome = process.env.NORTHKEEP_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-conncfg-'));
  process.env.NORTHKEEP_HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function makeVault(): Vault {
  return Vault.create({
    path: path.join(home, 'vault.nkv'),
    passphrase: 'test passphrase',
    deviceSecret: generateDeviceSecret(),
    kdf: KDF_INTERACTIVE,
  });
}

describe('assertConnectorUrl', () => {
  it('accepts https and loopback http, rejects public http and junk', () => {
    expect(() => assertConnectorUrl('https://connector.example.com')).not.toThrow();
    expect(() => assertConnectorUrl('http://127.0.0.1:3000')).not.toThrow();
    expect(() => assertConnectorUrl('http://localhost:3000')).not.toThrow();
    expect(() => assertConnectorUrl('http://connector.example.com')).toThrow(/https/);
    expect(() => assertConnectorUrl('ftp://x')).toThrow(/https/);
    expect(() => assertConnectorUrl('not a url')).toThrow(/valid connector server/);
  });
});

describe('connector sidecar config (server URL only, ADR 0038)', () => {
  it('starts empty, then set round-trips through the 0600 file', () => {
    expect(loadConnectorConfig()).toBeNull();

    const set = setConnectorServer('https://connector.example.com/');
    expect(set.server).toBe('https://connector.example.com'); // trailing slash trimmed
    expect(loadConnectorConfig()).toEqual({ server: 'https://connector.example.com' });
    // File is created 0600 (no secrets, but same posture as sync.json).
    expect(fs.statSync(connectorConfigPath()).mode & 0o777).toBe(0o600);
  });

  it('the config type no longer carries a scope list', () => {
    setConnectorServer('https://connector.example.com');
    const cfg = loadConnectorConfig();
    expect(cfg).not.toBeNull();
    expect('sharedScopes' in (cfg as object)).toBe(false);
  });

  it('setting the server preserves an unmigrated legacy sharedScopes key verbatim', () => {
    // A pre-0038 file: rewriting it on a server change must NOT drop the list
    // before foldSidecarScopesIntoVault gets to move it into the vault.
    fs.mkdirSync(path.dirname(connectorConfigPath()), { recursive: true });
    fs.writeFileSync(
      connectorConfigPath(),
      `${JSON.stringify({ server: 'https://a.example.com', sharedScopes: ['work'] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    setConnectorServer('https://b.example.com');
    const raw = JSON.parse(fs.readFileSync(connectorConfigPath(), 'utf8')) as Record<string, unknown>;
    expect(raw.server).toBe('https://b.example.com');
    expect(raw.sharedScopes).toEqual(['work']);
  });
});

describe('foldSidecarScopesIntoVault (one-time migration, ADR 0038)', () => {
  it('moves a legacy list into the vault, strips the key, and never runs twice', () => {
    fs.mkdirSync(path.dirname(connectorConfigPath()), { recursive: true });
    fs.writeFileSync(
      connectorConfigPath(),
      `${JSON.stringify({ server: 'https://a.example.com', sharedScopes: ['work', 'clients', 'work'] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const vault = makeVault();
    expect(foldSidecarScopesIntoVault(vault).folded).toEqual(['clients', 'work']);
    expect(vault.sharedScopes()).toEqual(['clients', 'work']);

    // The key is gone from the file, so the fold cannot re-assert later.
    const raw = JSON.parse(fs.readFileSync(connectorConfigPath(), 'utf8')) as Record<string, unknown>;
    expect('sharedScopes' in raw).toBe(false);
    expect(raw.server).toBe('https://a.example.com');

    // Second run is a no-op — in particular it cannot resurrect a revoked share.
    vault.setScopeShared('work', false);
    expect(foldSidecarScopesIntoVault(vault).folded).toEqual([]);
    expect(vault.sharedScopes()).toEqual(['clients']);
    vault.close();
  });

  it('is additive only: folding never unmarks a scope already shared in the vault', () => {
    fs.mkdirSync(path.dirname(connectorConfigPath()), { recursive: true });
    fs.writeFileSync(
      connectorConfigPath(),
      `${JSON.stringify({ server: 'https://a.example.com', sharedScopes: ['clients'] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const vault = makeVault();
    vault.setScopeShared('work', true); // marked in the vault, absent from the sidecar
    foldSidecarScopesIntoVault(vault);
    expect(vault.sharedScopes()).toEqual(['clients', 'work']);
    vault.close();
  });

  it('no sidecar / no legacy key / junk entries are all safe no-ops', () => {
    const vault = makeVault();
    expect(foldSidecarScopesIntoVault(vault).folded).toEqual([]); // no file at all

    setConnectorServer('https://a.example.com'); // modern file, no legacy key
    expect(foldSidecarScopesIntoVault(vault).folded).toEqual([]);

    fs.writeFileSync(
      connectorConfigPath(),
      `${JSON.stringify({ server: 'https://a.example.com', sharedScopes: ['ok', 7, '', '  '] }, null, 2)}\n`,
    );
    expect(foldSidecarScopesIntoVault(vault).folded).toEqual(['ok']); // non-strings and blanks dropped
    expect(vault.sharedScopes()).toEqual(['ok']);
    vault.close();
  });
});
