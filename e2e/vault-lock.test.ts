import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vault, deriveMasterKey, loadDeviceSecret } from '@northkeep/core';

/**
 * ADR 0097 acceptance test: real processes on a temp home. A holder script on
 * the built core holds the vault lock while the real CLI tries to save and to
 * read. Fictional data only.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const coreDist = path.join(repoRoot, 'packages', 'core', 'dist', 'index.js');
const nodeDist = path.join(repoRoot, 'packages', 'platform-node', 'dist', 'index.js');
const PASSPHRASE = 'adr 0097 lock e2e passphrase';
const BUSY = 'Vault is locked by another NorthKeep process';
const CHANGED = 'VaultChangedError: The vault changed while this was running. Nothing was saved. Try again.';

let home = '';
let key = '';
let script = '';
const children: ChildProcess[] = [];

const vaultPath = () => path.join(home, 'vault.nkv');
const lockPath = () => `${vaultPath()}.lock`;
const env = () => ({ PATH: process.env.PATH ?? '', NORTHKEEP_HOME: home, NORTHKEEP_NO_KEYCHAIN: '1', NORTHKEEP_MASTER_KEY: key });
const cli = (...args: string[]) => spawnSync(process.execPath, [cliPath, ...args], { env: env(), encoding: 'utf8' });
const save = (content: string) => cli('remember', content, '--type', 'semantic');
/** Every memory in the vault file, read fresh. */
const contents = (): string[] => {
  const v = Vault.openWithKey(vaultPath(), Buffer.from(key, 'hex'));
  try {
    return v.list().map((e) => e.content).sort();
  } finally {
    v.close();
  }
};

const waitFor = async (file: string): Promise<string> => {
  for (let i = 0; i < 600; i++) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
};

