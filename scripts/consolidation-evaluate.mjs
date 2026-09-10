import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, KDF_INTERACTIVE, generateDeviceSecret, setPlatform } from '../packages/core/dist/index.js';
import { nodePlatform } from '../packages/platform-node/dist/index.js';
import { createOllamaClient, resolveReviewModel } from '../packages/librarian/dist/ollama.js';
import { suggestConsolidations } from '../packages/librarian/dist/consolidation.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-consolidation-eval-'));
process.env.NORTHKEEP_HOME = dir;
process.env.NORTHKEEP_NO_KEYCHAIN = '1';
setPlatform(nodePlatform());
const secret = generateDeviceSecret();
const vaultPath = path.join(dir, 'synthetic.nkv');
const vault = Vault.create({ path: vaultPath, passphrase: 'synthetic-local-model-only', deviceSecret: secret, kdf: KDF_INTERACTIVE });
for (const content of ['Keep summaries concise.', 'Use bullets for action items.', 'For technical reviews, include reasoning and examples.', 'Use a 1.5 line-height for draft documents.', 'Use 15 points for section titles.']) {
  vault.remember({ content, scope: 'writing', type: 'semantic', source: 'synthetic-evaluation' });
}
vault.save();
const before = fs.readFileSync(vaultPath);
const snapshots = vault.list();
try {
  const model = await resolveReviewModel();
  const client = createOllamaClient();
  const rawResponses = [];
  const generator = { generateJson: async (...args) => { const raw = await client.generateJson(...args); rawResponses.push(raw); return raw; } };
  const result = await suggestConsolidations(snapshots, 'Consolidate writing preferences, preserving exceptions and exact numeric values. Keep unrelated formatting settings separate.', generator, { model });
  assert.deepEqual(fs.readFileSync(vaultPath), before);
  assert.deepEqual(vault.list(), snapshots);
  console.log(JSON.stringify({ synthetic: true, model, zero_vault_writes: true, coverage: result.coverage, groups: result.groups.map(group => ({ sources: group.sources.map(source => source.content), proposed: group.proposed_content, explanation: group.explanation, question: group.question })), raw_responses: rawResponses, evidence_directory: dir, limitation: 'Inspect meaning manually. One small local-model probe does not establish general accuracy.' }, null, 2));
} finally { vault.close(); secret.fill(0); }
