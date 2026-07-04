import { execFileSync } from 'node:child_process';

/**
 * macOS Keychain storage for the derived master key (ADR 0002). The
 * passphrase itself is never stored anywhere. Writes go through
 * `security -i` (commands on stdin) so the key never appears on a command
 * line where `ps` could see it. NORTHKEEP_NO_KEYCHAIN=1 disables (tests).
 */
const SERVICE = 'northkeep-vault';
const ACCOUNT = 'master-key';

export function keychainAvailable(): boolean {
  return process.platform === 'darwin' && process.env.NORTHKEEP_NO_KEYCHAIN !== '1';
}

export function keychainSetMasterKey(masterKeyHex: string): void {
  if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) throw new Error('Malformed master key.');
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${masterKeyHex}\n`,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

export function keychainGetMasterKey(): Buffer | null {
  try {
    const hex = execFileSync(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
  } catch {
    return null; // not present, or keychain locked/denied
  }
}

export function keychainDeleteMasterKey(): 'removed' | 'not-found' {
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
      'Could not access the macOS Keychain to remove the key — the vault may still be unlocked. Try again.',
    );
  }
}
