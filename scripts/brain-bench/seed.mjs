// Builds a throwaway NorthKeep home holding the fictional world. It never
// touches a real vault: the home must be a new directory, and it gets a
// marker file the bench server checks before it will open anything.
import fs from 'node:fs';
import path from 'node:path';
import { MEMORIES, PROJECTS } from './world.mjs';

export const PASSPHRASE = 'brain-bench-throwaway';
export const MARKER = '.brain-bench-throwaway';
const DAY = 86_400_000;

/** Refuse any home that is not a bench throwaway. */
export function assertThrowawayHome(home) {
  if (!home || !fs.existsSync(path.join(home, MARKER))) {
    throw new Error(`Refusing to use ${home || '(no home)'}: it is not a brain-bench throwaway home.`);
  }
}

/** Run `fn` with the clock set to `at`, so saved dates land in the past. */
function atTime(at, fn) {
  const Real = Date;
  class Fake extends Real {
    constructor(...args) { if (args.length === 0) super(at); else super(...args); }
    static now() { return at; }
  }
  globalThis.Date = Fake;
  try { return fn(); } finally { globalThis.Date = Real; }
}

/**
 * Create `home` and fill its vault with the world, oldest first. Returns what
 * the designs need to build their instructions.
 */
export async function seedHome(home, now = Date.now()) {
  if (fs.existsSync(home)) throw new Error(`${home} already exists; the bench only writes to a new directory.`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, MARKER), 'Fictional data for scripts/brain-bench. Safe to delete.\n');
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';

  const core = await import('../../packages/core/dist/index.js');
  const { nodePlatform } = await import('../../packages/platform-node/dist/index.js');
  core.setPlatform(nodePlatform());
  const { secret } = core.ensureDeviceSecret();
  const vault = core.Vault.create({ path: path.join(home, 'vault.nkv'), passphrase: PASSPHRASE, deviceSecret: secret, kdf: core.KDF_INTERACTIVE });

  const steps = [
    ...MEMORIES.map((memory, i) => ({ days: memory.days, order: i, memory })),
    ...PROJECTS.map((project, i) => ({ days: project.days, order: MEMORIES.length + i, project })),
  ].sort((a, b) => b.days - a.days || a.order - b.order);

  steps.forEach((step, i) => {
    atTime(now - step.days * DAY + i, () => {
      if (step.memory) {
        const { text, type, scope, source, confirmed } = step.memory;
        vault.remember({
          content: text, type, scope, source,
          metadata: confirmed ? { confirmed: { by: 'user', at: new Date().toISOString() } } : null,
        });
      } else {
        const { slug, title, what_why, status, next_actions } = step.project;
        vault.updateProject({ project: slug, expected_revision: null, title, what_why, status, next_actions, log_entry: 'Created.' }, { actor: 'owner' });
      }
    });
  });

  const facts = vault.list().filter((entry) => !core.isProjectPaperwork(entry)).map((entry) => ({
    content: entry.content, type: entry.type, scope: entry.scope, source: entry.source,
    saved: entry.created_at.slice(0, 10), confirmed: core.isConfirmed(entry.metadata),
  }));
  vault.save();
  vault.close();
  return { facts, projects: PROJECTS.map(({ slug, title }) => ({ slug, title })) };
}
