#!/usr/bin/env node
/**
 * Measures how big a .nkv vault gets, with and without the embeddings cache,
 * against the 4 MiB sync cap (MAX_BLOB_BYTES). Throwaway vaults in a temp
 * directory only; no network, no real vault, no ~/.northkeep.
 *
 *   pnpm build && node scripts/size-measure.mjs            # full run
 *   node scripts/size-measure.mjs --quick                  # smaller sweep
 *
 * Embeddings are written the way the app writes them: retrieveSemantic()
 * fills the table, then a save() persists it. The embedder is a local fake
 * returning deterministic 768-dimension vectors (nomic-embed-text's size).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const core = await load('packages/core/dist/index.js');
const { nodePlatform } = await load('packages/platform-node/dist/index.js');
const { MAX_BLOB_BYTES } = await load('packages/sync/dist/client.js');
const { Vault, KDF_INTERACTIVE, generateDeviceSecret, setPlatform } = core;
setPlatform(nodePlatform());

const quick = process.argv.includes('--quick');
const DIMS = 768;
const MIB = 1024 * 1024;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-size-'));
const secret = generateDeviceSecret();
const PASS = 'size measure throwaway';

// Deterministic, realistic-length text: 120 to 480 characters, mean about 300.
const WORDS = ('prefers dark roast coffee meeting moved thursday project deadline review notes '
  + 'daughter soccer practice dentist appointment invoice client renewal travel lisbon '
  + 'conference keynote draft budget quarterly hiring plan backend migration postgres '
  + 'staging deploy rollback incident retro allergy peanuts birthday gift ideas garden').split(' ');
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
function memoryText(i) {
  const target = 120 + Math.floor(rand() * 360);
  let s = `Note ${i}:`;
  while (s.length < target) s += ` ${WORDS[Math.floor(rand() * WORDS.length)]}`;
  return s;
}
const TYPES = ['semantic', 'episodic', 'procedural', 'identity'];

const fakeEmbedder = {
  model: 'nomic-embed-text',
  async embed(text) {
    const h = createHash('sha256').update(text).digest();
    return Array.from({ length: DIMS }, (_, k) => ((h[k % 32] ^ k) & 255) / 255 - 0.5);
  },
};

function fresh(name) {
  const p = path.join(tmp, `${name}.nkv`);
  return Vault.create({ path: p, passphrase: PASS, deviceSecret: secret, kdf: KDF_INTERACTIVE });
}
const size = (p) => fs.statSync(p).size;
const mib = (n) => `${(n / MIB).toFixed(2)} MiB`;

function fill(vault, n) {
  for (let i = 0; i < n; i += 1) {
    vault.remember({ content: memoryText(i), type: TYPES[i % TYPES.length], scope: 'personal', source: 'cli' });
  }
}

async function measure(n) {
  seed = 1;
  const v = fresh(`m${n}`);
  fill(v, n);
  v.save();
  const without = size(v.path);
  await v.retrieveSemantic('coffee meeting', fakeEmbedder, { limit: 8 });
  v.save();
  const withEmb = size(v.path);
  v.close();
  return { n, without, withEmb };
}

console.log(`Sync cap (MAX_BLOB_BYTES): ${MAX_BLOB_BYTES} bytes = ${mib(MAX_BLOB_BYTES)}`);
console.log(`Temp dir: ${tmp}\n`);

// 1. Size vs memory count, with and without embeddings.
const counts = quick ? [500, 1000] : [500, 1000, 2000, 4000];
const rows = [];
for (const n of counts) rows.push(await measure(n));
console.log('memories | .nkv without embeddings | with embeddings (768-d, one model)');
for (const r of rows) console.log(`${String(r.n).padStart(8)} | ${mib(r.without).padStart(23)} | ${mib(r.withEmb)}`);

// Linear fit from the two largest points, then confirm by building at the estimate.
const [a, b] = rows.slice(-2);
const slopeNo = (b.without - a.without) / (b.n - a.n);
const slopeYes = (b.withEmb - a.withEmb) / (b.n - a.n);
const capNo = Math.floor(a.n + (MAX_BLOB_BYTES - a.without) / slopeNo);
const capYes = Math.floor(a.n + (MAX_BLOB_BYTES - a.withEmb) / slopeYes);
console.log(`\nBytes per memory: ${slopeNo.toFixed(0)} without, ${slopeYes.toFixed(0)} with embeddings`);
console.log(`Estimated count at the 4 MiB cap: ${capNo} without embeddings, ${capYes} with`);
if (!quick) {
  // Bisect the first count whose vault, embeddings included, exceeds the cap.
  let lo = rows[0].n; // 500 memories is well under the cap
  let hi = capYes + 50;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await measure(mid)).withEmb > MAX_BLOB_BYTES) hi = mid; else lo = mid;
  }
  console.log(`Measured: ${hi} memories with embeddings is the first count over the cap`);
  const check = await measure(capNo);
  console.log(`Check at ${capNo} without embeddings: ${mib(check.without)}`);
}

// 2. What the shipped read paths actually persist: open, search, close (no save).
{
  seed = 1;
  const v = fresh('readpath');
  fill(v, 500);
  v.save();
  const p = v.path;
  v.close();
  const before = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const r = Vault.open({ path: p, passphrase: PASS, deviceSecret: secret });
  await r.retrieveSemantic('coffee meeting', fakeEmbedder, { limit: 8 });
  r.close();
  const after = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  console.log(`\nSearch on a fresh handle, then close (CLI, MCP, web pattern): file ${before === after ? 'unchanged' : 'CHANGED'}`);
  // A write in the same handle after a search persists the whole cache.
  const w = Vault.open({ path: p, passphrase: PASS, deviceSecret: secret });
  const s0 = size(p);
  await w.retrieveSemantic('coffee meeting', fakeEmbedder, { limit: 8 });
  w.remember({ content: 'one more', type: 'semantic', source: 'cli' });
  w.save();
  console.log(`Search then a write on the same handle: ${mib(s0)} -> ${mib(size(p))}`);
  // Dropping the table without VACUUM does not shrink the file.
  w.clearEmbeddingCache();
  w.save();
  const dropped = size(p);
  w.close();
  console.log(`clearEmbeddingCache() then save, no VACUUM: ${mib(dropped)}`);
}

// 3. Other growth: project revisions, forgotten rows, a second embedding model.
{
  const v = fresh('project');
  let rev = v.updateProject({ project: 'size-test', expected_revision: null, what_why: 'Measure growth.', status: 'active' }, { actor: 'owner' }).revision;
  const s0 = size(v.path);
  const updates = quick ? 50 : 200;
  for (let i = 0; i < updates; i += 1) {
    rev = v.updateProject({ project: 'size-test', expected_revision: rev, status: `step ${i} ${memoryText(i)}`, log_entry: memoryText(i + 1) }, { actor: 'agent' }).revision;
  }
  v.save();
  const doc = v.list({ scope: 'project:size-test' }).find((e) => e.superseded_at === null);
  console.log(`\nOne project, ${updates} updates with a log line each (auto-compaction keeps 5): ${mib(s0)} -> ${mib(size(v.path))}; live document ${doc ? doc.content.length : 0} chars`);
  v.close();
}
{
  seed = 1;
  const v = fresh('forget');
  fill(v, 1000);
  v.save();
  const s0 = size(v.path);
  for (const e of v.list().slice(0, 500)) v.forget(e.id, { actor: 'owner' });
  v.save();
  const s1 = size(v.path);
  v.close();
  console.log(`1,000 memories, forget 500: ${mib(s0)} -> ${mib(s1)} (content blanked and zeroed, free pages kept in the image)`);
}
{
  // Long imports: entries at the 8,000-character cap the web API allows.
  const v = fresh('long');
  let n = 0;
  while (size(v.path) <= MAX_BLOB_BYTES) {
    for (let i = 0; i < 50; i += 1, n += 1) {
      let t = '';
      while (t.length < 8000) t += `${memoryText(n)} `;
      v.remember({ content: t.slice(0, 8000), type: 'semantic', source: 'import' });
    }
    v.save();
  }
  console.log(`Entries of 8,000 characters: the cap is crossed between ${n - 50} and ${n}`);
  v.close();
}
{
  seed = 1;
  const v = fresh('twomodels');
  fill(v, 1000);
  await v.retrieveSemantic('coffee', fakeEmbedder);
  await v.retrieveSemantic('coffee', { ...fakeEmbedder, model: 'mxbai-embed-large' });
  v.save();
  console.log(`1,000 memories, two embedding models cached: ${mib(size(v.path))}`);
  v.close();
}
console.log('\nOutside the vault file (never synced): mcp-calls.log, sync.json, .bak, device.secret.');
fs.rmSync(tmp, { recursive: true, force: true });
