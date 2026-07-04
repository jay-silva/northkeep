import fs from 'node:fs';
import path from 'node:path';
import { DEVICE_SECRET_BYTES, generateDeviceSecret } from '@northkeep/core';
import { deviceSecretPath } from './paths.js';

/** Creates the device secret if absent; never overwrites an existing one. */
export function ensureDeviceSecret(): { secret: Buffer; created: boolean } {
  const filePath = deviceSecretPath();
  if (fs.existsSync(filePath)) {
    return { secret: loadDeviceSecret(), created: false };
  }
  const secret = generateDeviceSecret();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // 'wx' = exclusive create: a concurrent init cannot silently clobber a
  // secret that another process just wrote (that would orphan its vault).
  fs.writeFileSync(filePath, `${secret.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  return { secret, created: true };
}

export function loadDeviceSecret(): Buffer {
  const filePath = deviceSecretPath();
  let hex: string;
  try {
    hex = fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    throw new Error(
      `Device secret not found at ${filePath}.\n` +
        'The vault cannot be opened without it. Restore it from your backup, ' +
        'or run "northkeep init" on a machine that has never had a vault.',
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`Device secret at ${filePath} is malformed (expected 64 hex characters).`);
  }
  const secret = Buffer.from(hex, 'hex');
  if (secret.length !== DEVICE_SECRET_BYTES) {
    throw new Error(`Device secret at ${filePath} has the wrong length.`);
  }
  return secret;
}
