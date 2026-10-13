import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMasterKey } from '../src/key.js';
import {
  describeMasterKeyStore,
  keychainDeleteMasterKey,
  keychainGetMasterKey,
  keychainSetMasterKey,
  masterKeyFilePath,
  masterKeyStoreAvailable,
  resetMasterKeyStoreProbe,
} from '../src/keychain.js';

const KEY = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

let home: string;
let prevHome: string | undefined;
let prevBackend: string | undefined;
let prevNoKeychain: string | undefined;
let prevPath: string | undefined;
let prevUmask: number;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-key-'));
  prevHome = process.env.NORTHKEEP_HOME;
  prevBackend = process.env.NORTHKEEP_SECRET_BACKEND;
  prevNoKeychain = process.env.NORTHKEEP_NO_KEYCHAIN;
  prevPath = process.env.PATH;
  prevUmask = process.umask();
  process.env.NORTHKEEP_HOME = home;
  delete process.env.NORTHKEEP_SECRET_BACKEND;
  delete process.env.NORTHKEEP_NO_KEYCHAIN;
  delete process.env.NORTHKEEP_MASTER_KEY;
  delete process.env.NORTHKEEP_PASSPHRASE;
  resetMasterKeyStoreProbe();
});

afterEach(() => {
  process.umask(prevUmask);
  if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = prevHome;
  if (prevBackend === undefined) delete process.env.NORTHKEEP_SECRET_BACKEND;
  else process.env.NORTHKEEP_SECRET_BACKEND = prevBackend;
  if (prevNoKeychain === undefined) delete process.env.NORTHKEEP_NO_KEYCHAIN;
  else process.env.NORTHKEEP_NO_KEYCHAIN = prevNoKeychain;
  if (prevPath === undefined) delete process.env.PATH;
  else process.env.PATH = prevPath;
  resetMasterKeyStoreProbe();
  fs.rmSync(home, { recursive: true, force: true });
});

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe('linux file fallback', () => {
  beforeEach(() => {
    process.env.NORTHKEEP_SECRET_BACKEND = 'file';
  });

  it('stores the key at mode 0600 in the NorthKeep home even when umask is 0', () => {
    process.umask(0);
    keychainSetMasterKey(KEY);
    const filePath = masterKeyFilePath();
    expect(filePath).toBe(path.join(home, 'master.key'));
    expect(fs.readFileSync(filePath, 'utf8').trim()).toBe(KEY);
    expect(mode(filePath)).toBe(0o600);
    expect(mode(home)).toBe(0o700);
    const got = keychainGetMasterKey();
    expect(got?.toString('hex')).toBe(KEY);
    expect(keychainDeleteMasterKey()).toBe('removed');
    expect(fs.existsSync(filePath)).toBe(false);
    expect(keychainDeleteMasterKey()).toBe('not-found');
  });

  it('tightens a group-readable file before reading it', () => {
    const filePath = masterKeyFilePath();
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${KEY}\n`, { mode: 0o644 });
    expect(mode(filePath)).toBe(0o644);
    expect(keychainGetMasterKey()?.toString('hex')).toBe(KEY);
    expect(mode(filePath)).toBe(0o600);
  });

  it('does not follow a symlink to another file', () => {
    const target = path.join(home, 'elsewhere');
    fs.writeFileSync(target, `${OTHER}\n`, { mode: 0o600 });
    fs.symlinkSync(target, masterKeyFilePath());
    expect(keychainGetMasterKey()).toBeNull();
    expect(fs.readFileSync(target, 'utf8')).toContain(OTHER);

    keychainSetMasterKey(KEY);
    expect(fs.lstatSync(masterKeyFilePath()).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toContain(OTHER);
    expect(fs.readFileSync(masterKeyFilePath(), 'utf8').trim()).toBe(KEY);
  });

  it('rejects a malformed key before creating a file', () => {
    expect(() => keychainSetMasterKey('not-a-key')).toThrow(/Malformed master key/);
    expect(fs.existsSync(masterKeyFilePath())).toBe(false);
  });

  it('returns null for a malformed file and does not echo it', () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(masterKeyFilePath(), 'hello-not-a-key\n', { mode: 0o600 });
    expect(keychainGetMasterKey()).toBeNull();
  });

  it('refuses a data directory that is not a directory', () => {
    const blocker = path.join(home, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    process.env.NORTHKEEP_HOME = path.join(blocker, 'child');
    expect(() => keychainSetMasterKey(KEY)).toThrow(/data directory/);
    expect(String((() => {
      try {
        keychainSetMasterKey(KEY);
        return '';
      } catch (err) {
        return err instanceof Error ? err.message : '';
      }
    })())).not.toContain(KEY);
  });

  it('warns about the file store without including the key', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    keychainSetMasterKey(KEY);
    const text = spy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(text).toContain('not encrypted');
    expect(text).toContain(masterKeyFilePath());
    expect(text).not.toContain(KEY);
    expect(describeMasterKeyStore().warning).not.toContain(KEY);
    spy.mockRestore();
  });

  it('resolves a stored key for background unlock', () => {
    keychainSetMasterKey(KEY);
    const resolved = resolveMasterKey(path.join(home, 'vault.nkv'));
    expect(resolved?.source).toBe('keychain');
    expect(resolved?.key.toString('hex')).toBe(KEY);
  });
});

describe('secret service', () => {
  let bin: string;
  let logPath: string;
  let storePath: string;

  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-secret-tool-'));
    logPath = path.join(bin, 'argv.log');
    storePath = path.join(bin, 'store');
    const script = `#!/bin/sh
printf '%s\\n' "$@" >> "$SECRET_TOOL_LOG"
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "store" ]; then cat > "$SECRET_TOOL_STORE"; exit 0; fi
if [ "$1" = "lookup" ]; then
  if [ -f "$SECRET_TOOL_STORE" ]; then cat "$SECRET_TOOL_STORE"; echo; exit 0; fi
  exit 1
fi
if [ "$1" = "clear" ]; then rm -f "$SECRET_TOOL_STORE"; exit 0; fi
exit 2
`;
    fs.writeFileSync(path.join(bin, 'secret-tool'), script, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
    process.env.NORTHKEEP_SECRET_BACKEND = 'secret-service';
    process.env.SECRET_TOOL_LOG = logPath;
    process.env.SECRET_TOOL_STORE = storePath;
  });

  afterEach(() => {
    delete process.env.SECRET_TOOL_LOG;
    delete process.env.SECRET_TOOL_STORE;
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it('passes the key on stdin and never on argv', () => {
    keychainSetMasterKey(KEY);
    const argv = fs.readFileSync(logPath, 'utf8');
    expect(argv).not.toContain(KEY);
    expect(argv).toContain('store');
    expect(argv).toContain('northkeep-vault');
    expect(fs.readFileSync(storePath, 'utf8')).toBe(KEY);
    expect(keychainGetMasterKey()?.toString('hex')).toBe(KEY);
    expect(Object.values(process.env).join('\n')).not.toContain(KEY);

    fs.writeFileSync(masterKeyFilePath(), `${OTHER}\n`, { mode: 0o600 });
    expect(keychainDeleteMasterKey()).toBe('removed');
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.existsSync(masterKeyFilePath())).toBe(false);
  });

  it('removes a pre-existing file copy when the key moves to the Secret Service', () => {
    fs.writeFileSync(masterKeyFilePath(), `${OTHER}\n`, { mode: 0o600 });
    keychainSetMasterKey(KEY);
    expect(fs.existsSync(masterKeyFilePath())).toBe(false);
    expect(fs.readFileSync(storePath, 'utf8')).toBe(KEY);
  });

  it('reports not-found when lookup exits 1, and does not claim success if clear fails', () => {
    expect(keychainDeleteMasterKey()).toBe('not-found');
    fs.writeFileSync(
      path.join(bin, 'secret-tool'),
      `#!/bin/sh
if [ "$1" = "lookup" ]; then printf '%s\\n' "${KEY}"; exit 0; fi
exit 1
`,
      { mode: 0o755 },
    );
    expect(() => keychainDeleteMasterKey()).toThrow(/Secret Service/);
    try {
      keychainDeleteMasterKey();
    } catch (err) {
      expect(err instanceof Error ? err.message : '').not.toContain(KEY);
    }
  });
});

describe('store selection', () => {
  it('writes no file on Linux without a keyring unless the person opts in', () => {
    process.env.PATH = '/usr/bin:/bin';
    resetMasterKeyStoreProbe();
    if (process.platform !== 'linux') return;
    const before = describeMasterKeyStore();
    expect(before.backend).toBe('none');
    expect(before.file_opt_in).toBe(true);
    expect(masterKeyStoreAvailable()).toBe(false);
    expect(() => keychainSetMasterKey(KEY)).toThrow(/--allow-key-file/);
    expect(fs.existsSync(masterKeyFilePath())).toBe(false);

    keychainSetMasterKey(KEY, { allowFile: true });
    expect(mode(masterKeyFilePath())).toBe(0o600);
    const after = describeMasterKeyStore();
    expect(after.backend).toBe('file');
    expect(after.file_opt_in).toBe(false);
    expect(after.warning).toContain('not encrypted');
    expect(keychainGetMasterKey()?.toString('hex')).toBe(KEY);
    expect(keychainDeleteMasterKey()).toBe('removed');
    expect(describeMasterKeyStore().backend).toBe('none');
  });

  it('ignores allowFile when a keyring is running', () => {
    if (process.platform !== 'linux') return;
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-ring-'));
    const store = path.join(bin, 'item');
    fs.writeFileSync(
      path.join(bin, 'secret-tool'),
      `#!/bin/sh
case "$1" in --version) exit 0;; store) cat > "${store}";; lookup) [ -f "${store}" ] && cat "${store}" || exit 1;; clear) rm -f "${store}";; esac
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, 'gdbus'), '#!/bin/sh\necho "(true,)"\n', { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}/usr/bin:/bin`;
    resetMasterKeyStoreProbe();
    keychainSetMasterKey(KEY, { allowFile: true });
    expect(fs.existsSync(masterKeyFilePath())).toBe(false);
    expect(fs.readFileSync(store, 'utf8')).toBe(KEY);
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it('disables every store when NORTHKEEP_NO_KEYCHAIN=1', () => {
    process.env.NORTHKEEP_NO_KEYCHAIN = '1';
    process.env.NORTHKEEP_SECRET_BACKEND = 'file';
    expect(masterKeyStoreAvailable()).toBe(false);
    expect(describeMasterKeyStore().backend).toBe('none');
    expect(keychainGetMasterKey()).toBeNull();
    expect(() => keychainSetMasterKey(KEY)).toThrow(/No vault key store/);
    expect(keychainDeleteMasterKey()).toBe('not-found');
  });

  it('fails closed on an unknown backend name', () => {
    process.env.NORTHKEEP_SECRET_BACKEND = 'clipboard';
    expect(masterKeyStoreAvailable()).toBe(false);
  });
});

describe('secret-tool probe does not hang', () => {
  it('treats a missing daemon as unavailable within the probe timeout', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-probe-'));
    fs.writeFileSync(
      path.join(bin, 'secret-tool'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nsleep 30\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, 'gdbus'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}/usr/bin:/bin`;
    delete process.env.NORTHKEEP_SECRET_BACKEND;
    resetMasterKeyStoreProbe();
    const started = Date.now();
    const described = describeMasterKeyStore();
    expect(Date.now() - started).toBeLessThan(10_000);
    if (process.platform === 'linux') expect(described.backend).toBe('none');
    fs.rmSync(bin, { recursive: true, force: true });
  });
});

