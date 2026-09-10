/** Synthetic local-model acceptance probe. Never opens an existing vault or uses cloud providers. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, KDF_INTERACTIVE, generateDeviceSecret, setPlatform } from '../packages/core/dist/index.js';
import { nodePlatform } from '../packages/platform-node/dist/index.js';
import { createOllamaClient, resolveReviewModel } from '../packages/librarian/dist/ollama.js';
import { runReviewPass } from '../packages/librarian/dist/review.js';

setPlatform(nodePlatform());
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-curation-eval-'));
const vault = Vault.create({
  path: path.join(directory, 'synthetic.nkv'),
  passphrase: 'synthetic-evaluation-only',
  deviceSecret: generateDeviceSecret(),
  kdf: KDF_INTERACTIVE,
});
const examples = [
  ['short-a', 'writing', 'I prefer short summaries, usually three sentences.'],
  ['short-b', 'writing', 'I prefer short summaries, usually three sentences.'],
  ['exception', 'writing', 'For technical reviews, include detailed reasoning and examples.'],
  ['rate-decimal', 'numbers', 'The sample rate is 1.5 units.'],
  ['rate-integer', 'numbers', 'The sample rate is 15 units.'],
  ['old-date', 'schedule', 'The sample workshop is scheduled for October 3, 2026.'],
  ['new-date', 'schedule', 'The sample workshop was rescheduled from October 3 to October 10, 2026.'],
];
const labels = new Map();
for (const [label, scope, content] of examples) {
  const entry = vault.remember({ type: 'semantic', scope, content, source: 'synthetic-evaluation' });
  labels.set(entry.id, label);
}
vault.save();
const before = vault.list();
const diskBefore = fs.readFileSync(vault.path);
try {
  const client = createOllamaClient();
  const model = await resolveReviewModel();
  const result = await runReviewPass(before, client, {
    model,
    embed: (text) => client.embed(text),
    onStatus: (message) => process.stdout.write(`${message}\n`),
    onProgress: (done, total) => process.stdout.write(`Completed ${done}/${total} review packs.\n`),
  });
  assert.deepEqual(vault.list(), before, 'Review changed synthetic memory entries.');
  assert.deepEqual(fs.readFileSync(vault.path), diskBefore, 'Review changed encrypted vault bytes.');
  const simplified = result.proposals.map((p) => ({
    kind: p.kind,
    sources: p.entry_ids.map((id) => labels.get(id)),
    target: labels.get(p.target_entry_id),
    explanation: p.explanation,
    proposed_content: p.proposed_content,
    question: p.question,
  }));
  const numericDuplicate = simplified.some((p) => p.kind === 'duplicate' &&
    p.sources.includes('rate-decimal') && p.sources.includes('rate-integer'));
  assert.equal(numericDuplicate, false, 'Model called different numeric facts duplicates.');
  assert(simplified.some((p) => p.kind === 'duplicate' &&
    p.sources.includes('short-a') && p.sources.includes('short-b')), 'Missed the planted exact repeat.');
  const report = {
    synthetic: true,
    model,
    zero_memory_writes: true,
    coverage: result.coverage,
    drops: result.drops,
    proposals: simplified,
    note: 'Human review of these proposals is required; a passing probe does not establish general model accuracy.',
  };
  fs.writeFileSync(path.join(directory, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nSynthetic evaluation evidence: ${directory}\n`);
} finally {
  vault.close();
}
