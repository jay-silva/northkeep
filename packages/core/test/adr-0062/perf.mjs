// ADR 0062 perf gates. MODE=shared: both cores open copies of one head-built fixture (C14).
// MODE=separate: each core builds its own vault (C15). Prints one result line and exits 3 on a breach
// (REL_LIMIT_PCT, default 20; ABS_LIMIT_MS, default 2).
//   NEW=<this checkout> OLD=<v0.22.0 checkout> MODE=shared|separate MEMS=<n> node perf.mjs
import fs from 'node:fs';
import path from 'node:path';
import { loadCore, requireTempHome } from './temp-home.mjs';

const home = requireTempHome();
const NEW = await loadCore(process.env.NEW);
const OLD = await loadCore(process.env.OLD);
const MODE = process.env.MODE;
const MEMS = Number(process.env.MEMS ?? 0);
if (MODE !== 'shared' && MODE !== 'separate') throw new Error('MODE must be shared or separate');
const KEY = 'northkeep_operations_v1';
const PROJECTS = 30, CHECKPOINTS = 24, PROBES = 200;
const secret = NEW.generateDeviceSecret();
const options = (C, name) => ({ path: path.join(home, `${name}.nkv`), passphrase: 'synthetic adr-0062 perf passphrase', deviceSecret: secret, kdf: C.KDF_INTERACTIVE });
let counter = 0;
const nextId = () => `0062ffff-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function build(C, name) {
  const v = C.Vault.create(options(C, name));
  for (let p = 0; p < PROJECTS; p += 1) {
    let revision = v.updateProject({ project: `p${p}`, expected_revision: null, what_why: 'W.', status: 'S.', next_actions: '- [ ] N' }).revision;
    for (let i = 0; i < CHECKPOINTS; i += 1) {
      revision = v.checkpointProject({ vault_id: v.getVaultId(), project: `p${p}`, mode: 'checkpoint', operation_id: nextId(), expected_revision: revision, status: `S${i}.`, completed: `C${i}.`, next_actions: 'N.' }).receipt.result_revision;
    }
  }
  for (let i = 0; i < MEMS; i += 1) v.remember({ content: `memory ${i} ${'q'.repeat(200)}`, type: 'semantic', scope: 'personal', source: 'test' });
  v.save();
  v.close();
}

if (MODE === 'shared') {
  build(NEW, 'fixture');
  fs.copyFileSync(path.join(home, 'fixture.nkv'), path.join(home, 'trunk.nkv'));
  fs.copyFileSync(path.join(home, 'fixture.nkv'), path.join(home, 'head.nkv'));
} else {
  build(OLD, 'trunk');
  build(NEW, 'head');
}
const trunk = OLD.Vault.open(options(OLD, 'trunk'));
const head = NEW.Vault.open(options(NEW, 'head'));

const carriers = head.list({ includeSuperseded: true }).filter((e) => e.metadata && KEY in e.metadata);
const perProject = new Map();
for (const e of carriers) perProject.set(e.scope, (perProject.get(e.scope) ?? 0) + 1);
const rows = [...perProject.values()];
const full = carriers.every((e) => e.metadata[KEY].length === 16);

function timed(C, v, project) {
  const request = { vault_id: v.getVaultId(), project, mode: 'checkpoint', operation_id: nextId(), expected_revision: C.getProjectView(v, project).revision, status: 'S.', completed: 'D.', next_actions: 'N.' };
  const start = performance.now();
  v.checkpointProject(request);
  return performance.now() - start;
}
const t = { trunk: [], head: [] };
for (let i = 0; i < PROBES; i += 1) {
  const project = `p${i % PROJECTS}`;
  t.trunk.push(timed(OLD, trunk, project));
  t.head.push(timed(NEW, head, project));
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return (s[PROBES / 2 - 1] + s[PROBES / 2]) / 2; };
const mt = median(t.trunk), mh = median(t.head);
console.log(`${MODE.padEnd(8)} mems=${String(MEMS).padEnd(5)} ledger rows/project ${Math.min(...rows)}..${Math.max(...rows)} all full: ${full}  trunk ${mt.toFixed(2)} ms  head ${mh.toFixed(2)} ms  +${(mh - mt).toFixed(2)} ms  ${(100 * (mh / mt - 1)).toFixed(1)}%`);
trunk.close();
head.close();
const relLimit = Number(process.env.REL_LIMIT_PCT ?? 20), absLimit = Number(process.env.ABS_LIMIT_MS ?? 2);
const breach = MODE === 'shared' ? 100 * (mh / mt - 1) > relLimit : mh - mt > absLimit;
if (breach) {
  console.log(`FAIL ${MODE === 'shared' ? `C14: head exceeds trunk by more than ${relLimit}%` : `C15: head adds more than ${absLimit} ms`}`);
  process.exitCode = 3;
}
