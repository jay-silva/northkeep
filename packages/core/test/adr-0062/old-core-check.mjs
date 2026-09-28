// T7 (ADR 0062): a vault written by this checkout's core opens, verifies, exports and compacts
// on the v0.22.0 core, whose writes carry the ledger forward; this core then reopens it clean.
//   NEW=<this checkout, built> OLD=<v0.22.0 checkout, built> node old-core-check.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadCore, requireTempHome } from './temp-home.mjs';

const home = requireTempHome();
const NEW = await loadCore(process.env.NEW);
const OLD = await loadCore(process.env.OLD);
const KEY = 'northkeep_operations_v1';
const file = path.join(home, 't7.nkv');
const options = { path: file, passphrase: 'synthetic adr-0062 t7 passphrase', deviceSecret: NEW.generateDeviceSecret(), kdf: NEW.KDF_INTERACTIVE };
const id = (n) => `0062eeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const headOf = (C, v) => v.getEntry(C.getProjectView(v, 'a').revision);
const ledger = (entry) => JSON.stringify(entry.metadata?.[KEY] ?? null);
const checkpoint = (v, C, n) => v.checkpointProject({ vault_id: v.getVaultId(), project: 'a', mode: 'checkpoint', operation_id: id(n), expected_revision: C.getProjectView(v, 'a').revision, status: `S${n}.`, completed: `Did ${n}.`, next_actions: `- [ ] N${n}` });
const forgottenWithKey = (v) => v.list({ includeSuperseded: true, includeForgotten: true }).filter((e) => e.forgotten_at && e.metadata && KEY in e.metadata).length;
const ok = (label, value) => console.log(`ok  ${label}${value === undefined ? '' : `: ${value}`}`);

{
  const v = NEW.Vault.create(options);
  v.updateProject({ project: 'a', expected_revision: null, what_why: 'W.', status: 'S.', next_actions: '- [ ] N' });
  for (let n = 0; n < 20; n += 1) checkpoint(v, NEW, n);
  assert.equal(headOf(NEW, v).metadata[KEY].length, 16);
  assert.equal(v.verifyChain().ok, true);
  v.save(); v.close();
  ok('head core wrote 20 checkpoints; head ledger holds', 16);
}
{
  const v = OLD.Vault.open(options);
  assert.equal(v.verifyChain().ok, true); ok('v0.22.0 verifyChain on the head-written vault');
  assert.ok(JSON.stringify(v.export()).includes(KEY)); ok('v0.22.0 export() contains the key');
  const before = ledger(headOf(OLD, v));
  v.updateProject({ project: 'a', expected_revision: OLD.getProjectView(v, 'a').revision, status: 'Old update.' });
  assert.equal(ledger(headOf(OLD, v)), before); ok('v0.22.0 updateProject carries the ledger unchanged');
  checkpoint(v, OLD, 100);
  assert.equal(ledger(headOf(OLD, v)), before); ok('v0.22.0 checkpointProject carries the ledger unchanged (no append)');
  v.editMemory(headOf(OLD, v).id, { content: `${OLD.getProjectView(v, 'a').content}\nOld edit.` });
  assert.equal(ledger(headOf(OLD, v)), before); ok('v0.22.0 editMemory carries the ledger unchanged');
  const compacted = v.compactProjectHistory({ keep: 1 });
  assert.ok(compacted.blanked > 0); ok('v0.22.0 compactProjectHistory({ keep: 1 }) blanked', compacted.blanked);
  assert.equal(forgottenWithKey(v), 0); ok('blanked rows carrying the key', 0);
  assert.equal(v.verifyChain().ok, true); ok('v0.22.0 verifyChain after its writes');
  v.save(); v.close();
}
{
  const v = NEW.Vault.open(options);
  assert.equal(v.verifyChain().ok, true); ok('head core reopens and verifies');
  v.close();
}
