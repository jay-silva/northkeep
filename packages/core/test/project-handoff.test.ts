import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { getProjectView, listProjectViews, ProjectHandoffError, validateProjectFileReferences } from '../src/project-handoff.js';
import { mergeProjectDoc, emptyProjectDoc, serializeProjectDoc } from '../src/project-doc.js';
import { Vault, computeEntryHash } from '../src/vault.js';

const PASS='synthetic project handoff passphrase';
const OP='11111111-1111-4111-8111-111111111111';
let directory:string, vaultPath:string, secret:Buffer;
beforeEach(()=>{directory=fs.mkdtempSync(path.join(os.tmpdir(),'northkeep-project-'));vaultPath=path.join(directory,'vault.nkv');secret=generateDeviceSecret();});
afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
function vault(){return Vault.create({path:vaultPath,passphrase:PASS,deviceSecret:secret,kdf:KDF_INTERACTIVE});}
function seed(v:Vault){return v.updateProject({project:'demo',expected_revision:null,what_why:'Why.',status:'Starting.',next_actions:'- [ ] Begin',log_entry:'Created.'});}
function checkpoint(v:Vault,revision:string,overrides:Record<string,unknown>={}){return v.checkpointProject({vault_id:v.getVaultId(),project:'demo',mode:'checkpoint',operation_id:OP,expected_revision:revision,status:'Ready.',completed:'Built the core.',next_actions:'Next.',...overrides});}
function rawDb(v:Vault){return (v as unknown as {db:import('better-sqlite3').Database}).db;}
function rewrite(v:Vault,id:string,patch:{content?:string;metadata?:Record<string,unknown>|null;forgotten_at?:string|null}){const entry=v.list({includeForgotten:true,includeSuperseded:true}).find((x)=>x.id===id)!;const changed={...entry,...patch,entry_hash:''};changed.entry_hash=computeEntryHash(changed);rawDb(v).prepare('UPDATE memories SET content=?, metadata=?, forgotten_at=?, entry_hash=? WHERE id=?').run(changed.content,changed.metadata===null?null:JSON.stringify(changed.metadata),changed.forgotten_at,changed.entry_hash,id);return changed;}

