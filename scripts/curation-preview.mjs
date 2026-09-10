// Synthetic-only local acceptance fixture. Never opens an existing vault.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-curation-preview-'));
process.env.NORTHKEEP_HOME = fixtureDir;
process.env.NORTHKEEP_NO_KEYCHAIN = '1';
delete process.env.NORTHKEEP_PASSPHRASE;
delete process.env.NORTHKEEP_MASTER_KEY;
const { ensureDeviceSecret, KDF_INTERACTIVE, Vault, setPlatform } = await import('../packages/core/dist/index.js');
const { nodePlatform } = await import('../packages/platform-node/dist/index.js');
const { assembleReviewReport, saveReviewReport } = await import('../packages/librarian/dist/reviewReport.js');
const { startUiServer } = await import('../apps/web/dist/server.js');
setPlatform(nodePlatform());
const passphrase = 'synthetic-preview-only';
const deviceSecret = ensureDeviceSecret().secret;
const vaultPath = path.join(fixtureDir, 'synthetic.nkv');
const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
function remember(content, scope = 'writing') {
  return vault.remember({ type: 'semantic', scope, content, source: 'synthetic-preview' });
}
const brief = remember('I prefer concise summaries, usually three sentences.');
const exception = remember('For technical reviews, include detailed reasoning and examples.');
const repeated = remember(brief.content);
const third = remember(brief.content);
const morning = remember('Hold the sample workshop in the morning.', 'planning');
const afternoon = remember('Hold the sample workshop in the afternoon.', 'planning');
vault.remember({ type: 'working', scope: 'project:sample', content: 'Synthetic project document; excluded from memory review.', source: 'synthetic-preview' });
const sources = [brief, exception, repeated, third, morning, afternoon];
const quote = (entry) => ({ entry_id: entry.id, quote: entry.content });
const proposals = [
  {
    id: '11111111', kind: 'stale', entry_ids: [brief.id, exception.id],
    quotes: [quote(brief), quote(exception)], explanation: 'The technical-review preference may be a context-specific exception, not a reversal.',
    target_entry_id: brief.id, proposed_content: 'Keep summaries concise by default; include detailed reasoning and examples in technical reviews.', status: 'pending',
  },
  {
    id: '22222222', kind: 'duplicate', entry_ids: [brief.id, repeated.id, third.id],
    quotes: [quote(brief), quote(repeated), quote(third)], explanation: 'These three entries contain exactly the same wording.',
    target_entry_id: null, proposed_content: null, status: 'pending',
    member_decisions: { [brief.id]: 'pending', [repeated.id]: 'pending', [third.id]: 'pending' },
  },
  {
    id: '33333333', kind: 'question', entry_ids: [morning.id, afternoon.id],
    quotes: [quote(morning), quote(afternoon)], explanation: 'The two preferred times disagree and neither states when it took effect.',
    question: 'What time should the sample workshop take place?', target_entry_id: null, proposed_content: null, status: 'pending',
  },
];
vault.save();
saveReviewReport(assembleReviewReport({
  vault_id: vault.getVaultId(), vault_path: vaultPath, model: 'synthetic-preview', started_at: new Date().toISOString(),
  entry_count: sources.length, selected_scopes: ['writing', 'planning'], source_entries: sources, proposals, drops: { pack_split_gap: 1 },
  coverage: { selected: sources.length, compared: 0, skipped: 0, failed: sources.length, complete: false },
}), vaultPath);
vault.close();
deviceSecret.fill(0);
const server = await startUiServer({ vaultPath });
// This token and passphrase protect only newly generated synthetic data.
console.log(JSON.stringify({ synthetic: true, url: server.url, passphrase, fixture_dir: fixtureDir }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
