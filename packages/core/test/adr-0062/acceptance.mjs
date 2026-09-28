// ADR 0062 acceptance: runs T1, T2, T3, T4a and T5 against the CLI's vault in $NORTHKEEP_HOME,
// opened with NORTHKEEP_PASSPHRASE and the home's device.secret, and prints one line per case.
//   export NORTHKEEP_HOME="$(mktemp -d)" NORTHKEEP_NO_KEYCHAIN=1 NORTHKEEP_PASSPHRASE=...
//   node packages/cli/dist/index.js init && node packages/core/test/adr-0062/acceptance.mjs
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore, requireTempHome } from './temp-home.mjs';

requireTempHome();
const passphrase = process.env.NORTHKEEP_PASSPHRASE;
if (!passphrase) throw new Error('Set NORTHKEEP_PASSPHRASE to the passphrase given to `init`.');
const C = await loadCore(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'));
const vaultPath = C.defaultVaultPath();
const tag = randomUUID().slice(0, 4);

function outcome(run) {
  try { return run().replayed ? 'replayed' : 'written'; } catch (e) { return { code: e.code, current: e.current !== undefined }; }
}
const code = (o) => (typeof o === 'string' ? o : o.code);

await C.withFileLock(vaultPath, () => {
  const v = C.Vault.open({ path: vaultPath, passphrase, deviceSecret: C.loadDeviceSecret() });
  const revision = (project) => C.getProjectView(v, project).revision;
  const create = (project) => v.updateProject({ project, expected_revision: null, what_why: 'Acceptance.', status: 'Start.', next_actions: '- [ ] Begin' }).revision;
  const updates = (project, n) => { for (let i = 0; i < n; i += 1) v.updateProject({ project, expected_revision: revision(project), status: `Newer status ${i}.` }); };
  const request = (project, operation_id, expected_revision, completed = 'Did X.') => ({
    vault_id: v.getVaultId(), project, mode: 'checkpoint', operation_id, expected_revision,
    status: `Status from ${operation_id.slice(-4)}.`, completed, next_actions: `- [ ] Next from ${operation_id.slice(-4)}`,
  });
  const didX = (project) => C.getProjectView(v, project).content.split('Did X.').length - 1;
  const compacted = (project) => {
    const x = request(project, randomUUID(), create(project));
    v.checkpointProject(x);
    updates(project, 12);
    return x;
  };

  const f1 = `acc-f1-${tag}`;
  const x1 = compacted(f1);
  const resend = outcome(() => v.checkpointProject({ ...x1, expected_revision: revision(f1) }));
  console.log(`F1 resend: ${code(resend)}, "Did X." lines: ${didX(f1)}`);

  const stale = `acc-stale-${tag}`;
  const verbatim = outcome(() => v.checkpointProject(compacted(stale)));
  console.log(`verbatim retry after compaction: ${code(verbatim)}, ${verbatim.current ? 'current document returned' : 'no current document'}`);

  const newest = `acc-newest-${tag}`;
  const x3 = request(newest, randomUUID(), create(newest));
  v.checkpointProject(x3);
  console.log(`verbatim retry of newest: ${code(outcome(() => v.checkpointProject(x3)))}`);

  const carry = `acc-carry-${tag}`;
  const x4 = request(carry, randomUUID(), create(carry));
  const x4Result = v.checkpointProject(x4).receipt.result_revision;
  const edited = v.editMemory(x4Result, { content: `${C.getProjectView(v, carry).content}\nEdited by hand.` }).id;
  v.checkpointProject(request(carry, randomUUID(), edited, 'Did Z.'));
  updates(carry, 5);
  const carryVerbatim = outcome(() => v.checkpointProject(x4));
  const carryHead = outcome(() => v.checkpointProject({ ...x4, expected_revision: revision(carry) }));
  console.log(`carry-forward: ${code(carryVerbatim)} / ${code(carryHead)}`);

  const a = `acc-a-${tag}`, b = `acc-b-${tag}`;
  const x5 = compacted(a);
  create(b);
  console.log(`cross-project: ${code(outcome(() => v.checkpointProject({ ...x5, project: b, expected_revision: revision(b) })))}`);

  v.save();
  v.close();
});