describe('argv of a real spawn stays free of the key', () => {
  it('records secret-tool arguments from the kernel command line', () => {
    if (process.platform !== 'linux') return;
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-ps-'));
    const seen = path.join(bin, 'seen');
    fs.writeFileSync(
      path.join(bin, 'secret-tool'),
      `#!/bin/sh
tr '\\0' '\\n' < /proc/$$/cmdline > "$SEEN"
cat > /dev/null
exit 0
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
    process.env.NORTHKEEP_SECRET_BACKEND = 'secret-service';
    process.env.SEEN = seen;
    execFileSync(path.join(bin, 'secret-tool'), ['store', 'service', 'northkeep-vault'], {
      input: KEY,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    // The helper above is the stand-in. Drive the real setter too.
    keychainSetMasterKey(KEY);
    const cmdline = fs.readFileSync(seen, 'utf8');
    expect(cmdline).not.toContain(KEY);
    delete process.env.SEEN;
    fs.rmSync(bin, { recursive: true, force: true });
  });
});

describe('lock while the keyring is down', () => {
  let bin: string;
  let store: string;
  let up: string;

  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-down-'));
    store = path.join(bin, 'item');
    up = path.join(bin, 'up');
    fs.writeFileSync(
      path.join(bin, 'secret-tool'),
      `#!/bin/sh
case "$1" in --version) exit 0;; store) cat > "${store}";; lookup) [ -f "${store}" ] && cat "${store}" || exit 1;; clear) rm -f "${store}";; esac
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, 'gdbus'),
      `#!/bin/sh\nif [ -f "${up}" ]; then echo "(true,)"; else echo "(false,)"; fi\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}/usr/bin:/bin`;
  });

  afterEach(() => {
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it('never reports a clean lock while an earlier keyring copy may remain', () => {
    if (process.platform !== 'linux') return;
    fs.writeFileSync(up, '');
    resetMasterKeyStoreProbe();
    keychainSetMasterKey(KEY);
    expect(fs.readFileSync(store, 'utf8')).toBe(KEY);

    fs.rmSync(up);
    resetMasterKeyStoreProbe();
    expect(keychainDeleteMasterKey()).toBe('keyring-unreachable');

    fs.writeFileSync(up, '');
    resetMasterKeyStoreProbe();
    expect(keychainDeleteMasterKey()).toBe('removed');
    expect(fs.existsSync(store)).toBe(false);
    expect(keychainGetMasterKey()).toBeNull();
  });

  it('still removes an opted-in key file when the keyring cannot be checked', () => {
    if (process.platform !== 'linux') return;
    resetMasterKeyStoreProbe();
    keychainSetMasterKey(KEY, { allowFile: true });
    expect(keychainDeleteMasterKey()).toBe('keyring-unreachable');
    expect(fs.existsSync(masterKeyFilePath())).toBe(false);
  });
});

describe('macOS ignores the Linux backend override', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
  });

  it('never writes a key file on macOS, whatever NORTHKEEP_SECRET_BACKEND says', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-mac-'));
    const log = path.join(bin, 'log');
    fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh\ncat >> "${log}"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}/usr/bin:/bin`;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    for (const forced of ['file', 'secret-service']) {
      process.env.NORTHKEEP_SECRET_BACKEND = forced;
      resetMasterKeyStoreProbe();
      expect(describeMasterKeyStore().backend).toBe('macos-keychain');
      keychainSetMasterKey(KEY);
      expect(fs.existsSync(masterKeyFilePath())).toBe(false);
    }
    expect(fs.readFileSync(log, 'utf8')).toContain('add-generic-password');
    fs.rmSync(bin, { recursive: true, force: true });
  });
});
