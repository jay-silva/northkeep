import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';

/**
 * Where the derived vault master key is parked for background unlock
 * (ADR 0002, Linux in ADR 0064). The passphrase is never stored.
 *
 * macOS writes through `security -i` (commands on stdin) so the key never
 * appears on a command line. Linux prefers the Secret Service (`secret-tool`,
 * secret on stdin) and, only when that daemon is absent, a mode-0600 file in
 * the existing NorthKeep home. NORTHKEEP_NO_KEYCHAIN=1 disables every store.
 */
const SERVICE = 'northkeep-vault';
const ACCOUNT = 'master-key';
const KEY_RE = /^[0-9a-f]{64}$/i;

export type MasterKeyBackend = 'macos-keychain' | 'secret-service' | 'file' | 'none';

export interface MasterKeyStoreDescription {
  available: boolean;
  backend: MasterKeyBackend;
  /** Set only for the file fallback. Never contains the key. */
  warning: string | null;
}

let secretServiceProbed: boolean | undefined;
let fileWarningEmitted = false;

/** Tests change PATH or the backend env between cases. */
export function resetMasterKeyStoreProbe(): void {
  secretServiceProbed = undefined;
  fileWarningEmitted = false;
}

/** macOS `security` CLI only. Provider keys and OAuth tokens still use this. */
export function keychainAvailable(): boolean {
  return process.platform === 'darwin' && process.env.NORTHKEEP_NO_KEYCHAIN !== '1';
}

export function masterKeyFilePath(): string {
  return path.join(northkeepHome(), 'master.key');
}

export function masterKeyStoreAvailable(): boolean {
  return resolveBackend() !== 'none';
}

export function describeMasterKeyStore(): MasterKeyStoreDescription {
  const backend = resolveBackend();
  return {
    available: backend !== 'none',
    backend,
    warning:
      backend === 'file'
        ? `The Secret Service is not available, so keeping the vault unlocked writes the key to a file only your account can read (${masterKeyFilePath()}). ` +
          'That file is not encrypted. Anyone who can read your files can open the vault. ' +
          'Install and unlock a Secret Service keyring (gnome-keyring or equivalent), then run "northkeep unlock" again to move the key there.'
        : null,
  };
}

export function keychainSetMasterKey(masterKeyHex: string): void {
  if (!KEY_RE.test(masterKeyHex)) throw new Error('Malformed master key.');
  const backend = resolveBackend();
  switch (backend) {
    case 'macos-keychain':
      setMacos(masterKeyHex);
      return;
    case 'secret-service':
      setSecretService(masterKeyHex);
      removeFileStore();
      return;
    case 'file':
      setFile(masterKeyHex);
      warnFileBackend();
      return;
    case 'none':
      throw new Error('No vault key store is available on this system.');
    default: {
      const unexpected: never = backend;
      throw new Error(`Unhandled vault key store: ${String(unexpected)}`);
    }
  }
}

export function keychainGetMasterKey(): Buffer | null {
  const backend = resolveBackend();
  switch (backend) {
    case 'macos-keychain':
      return getMacos();
    case 'secret-service':
      return getSecretService();
    case 'file': {
      const key = readFileStore();
      if (key) warnFileBackend();
      return key;
    }
    case 'none':
      return null;
    default: {
      const unexpected: never = backend;
      throw new Error(`Unhandled vault key store: ${String(unexpected)}`);
    }
  }
}

export function keychainDeleteMasterKey(): 'removed' | 'not-found' {
  const backend = resolveBackend();
  switch (backend) {
    case 'macos-keychain':
      return deleteMacos();
    case 'secret-service': {
      const outcome = deleteSecretService();
      // A lock must not leave the weaker file copy behind.
      return removeFileStore() ? 'removed' : outcome;
    }
    case 'file':
      return removeFileStore() ? 'removed' : 'not-found';
    case 'none':
      return 'not-found';
    default: {
      const unexpected: never = backend;
      throw new Error(`Unhandled vault key store: ${String(unexpected)}`);
    }
  }
}

function resolveBackend(): MasterKeyBackend {
  if (process.env.NORTHKEEP_NO_KEYCHAIN === '1') return 'none';
  const forced = process.env.NORTHKEEP_SECRET_BACKEND;
  if (forced !== undefined && forced.length > 0) {
    if (forced === 'file') return 'file';
    if (forced === 'secret-service') return 'secret-service';
    if (forced === 'macos-keychain' && process.platform === 'darwin') return 'macos-keychain';
    return 'none';
  }
  if (process.platform === 'darwin') return 'macos-keychain';
  if (process.platform === 'linux') return secretServiceReachable() ? 'secret-service' : 'file';
  return 'none';
}

function secretServiceReachable(): boolean {
  if (secretServiceProbed !== undefined) return secretServiceProbed;
  secretServiceProbed = probeSecretService();
  return secretServiceProbed;
}

/**
 * A binary on PATH is not enough: `secret-tool` with no daemon can sit until
 * a GUI prompt. The session bus must already own the Secret Service name.
 */
