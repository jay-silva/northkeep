// Writes the T4b fixture with the v0.22.0 core: checkpoint X, a memory edit that copies
// X's receipt forward, then checkpoint Z on the edited revision. No ledger anywhere.
//   OLD=<v0.22.0 checkout, built> OUT=<fixtures dir> node make-v0220-fixture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { loadCore, requireTempHome } from './temp-home.mjs';

const home = requireTempHome();
const C = await loadCore(process.env.OLD);
const out = process.env.OUT;
const passphrase = 'synthetic adr-0062 v0.22.0 fixture passphrase';
const secret = C.generateDeviceSecret();
const file = path.join(home, 'fixture.nkv');
const v = C.Vault.create({ path: file, passphrase, deviceSecret: secret, kdf: C.KDF_INTERACTIVE });
const project = 'carry';
const base = v.updateProject({ project, expected_revision: null, what_why: 'Why.', status: 'Start.', next_actions: '- [ ] Begin' }).revision;
const xRequest = {
  vault_id: v.getVaultId(), project, mode: 'checkpoint', operation_id: '0062f1f1-0000-4000-8000-00000000000a',
  expected_revision: base, status: 'Old status from X.', completed: 'Did X.', next_actions: '- [ ] old next from X',
};
const xResult = v.checkpointProject(xRequest).receipt.result_revision;
const edited = v.editMemory(xResult, { content: `${C.getProjectView(v, project).content}\nEdited by hand.` }).id;
const zRequest = {
  vault_id: v.getVaultId(), project, mode: 'checkpoint', operation_id: '0062f1f1-0000-4000-8000-00000000000b',
  expected_revision: edited, status: 'Status from Z.', completed: 'Did Z.', next_actions: '- [ ] next from Z',
};
const zResult = v.checkpointProject(zRequest).receipt.result_revision;
if (!v.verifyChain().ok) throw new Error('fixture chain broken');
if (JSON.stringify(v.export()).includes('northkeep_operations_v1')) throw new Error('the old core wrote a ledger');
v.save();
v.close();
fs.copyFileSync(file, path.join(out, 'v0220-carry-forward.nkv'));
fs.writeFileSync(path.join(out, 'v0220-carry-forward.json'), `${JSON.stringify({
  note: 'Synthetic test fixture written by the v0.22.0 core (packages/core/test/adr-0062/make-v0220-fixture.sh). Not a real vault.',
  passphrase, device_secret_hex: secret.toString('hex'), x_request: xRequest, x_result: xResult, edited_revision: edited, z_result: zResult,
}, null, 2)}\n`);
console.log(`wrote ${path.join(out, 'v0220-carry-forward.nkv')} (vault ${xRequest.vault_id})`);
