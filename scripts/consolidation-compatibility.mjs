import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { nodePlatform } from '../packages/platform-node/dist/index.js';
import * as current from '../packages/core/dist/index.js';

const legacyPath = process.argv[2];
if (!legacyPath) throw new Error('Pass the built core/index.js from the isolated v0.21.0 checkout.');
const legacy = await import(pathToFileURL(path.resolve(legacyPath)).href);
legacy.setPlatform(nodePlatform());
current.setPlatform(nodePlatform());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-consolidation-compat-'));
process.env.NORTHKEEP_HOME = dir;
process.env.NORTHKEEP_NO_KEYCHAIN = '1';
const deviceSecret = current.generateDeviceSecret();
const options = { path: path.join(dir, 'legacy-created.nkv'), passphrase: 'synthetic-compatibility-only', deviceSecret, kdf: legacy.KDF_INTERACTIVE };
const old = legacy.Vault.create(options);
const sources = ['Keep summaries concise.', 'Use bullets for action items.', 'For technical reviews, include reasoning and examples.']
  .map(content => old.remember({ content, type: 'semantic', scope: 'writing', metadata: { fixture: true } }));
old.save(); old.close();
let vault = current.Vault.open(options);
const req = { vault_id: vault.getVaultId(), operation_id: randomUUID(), sources, content: 'Keep summaries concise and use bullets for action items. For technical reviews, include reasoning and examples.' };
const consolidated = vault.consolidateMemories(req);
vault.save(); vault.close();

const olderReader = legacy.Vault.open(options);
assert.equal(olderReader.list().length, 1);
assert.equal(olderReader.list()[0].content, req.content);
assert.equal(olderReader.verifyChain().ok, true);
const exported = olderReader.export();
assert.equal(exported.memories.length, 4);
assert.equal(exported.memories.filter(entry => entry.validity.superseded_by === consolidated.result.id).length, 3);
olderReader.remember({ content: 'A separate note created by the old release.', type: 'semantic', scope: 'other' });
olderReader.save(); olderReader.close();

vault = current.Vault.open(options);
assert.equal(vault.consolidateMemories(req).result.id, consolidated.result.id);
const restoreReq = { vault_id: req.vault_id, operation_id: randomUUID(), result_id: consolidated.result.id, expected_result: consolidated.result };
const restored = vault.restoreConsolidation(restoreReq);
assert.deepEqual(restored.restored_entries.map(entry => entry.content), sources.map(entry => entry.content));
vault.save(); vault.close();

const oldAfterRestore = legacy.Vault.open(options);
assert.equal(oldAfterRestore.verifyChain().ok, true);
assert.deepEqual(oldAfterRestore.list().filter(entry => entry.scope === 'writing').map(entry => entry.content), sources.map(entry => entry.content));
oldAfterRestore.editMemory(oldAfterRestore.list().find(entry => entry.scope === 'other').id, { content: 'Old release can still edit independent notes.' });
oldAfterRestore.save(); oldAfterRestore.close();
vault = current.Vault.open(options);
assert.equal(vault.verifyChain().ok, true);
assert.deepEqual(vault.restoreConsolidation(restoreReq).restored_entries.map(entry => entry.id), restored.restored_entries.map(entry => entry.id));
vault.close(); deviceSecret.fill(0);
console.log(JSON.stringify({ passed: true, legacy_version: '0.21.0', evidence_directory: dir, checks: ['legacy-created vault', 'new consolidation', 'old open/list/export/save', 'new exact retry', 'new restore', 'old list restored heads and edit independent note', 'new restore retry'], limits: 'Core reader compatibility only; not packaged desktop or mobile UI, export reimport, or live hosted sync.' }, null, 2));