/** A separate process that takes the lock, opens the vault, adds one memory, then saves when told to. */
function holder(name: string, content: string) {
  let out = '';
  const child = spawn(process.execPath, [script, vaultPath(), key, content, home, name], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return {
    opened: async () => Number(await waitFor(path.join(home, `${name}.opened`))),
    saveNow: async () => {
      fs.writeFileSync(path.join(home, `${name}.go`), '');
      await exited;
      return out.trim();
    },
  };
}

beforeAll(() => {
  for (const built of [cliPath, coreDist, nodeDist]) expect(fs.existsSync(built), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-0097-e2e-'));
  process.env.NORTHKEEP_HOME = home;
  execFileSync(process.execPath, [cliPath, 'init'], { env: { ...process.env, NORTHKEEP_HOME: home, NORTHKEEP_PASSPHRASE: PASSPHRASE }, stdio: 'ignore' });
  const header = Vault.readHeader(vaultPath());
  key = deriveMasterKey(PASSPHRASE, loadDeviceSecret(), header.salt, header.kdf).toString('hex');
  script = path.join(home, 'holder.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
import path from 'node:path';
import { Vault, withFileLock, setPlatform } from ${JSON.stringify(pathToFileURL(coreDist).href)};
import { nodePlatform } from ${JSON.stringify(pathToFileURL(nodeDist).href)};
setPlatform(nodePlatform());
const [vaultPath, keyHex, content, dir, name] = process.argv.slice(2);
await withFileLock(vaultPath, async () => {
  const v = Vault.openWithKey(vaultPath, Buffer.from(keyHex, 'hex'));
  v.remember({ content, type: 'semantic', scope: 'personal' });
  fs.writeFileSync(path.join(dir, name + '.opened'), String(process.pid));
  while (!fs.existsSync(path.join(dir, name + '.go'))) await new Promise((r) => setTimeout(r, 50));
  try {
    v.save();
    console.log('SAVED');
  } catch (err) {
    console.log(err.name + ': ' + err.message);
  } finally {
    v.close();
  }
});
`,
  );
}, 120_000);

afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
  delete process.env.NORTHKEEP_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ADR 0097: the vault lock across real processes', () => {
  it('a running holder keeps the vault past the old 60 second limit; a save and a read are told it is busy; nothing is missing', async () => {
    const before = contents();
    const first = holder('h1', 'Held by the first app');
    const pid = await first.opened();
    // The lock now looks five minutes old: before ADR 0097 the next caller took it over.
    const old = new Date(Date.now() - 300_000);
    fs.utimesSync(lockPath(), old, old);

    const blockedSave = save('From the second app');
    const blockedRead = cli('list');
    expect([blockedSave.status, blockedRead.status]).toEqual([1, 1]);
    expect(blockedSave.stderr).toContain(BUSY);
    expect(blockedSave.stderr).toContain(`It is held by process ${pid} (node)`);
    expect(blockedRead.stderr).toContain(BUSY);

    expect(await first.saveNow()).toBe('SAVED');
    expect(fs.existsSync(lockPath())).toBe(false);
    const retried = save('From the second app');
    expect(retried.status, retried.stderr).toBe(0);
    expect(contents()).toEqual([...before, 'From the second app', 'Held by the first app'].sort());
  }, 120_000);

  it('the lock file is deleted by hand and a newcomer saves first: the holder is refused and the newcomer\'s memory survives', async () => {
    const before = contents();
    const stale = holder('h2', 'Written by the holder that lost the vault');
    await stale.opened();
    fs.rmSync(lockPath());
    const newcomer = save('Written by the newcomer');
    expect(newcomer.status, newcomer.stderr).toBe(0);

    expect(await stale.saveNow()).toBe(CHANGED);
    expect(contents()).toEqual([...before, 'Written by the newcomer'].sort());
  }, 120_000);

  it('the lock file is deleted by hand and the holder saves first: the newcomer that opened before that save is refused', async () => {
    const before = contents();
    const first = holder('h3', 'Saved first by the holder');
    await first.opened();
    fs.rmSync(lockPath());
    const second = holder('n3', 'Opened before the holder saved');
    await second.opened();

    expect(await first.saveNow()).toBe('SAVED');
    expect(await second.saveNow()).toBe(CHANGED);
    expect(contents()).toEqual([...before, 'Saved first by the holder'].sort());
  }, 120_000);

  it('a dead lock is taken at once: an owner that has exited, and a lock from before the last start', () => {
    const before = contents();
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(lockPath(), `${gone} ${new Date().toISOString()} abc -\n`);
    const afterExit = save('Saved over an exited owner');
    expect(afterExit.status, afterExit.stderr).toBe(0);

    // This test process is alive, but the lock names another start of the machine.
    fs.writeFileSync(lockPath(), `${process.pid} ${new Date().toISOString()} abc 00000000-0000-4000-8000-000000000000\n`);
    const afterRestart = save('Saved over a lock from before a restart');
    expect(afterRestart.status, afterRestart.stderr).toBe(0);
    expect(contents()).toEqual([...before, 'Saved over a lock from before a restart', 'Saved over an exited owner'].sort());
  }, 120_000);

  it('a lock with no readable owner blocks while fresh and is taken once it is 60 seconds old', () => {
    const before = contents();
    fs.writeFileSync(lockPath(), '');
    const fresh = save('Blocked by an empty lock');
    expect(fresh.status).toBe(1);
    expect(fresh.stderr).toContain(BUSY);

    const old = new Date(Date.now() - 61_000);
    fs.utimesSync(lockPath(), old, old);
    const later = save('Saved once the empty lock aged out');
    expect(later.status, later.stderr).toBe(0);
    expect(contents()).toEqual([...before, 'Saved once the empty lock aged out'].sort());
  }, 120_000);

  it('six processes racing for one dead lock hold it one at a time', async () => {
    const racer = path.join(home, 'racer.mjs');
    const logFile = path.join(home, 'race.log');
    const target = path.join(home, 'race-target');
    fs.writeFileSync(
      racer,
      `import fs from 'node:fs';
import { withFileLock } from ${JSON.stringify(pathToFileURL(coreDist).href)};
const [target, logFile] = process.argv.slice(2);
await withFileLock(target, async () => {
  fs.appendFileSync(logFile, 'in ' + process.pid + '\\n');
  await new Promise((r) => setTimeout(r, 40));
  fs.appendFileSync(logFile, 'out ' + process.pid + '\\n');
}, { timeoutMs: 30000 });
`,
    );
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(`${target}.lock`, `${gone} ${new Date().toISOString()} abc -\n`);
    const codes = await Promise.all(
      Array.from({ length: 6 }, () => new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [racer, target, logFile], { env: env(), stdio: 'ignore' });
        children.push(child);
        child.on('exit', (code) => resolve(code));
      })),
    );
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(12);
    // Every 'in' is followed at once by the same process's 'out': no two were inside together.
    for (let i = 0; i < lines.length; i += 2) expect([lines[i]!.replace('in ', ''), lines[i]!.startsWith('in ')]).toEqual([lines[i + 1]!.replace('out ', ''), true]);
    expect(fs.readdirSync(home).filter((n) => n.startsWith('race-target'))).toEqual([]);
  }, 120_000);
});
