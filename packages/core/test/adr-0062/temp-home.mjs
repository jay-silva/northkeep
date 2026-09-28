// Every ADR 0062 harness imports this first: it refuses to run unless NORTHKEEP_HOME is a
// throwaway directory under the system temp folder, so nothing can touch ~/.northkeep.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function requireTempHome() {
  const home = process.env.NORTHKEEP_HOME;
  if (!home) throw new Error('NORTHKEEP_HOME is unset; export NORTHKEEP_HOME="$(mktemp -d)" first.');
  const real = fs.realpathSync(home);
  const roots = [os.tmpdir(), '/tmp', '/private/tmp'].filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r));
  const underTemp = roots.some((root) => real.startsWith(root + path.sep));
  if (!underTemp || real === fs.realpathSync(os.homedir()) || real.startsWith(path.join(fs.realpathSync(os.homedir()), '.northkeep'))) {
    throw new Error(`NORTHKEEP_HOME must be a temp directory, not ${real}.`);
  }
  if (process.env.DATABASE_URL || process.env.CONNECTOR_KEK_PEPPER) throw new Error('Unset DATABASE_URL and CONNECTOR_KEK_PEPPER first.');
  return real;
}

/** Loads a built core and registers its Node platform. `root` is a checkout with `pnpm -r build` done. */
export async function loadCore(root) {
  const core = await import(path.join(root, 'packages/core/dist/index.js'));
  const { nodePlatform } = await import(path.join(root, 'packages/platform-node/dist/index.js'));
  core.setPlatform(nodePlatform());
  return core;
}
