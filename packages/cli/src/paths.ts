import os from 'node:os';
import path from 'node:path';

/** NORTHKEEP_HOME overrides the data directory (used by tests; documented for scripting). */
export function northkeepHome(): string {
  return process.env.NORTHKEEP_HOME ?? path.join(os.homedir(), '.northkeep');
}

export function defaultVaultPath(): string {
  return path.join(northkeepHome(), 'vault.nkv');
}

export function deviceSecretPath(): string {
  return path.join(northkeepHome(), 'device.secret');
}
