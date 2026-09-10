// Synthetic-only acceptance app with a clearly labeled deterministic local model stub.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-consolidation-preview-'));
process.env.NORTHKEEP_HOME = dir;
process.env.NORTHKEEP_NO_KEYCHAIN = '1';
delete process.env.NORTHKEEP_MASTER_KEY;
delete process.env.NORTHKEEP_PASSPHRASE;
const model = createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }, { name: 'qwen2.5:7b' }, { name: 'llama3.2:3b' }] }));
    return;
  }
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const match = request.prompt.match(/===BEGIN MEMORY DATA===\s*([\s\S]*?)\s*===END MEMORY DATA===/);
      const entries = match ? JSON.parse(match[1]) : [];
      const writing = entries.filter(entry => entry.content.includes('summaries') || entry.content.includes('action items') || entry.content.includes('technical reviews'));
      const sources = writing.length >= 2 ? writing : entries;
      const groups = sources.length >= 2 ? [{
        source_ids: sources.map(entry => entry.id),
        evidence: sources.map(entry => ({ source_id: entry.id, quote: entry.content })),
        proposed_content: writing.length >= 2 ? 'Keep summaries concise and use bullets for action items. For technical reviews, include reasoning and examples.' : sources.map(entry => entry.content).join(' '),
        explanation: 'Synthetic preview suggestion. Inspect every source before confirming the exact wording.',
      }] : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: JSON.stringify({ groups }), done: true }));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Synthetic preview could not parse the model request.' }));
    }
  });
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${model.address().port}`;
const { Vault, setPlatform, ensureDeviceSecret, KDF_INTERACTIVE } = await import('../packages/core/dist/index.js');
const { nodePlatform } = await import('../packages/platform-node/dist/index.js');
const { startUiServer } = await import('../apps/web/dist/server.js');
setPlatform(nodePlatform());
const secret = ensureDeviceSecret().secret;
const passphrase = 'synthetic-preview-only';
const vaultPath = path.join(dir, 'sample.nkv');
const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret: secret, kdf: KDF_INTERACTIVE });
for (const content of ['Keep summaries concise.', 'Use bullets for action items.', 'For technical reviews, include reasoning and examples.']) {
  vault.remember({ content, type: 'semantic', scope: 'writing', source: 'synthetic-preview' });
}
vault.remember({ content: 'Synthetic project document. Excluded from consolidation.', type: 'working', scope: 'project:sample' });
for (const [type, contents] of [
  ['procedural', ['Start drafting with an outline.', 'Review the outline before writing paragraphs.']],
  ['identity', ['I write short fiction.', 'I also write essays.']],
  ['episodic', ['The sample writing workshop covered structure.', 'The sample writing workshop covered revision.']],
  ['working', ['Draft the opening this week.', 'Revise the opening after feedback.']],
]) for (const content of contents) vault.remember({ content, type, scope: 'writing', source: 'synthetic-preview' });
vault.save(); vault.close(); secret.fill(0);
const app = await startUiServer({ vaultPath });
console.log(JSON.stringify({ synthetic: true, model: 'deterministic local stub, not a quality evaluation', url: app.url, passphrase, fixture_directory: dir }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await app.close();
  model.close(() => process.exit(0));
});
