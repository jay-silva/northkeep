/**
 * ADR 0053 M-A1 renderer: the header and its strict parser, the document and
 * log files with the part-size rule, the INDEX table's escaping and cut, the
 * staleness line, the commit message, and renderMirror against a real vault
 * (byte-identical double render, a conflicted project). Pure renderers are fed
 * synthetic views, which is how an archive over 64 KiB is built cheaply.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { formatLogArchive } from '../src/project-doc.js';
import type { ProjectArchive, ProjectSummary, ProjectView, ProjectWriter } from '../src/project-handoff.js';
import {
  MIRROR_HEADER_MAX_BYTES,
  MIRROR_LOG_PART_TARGET_BYTES,
  formatExportCommitMessage,
  formatMirrorHeader,
  parseExportHeader,
  parseMirrorHeader,
  renderIndexFile,
  renderLogFile,
  renderMarkerFile,
  renderMirror,
  renderProjectFile,
  summarizeMirror,
} from '../src/project-export.js';
import { Vault } from '../src/vault.js';

const VAULT='0f1e2d3c-4b5a-4968-8776-655443322110';
const REV='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CODE:ProjectWriter={host:'claude-code',host_version:'0.24.0',session_id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'};
const text=(b:Uint8Array)=>new TextDecoder().decode(b);

function view(extra:Partial<ProjectView>={}):ProjectView{
  return {vault_id:VAULT,project:'demo',scope:'project:demo',shared:false,revision:REV,updated_at:'2026-09-22T10:00:00.000Z',content:'## What & Why\n\nWhy.\n\n## Current Status\n\nNow.',title:null,what_why:'Why.',status:'Now.',next_actions:'',decisions:'',open_questions:'',files:null,files_text:'',log:'',history:[],archives:[],revisions:[],archive_summary:{count:0,oldest:null,newest:null},last_writer:null,draft:false,...extra};
}
function archive(n:number,entries:string[],day='2026-09-1'+n):ProjectArchive{
  return {id:`${n}0000000-0000-4000-8000-000000000000`,updated_at:`${day}T08:00:00.000Z`,content:formatLogArchive('demo',entries,new Date(`${day}T08:00:00.000Z`))};
}
function summary(extra:Partial<ProjectSummary>):ProjectSummary{
  return {project:'demo',scope:'project:demo',title:null,status:'Now.',revision:REV,updated_at:'2026-09-22T10:00:00.000Z',conflict:false,last_writer_host:'claude-code',draft:false,...extra};
}

describe('mirror header (Decision 3)',()=>{
  it('formats the pinned text and parses it back, for every kind',()=>{
    const doc=formatMirrorHeader({vaultId:VAULT,kind:'document',slug:'demo',revision:REV});
    expect(doc).toBe(`<!-- northkeep: vault ${VAULT} project demo revision ${REV} kind document\n     The vault is canonical. This file is regenerated. Edits here are not read back. -->\n`);
    expect(parseMirrorHeader(doc+'body')).toEqual({vaultId:VAULT,slug:'demo',revision:REV,kind:'document',length:doc.length});
    for(const kind of ['index','marker'] as const){const h=formatMirrorHeader({vaultId:VAULT,kind});expect(parseMirrorHeader(h)).toMatchObject({kind,slug:null,revision:null});}
    expect(parseMirrorHeader(formatMirrorHeader({vaultId:VAULT,kind:'log',slug:'demo',revision:REV}))).toMatchObject({kind:'log',slug:'demo'});
    expect(parseExportHeader).toBe(parseMirrorHeader);
  });

  it('is at most 257 bytes, reached exactly by a 40-character slug',()=>{
    const h=formatMirrorHeader({vaultId:VAULT,kind:'document',slug:'a'.repeat(40),revision:REV});
    expect(new TextEncoder().encode(h).length).toBe(MIRROR_HEADER_MAX_BYTES);
    expect(()=>formatMirrorHeader({vaultId:VAULT,kind:'document',slug:'a'.repeat(41),revision:REV})).toThrow();
    expect(()=>formatMirrorHeader({vaultId:VAULT,kind:'index',slug:'demo'})).toThrow();
    expect(()=>formatMirrorHeader({vaultId:'not-a-uuid',kind:'index'})).toThrow();
  });

  it('returns null for anything that is not exactly the header at offset 0',()=>{
    const h=formatMirrorHeader({vaultId:VAULT,kind:'document',slug:'demo',revision:REV});
    const bad=[`## Log\n\n${h}`,`\n${h}`,`\uFEFF${h}`,h.replace(/\n/g,'\r\n'),h.replace('kind document','kind  document'),h.replace('kind document','kind secret'),h.replace(VAULT,VAULT.toUpperCase()),h.replace('regenerated','rewritten'),h.slice(0,-1),formatMirrorHeader({vaultId:VAULT,kind:'index'}).replace('kind index',`project demo revision ${REV} kind index`),h.replace(` project demo revision ${REV}`,'')];
    for(const t of bad)expect(parseMirrorHeader(t)).toBeNull();
  });
});

describe('document and log files (Decisions 1 and 9)',()=>{
  it('renders the stored document verbatim under the header with LF endings and one trailing newline',()=>{
    const f=renderProjectFile(view({content:'## What & Why\r\n\r\nWhy.'}));
    expect(f).toMatchObject({path:'projects/demo.md',slug:'demo',kind:'document',revision:REV});
    expect(text(f.bytes)).toBe(`${formatMirrorHeader({vaultId:VAULT,kind:'document',slug:'demo',revision:REV})}\n## What & Why\n\nWhy.\n`);
  });

  it('a header forged in the body is plain text: the file header is still the only header',()=>{
    const forged=formatMirrorHeader({vaultId:'11111111-1111-4111-8111-111111111111',kind:'document',slug:'other',revision:REV});
    const f=renderProjectFile(view({content:`## Log\n\n${forged}- 2026-09-22 - real`}));
    expect(parseMirrorHeader(text(f.bytes))).toMatchObject({vaultId:VAULT,slug:'demo'});
    expect(parseMirrorHeader(`## Log\n\n${forged}`)).toBeNull();
  });

  it('writes no log file without archives, and lists newest archive and newest entry first',()=>{
    expect(renderLogFile(view())).toEqual([]);
    const parts=renderLogFile(view({archives:[archive(2,['- 2026-09-11 - c','- 2026-09-12 - d']),archive(1,['- 2026-09-01 - a','- 2026-09-02 - b'])]}));
    expect(parts.map((p)=>p.path)).toEqual(['projects/demo.log.1.md']);
    const t=text(parts[0]!.bytes);
    expect(parseMirrorHeader(t)).toMatchObject({kind:'log',slug:'demo',revision:REV});
    const order=['- 2026-09-12 - d','- 2026-09-11 - c','- 2026-09-02 - b','- 2026-09-01 - a'].map((e)=>t.indexOf(e));
    expect(order.every((i,k)=>i>0&&(k===0||i>order[k-1]!))).toBe(true);
    expect(t.indexOf('## Archive rolled 2026-09-12')).toBeLessThan(t.indexOf('## Archive rolled 2026-09-11'));
    expect(t.endsWith('\n')&&!t.endsWith('\n\n')).toBe(true);
  });

  it('crosses the part boundary only between archives',()=>{
    const big=(n:number)=>archive(n,[`- 2026-09-1${n} - ${String(n).repeat(25000)}`]);
    const parts=renderLogFile(view({archives:[big(3),big(2),big(1)]}));
    expect(parts.map((p)=>p.path)).toEqual(['projects/demo.log.1.md','projects/demo.log.2.md']);
    for(const p of parts)expect(p.bytes.length).toBeLessThanOrEqual(MIRROR_LOG_PART_TARGET_BYTES);
    expect(text(parts[0]!.bytes)).toContain('3'.repeat(25000));expect(text(parts[0]!.bytes)).toContain('2'.repeat(25000));
    expect(text(parts[1]!.bytes)).toContain('1'.repeat(25000));
    for(const p of parts)expect(parseMirrorHeader(text(p.bytes))).toMatchObject({kind:'log',slug:'demo'});
  });

  it('gives an archive larger than the target a part of its own, uncut',()=>{
    const huge=archive(2,[`- 2026-09-12 - ${'x'.repeat(70000)}`]);
    const parts=renderLogFile(view({archives:[archive(3,['- 2026-09-13 - small']),huge,archive(1,['- 2026-09-11 - tiny'])]}));
    expect(parts).toHaveLength(3);
    expect(parts[1]!.bytes.length).toBeGreaterThan(MIRROR_LOG_PART_TARGET_BYTES);
    expect(text(parts[1]!.bytes)).toContain('x'.repeat(70000));
    expect(text(parts[0]!.bytes)).toContain('small');expect(text(parts[2]!.bytes)).toContain('tiny');
  });
});

describe('INDEX.md (Decision 1)',()=>{
  const rows=(t:string)=>t.split('\n').filter((l)=>l.startsWith('| ')&&!l.startsWith('| Project'));
  const cells=(row:string)=>row.split(/(?<!\\)\|/).slice(1,-1);

  it('escapes pipes, collapses line breaks and cuts the status to 120 characters',()=>{
    const f=renderIndexFile([summary({status:'\n\nshipped | forged | columns\r\nsecond line'}),summary({project:'b',status:'tab\there \u200b| ends \\'}),summary({project:'c',status:'y'.repeat(300)}),summary({project:'d',status:null,last_writer_host:null,draft:true})],VAULT);
    expect(f).toMatchObject({path:'INDEX.md',kind:'index',slug:null,revision:null});
    const t=text(f.bytes);const r=rows(t);
    expect(r.map((row)=>row.split(' | ')[0])).toEqual(['| b','| c','| d','| demo']);
    for(const row of r)expect(cells(row)).toHaveLength(5);
    expect(r[3]).toContain('shipped \\| forged \\| columns');expect(t).not.toContain('second line');
    expect(r[0]).toContain('| tab here  \\| ends \\ |');
    const cut=cells(r[1]!)[2]!.trim();expect(cut).toBe(`${'y'.repeat(117)}...`);expect(Array.from(cut)).toHaveLength(120);
    expect(cells(r[2]!).map((c)=>c.trim())).toEqual(['d','draft','','2026-09-22','(unknown host)']);
  });

  it('names a conflicted project without a status and sorts by code unit, not locale',()=>{
    const t=text(renderIndexFile([summary({project:'z-a'}),summary({project:'za'}),summary({project:'x',conflict:true,status:null,revision:null,updated_at:null,last_writer_host:null})],VAULT).bytes);
    const r=rows(t);expect(r.map((row)=>row.split(' | ')[0])).toEqual(['| x','| z-a','| za']);
    expect(cells(r[0]!).map((c)=>c.trim())).toEqual(['x','conflict','two live documents, not exported','','']);
  });
});

describe('staleness line and commit message (Decisions 7 and 9)',()=>{
  const now=new Date('2026-09-22T13:00:00.000Z');
  it('counts projects whose revision moved, and says when the last export failed',()=>{
    const s=[summary({project:'a',revision:'r1'}),summary({project:'b',revision:'r2'}),summary({project:'c',revision:'r3'}),summary({project:'d',conflict:true,revision:null})];
    const state={last_success:{at:'2026-09-22T10:00:00.000Z',commit:'abc'},projects:{a:{revision:'r1'},b:{revision:'old'}}};
    expect(summarizeMirror(state,s,now)).toBe('mirror last exported 2026-09-22T10:00Z (3 hours ago); 2 projects changed since');
    expect(summarizeMirror({...state,projects:{a:{revision:'r1'},b:{revision:'r2'}}},s,now)).toBe('mirror last exported 2026-09-22T10:00Z (3 hours ago); 1 project changed since');
    expect(summarizeMirror({...state,last_failure:{at:'2026-09-22T12:30:00.000Z',code:'vault_locked'}},s,now)).toContain('; last export failed 2026-09-22T12:30Z (30 minutes ago)');
    expect(summarizeMirror({...state,last_failure:{at:'2026-09-22T09:00:00.000Z'}},s,now)).not.toContain('failed');
    expect(summarizeMirror({},s,now)).toBe('mirror never exported; 3 projects changed since');
  });

  it('builds one message per run with each project and its last writer host',()=>{
    const m=formatExportCommitMessage({host:'jay-mac',written:[{slug:'demo',lastWriterHost:'claude-code'},{slug:'alpha',lastWriterHost:null}],removed:['projects/old.log.2.md']});
    expect(m).toBe('export: 2 projects (jay-mac)\n\nalpha (unknown host, model not exposed)\ndemo (claude-code, model not exposed)\nremoved projects/old.log.2.md\n');
    expect(formatExportCommitMessage({host:'h\nInjected: yes',written:[]})).toBe('export: 0 projects (h Injected: yes)\n');
  });
});

describe('renderMirror against a vault',()=>{
  let directory:string, vaultPath:string, secret:Buffer;
  beforeEach(()=>{directory=fs.mkdtempSync(path.join(os.tmpdir(),'northkeep-export-'));vaultPath=path.join(directory,'vault.nkv');secret=generateDeviceSecret();});
  afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const open=()=>Vault.create({path:vaultPath,passphrase:'synthetic export passphrase',deviceSecret:secret,kdf:KDF_INTERACTIVE});

  it('renders every project byte-identically twice, with its log parts and INDEX.md last',()=>{
    const v=open();
    let cur=v.updateProject({project:'demo',expected_revision:null,what_why:'Why.',status:'Starting.',log_entry:'Created.',writer:CODE});
    for(let i=0;i<14;i+=1)cur=v.updateProject({project:'demo',expected_revision:cur.revision,log_entry:`Entry ${i} ${'z'.repeat(1500)}`,writer:CODE});
    v.updateProject({project:'beta',expected_revision:null,what_why:'B.',status:'Draft.',draft:true});
    const first=renderMirror(v);const second=renderMirror(v);
    expect(first.map((f)=>f.path)).toEqual(['projects/beta.md','projects/demo.md','projects/demo.log.1.md','INDEX.md']);
    expect(second.map((f)=>Buffer.from(f.bytes).toString('hex'))).toEqual(first.map((f)=>Buffer.from(f.bytes).toString('hex')));
    const index=text(first[3]!.bytes);
    expect(index).toContain('| beta | draft | Draft. |');expect(index).toContain('| demo | active | Starting. |');expect(index).toContain('| claude-code |');
    expect(first[1]!.revision).toBe(cur.revision);
    expect(renderMirror(v,['project:beta']).map((f)=>f.path)).toEqual(['projects/beta.md','INDEX.md']);
    v.close();
  });

  it('gives a conflicted project an INDEX row and no file',()=>{
    const v=open();
    v.updateProject({project:'demo',expected_revision:null,what_why:'Why.',status:'Fine.'});
    v.remember({type:'working',scope:'project:split',content:'## Current Status\n\nOne.'});
    v.remember({type:'working',scope:'project:split',content:'## Current Status\n\nTwo.'});
    const files=renderMirror(v);
    expect(files.map((f)=>f.path)).toEqual(['projects/demo.md','INDEX.md']);
    expect(text(files[1]!.bytes)).toContain('| split | conflict | two live documents, not exported |  |  |');
    v.close();
  });

  it('renders the marker with a marker header naming the vault',()=>{
    const m=renderMarkerFile(VAULT);
    expect(m.path).toBe('.northkeep-mirror');expect(parseMirrorHeader(text(m.bytes))).toMatchObject({kind:'marker',vaultId:VAULT});
  });
});