describe('project handoff core',()=>{
  it('creates, lists, reads, and enforces scope grants',()=>{
    const v=vault();const current=seed(v);
    expect(current.revision).toMatch(/-/);expect(listProjectViews(v)[0]).toMatchObject({project:'demo',status:'Starting.',conflict:false});
    expect(getProjectView(v,'demo',['project:demo']).revision).toBe(current.revision);
    expect(()=>getProjectView(v,'demo',[])).toThrowError(expect.objectContaining({code:'scope_denied'}));v.close();
  });

  it('writes an exact checkpoint, replays it after a later edit, and rejects changed reuse',()=>{
    const v=vault();const base=seed(v);const request={vault_id:v.getVaultId(),project:'demo',mode:'checkpoint' as const,operation_id:OP,expected_revision:base.revision,status:'Ready.',completed:'Built the core.',next_actions:'',open_questions:'',files:[]};
    const first=v.checkpointProject(request);expect(first.replayed).toBe(false);expect(first.current.log).toContain('Checkpoint: Built the core.');expect(first.current.next_actions).toBe('');
    const later=v.updateProject({project:'demo',expected_revision:first.current.revision,status:'Later.'});
    const replay=v.checkpointProject(request);expect(replay.replayed).toBe(true);expect(replay.receipt.result_revision).toBe(first.receipt.result_revision);expect(replay.current.revision).toBe(later.revision);
    expect(()=>v.checkpointProject({...request,status:'Changed.'})).toThrowError(expect.objectContaining({code:'operation_conflict'}));v.close();
  });

  it('returns the current view without prior revision text from checkpoint, replay and stale refusals',()=>{
    const v=vault();const r0=seed(v);const r1=v.updateProject({project:'demo',expected_revision:r0.revision,status:'Second.',log_entry:'Edited.'});
    const first=checkpoint(v,r1.revision);expect(first.current.history).toEqual([]);expect(first.current.archives).toEqual([]);expect(first.current.revisions.length).toBeGreaterThan(0);
    expect(checkpoint(v,r1.revision).current.history).toEqual([]);
    try{checkpoint(v,r0.revision,{operation_id:'22222222-2222-4222-8222-222222222222'});throw new Error('expected stale');}catch(e){expect(e).toBeInstanceOf(ProjectHandoffError);expect((e as ProjectHandoffError&{current?:{history:unknown[]}}).current?.history).toEqual([]);}
    v.close();
  });
  it('rejects a hash-valid receipt result whose content does not match the bound request',()=>{
    const v=vault();const base=seed(v);const request={vault_id:v.getVaultId(),project:'demo',mode:'wrap' as const,operation_id:OP,expected_revision:base.revision,status:'Done.',completed:'Finished.',next_actions:'Follow up.'};
    const applied=v.checkpointProject(request);const entry=v.list({scope:'project:demo',includeSuperseded:true}).find((x)=>x.id===applied.receipt.result_revision)!;
    const altered={...entry,content:'## Current Status\n\nA different but hash-valid result.',entry_hash:''};altered.entry_hash=computeEntryHash(altered);
    const db=(v as unknown as {db:import('better-sqlite3').Database}).db;db.prepare('UPDATE memories SET content=?, entry_hash=? WHERE id=?').run(altered.content,altered.entry_hash,altered.id);db.prepare("UPDATE vault_meta SET value=? WHERE key='chain_head'").run(altered.entry_hash);
    expect(()=>v.checkpointProject(request)).toThrowError(expect.objectContaining({code:'operation_conflict'}));v.close();
  });

  it('makes stale and duplicate-head conflicts mutation-free',()=>{
    const v=vault();const base=seed(v);const next=v.updateProject({project:'demo',expected_revision:base.revision,status:'New.'});const before=v.export();
    expect(()=>v.updateProject({project:'demo',expected_revision:base.revision,status:'Stale.'})).toThrowError(expect.objectContaining({code:'stale_project',current:expect.objectContaining({revision:next.revision})}));
    const after=v.export();expect(after.memories).toEqual(before.memories);expect(after.northkeep_export.chain_head).toBe(before.northkeep_export.chain_head);v.close();
  });

  it('rejects unsafe authored sections and validates exact file-reference shape',()=>{
    const v=vault();const base=seed(v);
    for(const status of ['', ' spaces only '.replace(/\S/g,' '), '\nleading', '## Inject'])expect(()=>v.updateProject({project:'demo',expected_revision:base.revision,status})).toThrow(ProjectHandoffError);
    expect(()=>validateProjectFileReferences([{type:'url',label:'Guide',locator:'https://example.invalid',access:'reported_available',checked_at:'2026-09-10',context:'Seen'}])).toThrow();
    expect(()=>validateProjectFileReferences([{type:'url',label:'Guide',locator:'https://example.invalid',access:'reported_available',checked_at:'not-a-date',context:'Seen'}])).toThrow(ProjectHandoffError);
    expect(()=>validateProjectFileReferences([{type:'url',label:'Guide',locator:'https://example.invalid',access:'unverified',extra:true} as never])).toThrow();v.close();
  });

  it('ignores malformed project scope names and reports duplicate live heads without choosing one',()=>{
    const v=vault();seed(v);v.remember({type:'working',scope:'project:Bad',content:'## Current Status\n\nInvalid slug'});v.remember({type:'working',scope:'project:dupe',content:'## Current Status\n\nOne'});v.remember({type:'working',scope:'project:dupe',content:'## Current Status\n\nTwo'});
    expect(listProjectViews(v).map((x)=>x.project)).not.toContain('Bad');expect(listProjectViews(v).find((x)=>x.project==='dupe')).toMatchObject({conflict:true,status:null,revision:null});v.close();
  });

  it('rejects duplicate owned headings without mutation',()=>{
    const v=vault();const entry=v.remember({type:'working',scope:'project:demo',content:'## Current Status\n\nOne\n\n## Current Status\n\nTwo'});const before=v.export();
    expect(()=>v.updateProject({project:'demo',expected_revision:entry.id,status:'Three'})).toThrowError(expect.objectContaining({code:'invalid_request'}));const after=v.export();expect(after.memories).toEqual(before.memories);expect(after.northkeep_export.chain_head).toBe(before.northkeep_export.chain_head);v.close();
  });

  it('keeps an original receipt authoritative after generic edit metadata copying and permits the next handoff',()=>{
    const v=vault();const base=seed(v);const first=checkpoint(v,base.revision);const edited=v.editMemory(first.current.revision,{content:first.current.content+'\n'});
    expect(checkpoint(v,base.revision).replayed).toBe(true);
    const next=checkpoint(v,edited.id,{operation_id:'22222222-2222-4222-8222-222222222222',completed:'Continued.'});expect(next.replayed).toBe(false);v.close();
  });

  it('rejects an unrelated forged receipt copy even when the valid original exists',()=>{
    const v=vault();const base=seed(v);const result=checkpoint(v,base.revision);const owner=v.list({includeSuperseded:true}).find((x)=>x.id===result.receipt.result_revision)!;const unrelated=v.remember({type:'working',scope:'project:demo',content:'Unrelated head'});rewrite(v,unrelated.id,{metadata:owner.metadata});
    expect(()=>checkpoint(v,base.revision)).toThrowError(expect.objectContaining({code:'operation_conflict'}));v.close();
  });

  it('validates required update revisions before mutation',()=>{
    const v=vault();const base=seed(v);const before=v.export();expect(()=>v.updateProject({project:'demo',status:'No revision'} as never)).toThrowError(expect.objectContaining({code:'invalid_request'}));expect(()=>v.updateProject({project:'demo',expected_revision:'short',status:'Bad revision'})).toThrowError(expect.objectContaining({code:'invalid_request'}));expect(v.export().memories).toEqual(before.memories);expect(base.revision).toBeTruthy();v.close();
  });

  it('rejects malformed, ambiguous, and forgotten operation receipts',()=>{
    {const v=vault();const base=seed(v);const result=checkpoint(v,base.revision);const owner=v.list({scope:'project:demo',includeSuperseded:true}).find((x)=>x.id===result.receipt.result_revision)!;rewrite(v,owner.id,{metadata:{northkeep_project_handoff_v1:{operation_id:OP,result_id:owner.id}}});expect(()=>checkpoint(v,base.revision)).toThrowError(expect.objectContaining({code:'operation_conflict'}));v.close();fs.rmSync(vaultPath,{force:true});}
    {const v=vault();const base=seed(v);const result=checkpoint(v,base.revision);const other=v.remember({type:'working',scope:'project:other',content:'Other'});rewrite(v,other.id,{metadata:{northkeep_project_handoff_v1:{...(v.list({includeSuperseded:true}).find((x)=>x.id===result.receipt.result_revision)!.metadata!.northkeep_project_handoff_v1 as object),result_id:other.id}}});expect(()=>checkpoint(v,base.revision)).toThrowError(expect.objectContaining({code:'operation_conflict'}));v.close();fs.rmSync(vaultPath,{force:true});}
    {const v=vault();const base=seed(v);const result=checkpoint(v,base.revision);rewrite(v,result.receipt.result_revision,{forgotten_at:new Date().toISOString()});expect(()=>checkpoint(v,base.revision)).toThrowError(expect.objectContaining({code:'operation_conflict'}));v.close();}
  });

  it('rolls one archive atomically and authenticates its exact payload',()=>{
    const v=vault();let doc=emptyProjectDoc();doc=mergeProjectDoc(doc,{status:'Ready',nextActions:'Next'});for(let i=0;i<45;i++)doc=mergeProjectDoc(doc,{logEntry:`entry ${i} ${'x'.repeat(390)}`},new Date('2026-09-10T12:00:00.000Z'));
    const base=v.remember({type:'working',scope:'project:demo',content:serializeProjectDoc(doc)});const result=checkpoint(v,base.id);expect(result.receipt.archive_ids).toHaveLength(1);
    const archive=result.receipt.archive_ids[0]!;rewrite(v,archive,{content:'## Log archive: demo\n\nForged but hash-valid.'});expect(()=>checkpoint(v,base.id)).toThrowError(expect.objectContaining({code:'operation_conflict'}));v.close();
  });

  it('rolls back archive insertion when the head insert fails',()=>{
    const v=vault();let doc=emptyProjectDoc();doc=mergeProjectDoc(doc,{status:'Ready',nextActions:'Next'});for(let i=0;i<45;i++)doc=mergeProjectDoc(doc,{logEntry:`entry ${i} ${'x'.repeat(390)}`});const base=v.remember({type:'working',scope:'project:demo',content:serializeProjectDoc(doc)});const before=v.export();
    rawDb(v).exec("CREATE TRIGGER fail_project_head BEFORE INSERT ON memories WHEN NEW.source='northkeep:project-handoff' BEGIN SELECT RAISE(ABORT, 'forced head failure'); END");expect(()=>checkpoint(v,base.id)).toThrow();const after=v.export();expect(after.memories).toEqual(before.memories);expect(after.northkeep_export.chain_head).toBe(before.northkeep_export.chain_head);v.close();
  });

  it('returns history newest first, bounded by automatic compaction even when timestamps tie',()=>{
    const v=vault();let current=seed(v);const ids:string[]=[];for(let i=0;i<25;i++){ids.push(current.revision);current=v.updateProject({project:'demo',expected_revision:current.revision,status:`Revision ${i}`});}
    const view=getProjectView(v,'demo',undefined,{history:true});expect(view.history).toHaveLength(5);expect(view.history[0]!.id).toBe(ids.at(-1));expect(view.history.at(-1)!.id).toBe(ids[20]);v.close();
  });
});

