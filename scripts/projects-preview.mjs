// Runs only against a session-created synthetic vault and configuration directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-projects-preview-'));
process.env.NORTHKEEP_HOME = dir;
process.env.NORTHKEEP_NO_KEYCHAIN = '1';
delete process.env.NORTHKEEP_MASTER_KEY;
delete process.env.NORTHKEEP_PASSPHRASE;
const { Vault, setPlatform, ensureDeviceSecret, KDF_INTERACTIVE } = await import('../packages/core/dist/index.js');
const { nodePlatform } = await import('../packages/platform-node/dist/index.js');
const { startUiServer } = await import('../apps/web/dist/server.js');
setPlatform(nodePlatform());
const secret = ensureDeviceSecret().secret;
const vaultPath = path.join(dir, 'sample.nkv');
const passphrase = 'synthetic-preview-only';
const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret: secret, kdf: KDF_INTERACTIVE });
for (const project of [
  { project: 'trail-journal', status: 'The capture flow works in the field. Three walks are logged; the last pass exposed a confusing offline label.', next_actions: 'Rename the offline state, then repeat the airplane-mode walk.', decision: 'Keep capture available without a connection.', open_questions: 'Should queued entries show their eventual sync destination?', files: [{ type: 'local_path', label: 'Walk test notes.md', locator: 'Documents/Trail Journal/Walk test notes.md', access: 'unverified' }] },
  { project: 'field-notes', status: 'The interview guide and synthesis draft are complete. The supporting audio index was saved from another device.', next_actions: 'Recover or replace the missing audio index before citing the final theme count.', decision: 'Keep direct observations separate from interpretation.', open_questions: 'Can the next assistant verify the unavailable audio index?', files: [{ type: 'local_path', label: 'Audio index.csv', locator: 'Desktop/Field Notes/Audio index.csv', access: 'unavailable' }] },
]) vault.updateProject({ expected_revision: null, what_why: 'Synthetic project for interface acceptance.', log_entry: 'Created a disposable project for acceptance checks.', ...project });
vault.save(); vault.close(); secret.fill(0);
const app = await startUiServer({ vaultPath });
const entry = createServer((_req, res) => { res.writeHead(302, { Location: app.url, 'Cache-Control': 'no-store' }); res.end(); });
await new Promise(resolve => entry.listen(0, '127.0.0.1', resolve));
console.log(`Synthetic Projects preview: http://127.0.0.1:${entry.address().port}`);
console.log(`Unlock with: ${passphrase}`);
console.log(`Disposable fixture: ${dir}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await app.close(); entry.close(() => process.exit(0));
});
