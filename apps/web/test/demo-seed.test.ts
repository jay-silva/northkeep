import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Vault, deriveMasterKey, loadDeviceSecret, setPlatform } from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'demo-seed.mjs');
const passphrase = 'lantern-hill-demo-only';
const homes: string[] = [];

function run(home: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      NORTHKEEP_HOME: home,
      NORTHKEEP_DEMO_PASSPHRASE: passphrase,
      NORTHKEEP_NO_KEYCHAIN: '1',
      NORTHKEEP_REDACT_TIER: '0',
      ...extra,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('pnpm demo:seed', () => {
  it('refuses to write without a home, and refuses a directory that already syncs', () => {
    const env = { ...process.env, NORTHKEEP_DEMO_PASSPHRASE: passphrase };
    delete env.NORTHKEEP_HOME;
    const missing = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('NORTHKEEP_HOME');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-demo-refuse-'));
    homes.push(home);
    fs.writeFileSync(path.join(home, 'sync.json'), '{}\n');
    const refused = run(home);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('sync.json');
    expect(fs.existsSync(path.join(home, 'vault.nkv'))).toBe(false);
  });

  it('creates fictional projects and memories through the server, then skips them on a second run', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-demo-seed-'));
    homes.push(home);
    const first = run(home);
    expect(first.status, first.stderr).toBe(0);
    const created = JSON.parse(first.stdout);
    expect(created.vault_created).toBe(true);
    expect(created.projects).toEqual(['lantern-gazette', 'glass-orchard', 'river-post']);
    expect(created.memories_written).toBe(3);
    expect(created.projects_written).toBe(3);
    expect(first.stdout).not.toContain(passphrase);

    const previousHome = process.env.NORTHKEEP_HOME;
    process.env.NORTHKEEP_HOME = home;
    setPlatform(nodePlatform());
    const vaultPath = path.join(home, 'vault.nkv');
    const header = Vault.readHeader(vaultPath);
    const key = deriveMasterKey(passphrase, loadDeviceSecret(), header.salt, header.kdf);
    const vault = Vault.openWithKey(vaultPath, key);
    try {
      const projects = vault.list({ type: 'working' }).map((entry) => entry.scope).sort();
      expect(projects).toEqual(['project:glass-orchard', 'project:lantern-gazette', 'project:river-post']);
      const memories = vault.list().filter((entry) => !entry.scope.startsWith('project:'));
      expect(memories.map((entry) => entry.content).every((content) => content.startsWith('[demo] '))).toBe(true);
      expect(memories).toHaveLength(3);
      const joined = memories.map((entry) => entry.content).join('\n');
      expect(joined).not.toMatch(/@/);
    expect(joined).not.toMatch(/sk-|AKIA/i);
    } finally {
      vault.close();
      if (previousHome === undefined) delete process.env.NORTHKEEP_HOME;
      else process.env.NORTHKEEP_HOME = previousHome;
    }

    const second = run(home);
    expect(second.status, second.stderr).toBe(0);
    const again = JSON.parse(second.stdout);
    expect(again.vault_created).toBe(false);
    expect(again.memories_written).toBe(0);
    expect(again.projects_written).toBe(0);
  }, 180_000);
});