describe('project title and delete (owner requests 2026-09-13)',()=>{
  it('sets, replaces, removes a display title as a level-1 heading and keeps owned sections intact',()=>{
    const v=vault();const base=seed(v);
    expect(base.title).toBeNull();
    const titled=v.updateProject({project:'demo',expected_revision:base.revision,title:'Binks Hill STR'});
    expect(titled.title).toBe('Binks Hill STR');expect(titled.content.startsWith('# Binks Hill STR\n\n## What & Why')).toBe(true);
    expect(titled.status).toBe('Starting.');expect(listProjectViews(v)[0]).toMatchObject({title:'Binks Hill STR',status:'Starting.'});
    const renamed=v.updateProject({project:'demo',expected_revision:titled.revision,title:'  Binks Hill (Lincoln NH)  ',status:'Corrected.'});
    expect(renamed.title).toBe('Binks Hill (Lincoln NH)');expect(renamed.status).toBe('Corrected.');expect((renamed.content.match(/^# /gm)||[]).length).toBe(1);
    const cleared=v.updateProject({project:'demo',expected_revision:renamed.revision,title:''});
    expect(cleared.title).toBeNull();expect(cleared.content.startsWith('## What & Why')).toBe(true);expect(cleared.status).toBe('Corrected.');
    for(const bad of ['Log','Current Status','a\nb','x'.repeat(121)]) expect(()=>v.updateProject({project:'demo',expected_revision:cleared.revision,title:bad})).toThrowError(expect.objectContaining({code:'invalid_request'}));
    expect(()=>v.updateProject({project:'demo',expected_revision:base.revision,title:'Stale'})).toThrowError(expect.objectContaining({code:'stale_project'}));
    v.close();
  });

  it('deletes a project by forgetting every entry in its scope, once',()=>{
    const v=vault();const base=seed(v);
    v.updateProject({project:'demo',expected_revision:base.revision,status:'Second revision.'});
    v.remember({type:'semantic',scope:'personal',content:'Unrelated fact.',source:'test'});
    const before=v.list({scope:'project:demo',includeSuperseded:true});expect(before.length).toBe(2);
    expect(v.deleteProject('demo')).toBe(2);
    expect(v.list({scope:'project:demo',includeSuperseded:true,includeForgotten:true}).every((e)=>e.forgotten_at!==null)).toBe(true);
    expect(listProjectViews(v).find((p)=>p.project==='demo')).toBeUndefined();
    expect(()=>getProjectView(v,'demo')).toThrowError(expect.objectContaining({code:'not_found'}));
    expect(()=>v.deleteProject('demo')).toThrowError(expect.objectContaining({code:'not_found'}));
    expect(()=>v.deleteProject('demo',['project:other'])).toThrowError(expect.objectContaining({code:'scope_denied'}));
    expect(v.list({scope:'personal'}).length).toBe(1);
    v.close();
  });
});