function probeSecretService(): boolean {
  try {
    execFileSync('secret-tool', ['--version'], { stdio: 'ignore', timeout: 2000 });
  } catch {
    return false;
  }
  try {
    const out = execFileSync(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.DBus',
        '--object-path',
        '/org/freedesktop/DBus',
        '--method',
        'org.freedesktop.DBus.NameHasOwner',
        'org.freedesktop.secrets',
      ],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.includes('true');
  } catch {
    return false;
  }
}

function warnFileBackend(): void {
  if (fileWarningEmitted) return;
  fileWarningEmitted = true;
  const { warning } = describeMasterKeyStore();
  if (warning) console.warn(`northkeep: ${warning}`);
}

function setMacos(masterKeyHex: string): void {
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${masterKeyHex}\n`,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

function getMacos(): Buffer | null {
  try {
    const hex = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return KEY_RE.test(hex) ? Buffer.from(hex, 'hex') : null;
  } catch {
    return null; // not present, or keychain locked/denied
  }
}

function deleteMacos(): 'removed' | 'not-found' {
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return 'removed';
  } catch (err) {
    // Exit 44 = item not found. Anything else means the key may STILL BE
    // STORED (keychain locked/denied) — never report that as locked.
    if ((err as { status?: number }).status === 44) return 'not-found';
    throw new Error(
      'Could not access the macOS Keychain to remove the key. The vault may still be unlocked. Try again.',
    );
  }
}

function setSecretService(masterKeyHex: string): void {
  try {
    execFileSync(
      'secret-tool',
      ['store', '--label', 'NorthKeep vault master key', 'service', SERVICE, 'account', ACCOUNT],
      {
        input: masterKeyHex,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 30_000,
      },
    );
  } catch {
    throw new Error('Secret Service did not accept the vault key. The keyring may be locked or unavailable.');
  }
}

function getSecretService(): Buffer | null {
  try {
    const hex = execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    }).trim();
    return KEY_RE.test(hex) ? Buffer.from(hex, 'hex') : null;
  } catch {
    return null; // absent, or the keyring is locked/denied
  }
}

function deleteSecretService(): 'removed' | 'not-found' {
  let status: number | null = null;
  try {
    const hex = execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    }).trim();
    if (!KEY_RE.test(hex)) return 'not-found';
  } catch (err) {
    status = (err as { status?: number }).status ?? null;
    // secret-tool lookup exits 1 when no item matches.
    if (status === 1) return 'not-found';
    throw new Error(
      'Could not access the Secret Service to remove the key. The vault may still be unlocked. Try again.',
    );
  }
  try {
    execFileSync('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT], {
      stdio: 'ignore',
      timeout: 30_000,
    });
  } catch {
    throw new Error(
      'Could not access the Secret Service to remove the key. The vault may still be unlocked. Try again.',
    );
  }
  return 'removed';
}

function setFile(masterKeyHex: string): void {
  const filePath = masterKeyFilePath();
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  const tmp = path.join(dir, `.master.key.${process.pid}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, `${masterKeyHex}\n`);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closing on the failure path
      }
      fd = null;
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // the exclusive create may have failed before the file existed
    }
    throw new Error('Could not store the vault key in the private file.');
  }
  fs.closeSync(fd);
  try {
    // rename replaces a symlink; it does not follow it.
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // the temp file may already be gone
    }
    throw new Error('Could not store the vault key in the private file.');
  }
  fs.chmodSync(filePath, 0o600);
  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
  const mode = fs.statSync(filePath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // the mode check below is the failure the caller sees
    }
    throw new Error('Refusing to leave the vault key in a file other accounts can read.');
  }
}

function readFileStore(): Buffer | null {
  const filePath = masterKeyFilePath();
  let st: fs.Stats;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    return null;
  }
  // lstat: a symlink is not a file. Do not follow it.
  if (!st.isFile()) return null;
  if ((st.mode & 0o077) !== 0) {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      return null;
    }
    if ((fs.statSync(filePath).mode & 0o077) !== 0) return null;
  }
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const hex = fs.readFileSync(fd, 'utf8').trim();
    return KEY_RE.test(hex) ? Buffer.from(hex, 'hex') : null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Removes a regular file or a symlink. Does not follow the symlink. */
function removeFileStore(): boolean {
  const filePath = masterKeyFilePath();
  let st: fs.Stats;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('Could not access the vault key file to remove it. The vault may still be unlocked. Try again.');
  }
  if (!st.isFile() && !st.isSymbolicLink()) {
    throw new Error('Could not access the vault key file to remove it. The vault may still be unlocked. Try again.');
  }
  fs.unlinkSync(filePath);
  return true;
}

function ensurePrivateDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error('Could not create the NorthKeep data directory for the vault key.');
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    throw new Error('Could not restrict the NorthKeep data directory to this account.');
  }
  const mode = fs.statSync(dir).mode & 0o777;
  if ((mode & 0o022) !== 0) {
    throw new Error('Refusing to store the vault key in a directory other accounts can change.');
  }
}
