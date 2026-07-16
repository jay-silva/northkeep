import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSharedScope,
  assertConnectorUrl,
  connectorConfigPath,
  loadConnectorConfig,
  removeSharedScope,
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

describe('connector sidecar config', () => {
  it('starts empty, then set/add/remove round-trips through the 0600 file', () => {
    expect(loadConnectorConfig()).toBeNull();

    const set = setConnectorServer('https://connector.example.com/');
    expect(set.server).toBe('https://connector.example.com'); // trailing slash trimmed
    expect(set.sharedScopes).toEqual([]);
    // File is created 0600 (no secrets, but same posture as sync.json).
    expect(fs.statSync(connectorConfigPath()).mode & 0o777).toBe(0o600);

    addSharedScope('work');
    addSharedScope('work'); // idempotent
    addSharedScope('clients');
    const afterAdd = loadConnectorConfig();
    expect(afterAdd?.sharedScopes).toEqual(['clients', 'work']); // deduped + sorted

    removeSharedScope('work');
    expect(loadConnectorConfig()?.sharedScopes).toEqual(['clients']);
  });

  it('setting the server keeps already-shared scopes', () => {
    setConnectorServer('https://a.example.com');
    addSharedScope('work');
    const moved = setConnectorServer('https://b.example.com');
    expect(moved.server).toBe('https://b.example.com');
    expect(moved.sharedScopes).toEqual(['work']);
  });

  it('addSharedScope refuses when no server is configured', () => {
    expect(() => addSharedScope('work')).toThrow(/connector server/i);
  });
});
