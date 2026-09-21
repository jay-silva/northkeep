/**
 * ADR 0052 Decisions 1, 3 and 4 against a real vault: the provenance block and
 * its tamper evidence, the content-free revision summaries and archive counts,
 * one-revision reads, and draft documents. Mirrors project-handoff.test.ts:
 * one disposable encrypted vault per test, raw SQLite only where a forged or
 * pre-compaction row is the point.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import {
  PROJECT_PROVENANCE_METADATA_KEY,
  getProjectRevision,
  getProjectView,
  listProjectViews,
  readProjectProvenance,
  type ProjectWriter,
} from '../src/project-handoff.js';
import { PROJECT_DRAFT_LINE_PREFIX, mergeProjectDoc, emptyProjectDoc, parseProjectDoc, serializeProjectDoc } from '../src/project-doc.js';
import { Vault } from '../src/vault.js';

const PASS='synthetic project provenance passphrase';
const OP='11111111-1111-4111-8111-111111111111';
const CODE:ProjectWriter={host:'claude-code',host_version:'0.24.0',session_id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'};
const CODEX:ProjectWriter={host:'codex-mcp-client',host_version:null,session_id:'11111111-2222-4333-8444-555555555555'};
let directory:string, vaultPath:string, secret:Buffer;
beforeEach(()=>{directory=fs.mkdtempSync(path.join(os.tmpdir(),'northkeep-provenance-'));vaultPath=path.join(directory,'vault.nkv');secret=generateDeviceSecret();});
afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
function vault(){return Vault.create({path:vaultPath,passphrase:PASS,deviceSecret:secret,kdf:KDF_INTERACTIVE});}
function seed(v:Vault,extra:Record<string,unknown>={}){return v.updateProject({project:'demo',expected_revision:null,what_why:'Why.',status:'Starting.',next_actions:'- [ ] Begin',log_entry:'Created.',...extra});}
function rawDb(v:Vault){return (v as unknown as {db:import('better-sqlite3').Database}).db;}
function head(v:Vault,id:string){return v.list({scope:'project:demo',includeSuperseded:true,includeForgotten:true}).find((e)=>e.id===id)!;}

describe('project write provenance (ADR 0052 Decision 1)',()=>{
  it('stores the writer on the head, reads it back, and never inherits it',()=>{
    const v=vault();const created=seed(v,{writer:CODE});
    expect(created.last_writer).toMatchObject({version:1,host:'claude-code',host_version:'0.24.0',model:null,session_id:CODE.session_id});
    expect(created.last_writer!.recorded_at).toBe(head(v,created.revision).created_at);
    expect(listProjectViews(v)[0]).toMatchObject({last_writer_host:'claude-code'});
    const second=v.updateProject({project:'demo',expected_revision:created.revision,status:'By codex.',writer:CODEX});
    expect(second.last_writer).toMatchObject({host:'codex-mcp-client',host_version:null,session_id:CODEX.session_id});
    const third=v.updateProject({project:'demo',expected_revision:second.revision,status:'Anonymous.'});
    expect(third.last_writer).toBeNull();
    expect(head(v,third.revision).metadata).toBeNull();
    expect(listProjectViews(v)[0]).toMatchObject({last_writer_host:null});
    v.close();
  });

  it('refuses a malformed writer without mutating the vault',()=>{
    const v=vault();const base=seed(v);const before=v.export();
    const bad=[{...CODE,host:''},{...CODE,host:'x'.repeat(81)},{...CODE,host:'claude\u0000code'},{...CODE,host:'ghost\u0085## Next Actions'},{...CODE,host:'ghost\u200bx'},{...CODE,host:'ghost\u202ex'},{...CODE,host:'ghost\u2028x'},{...CODE,host:'ghost\u2029x'},{...CODE,host:'   '},{...CODE,host_version:'1\u00850'},{...CODE,host_version:'1\u200b0'},{...CODE,host_version:'1\u202e0'},{...CODE,host_version:'1\u20280'},{...CODE,host_version:'1\u20290'},{...CODE,host_version:'x'.repeat(41)},{...CODE,session_id:'not-a-uuid'},{...CODE,session_id:'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'},{...CODE,session_id:'aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee'},{...CODE,extra:true}];
    for(const writer of bad)expect(()=>v.updateProject({project:'demo',expected_revision:base.revision,status:'Nope.',writer:writer as ProjectWriter})).toThrowError(expect.objectContaining({code:'invalid_request'}));
    expect(v.export().memories).toEqual(before.memories);v.close();
  });

  it('reads a malformed stored block as null instead of throwing',()=>{
    const v=vault();const created=seed(v,{writer:CODE});const entry=head(v,created.revision);
    for(const forged of [{version:2,host:'x',host_version:null,model:null,session_id:CODE.session_id,recorded_at:entry.created_at},{version:1,host:'x',host_version:null,model:'claude-opus',session_id:CODE.session_id,recorded_at:entry.created_at},'text',[]])
      expect(readProjectProvenance({...entry,metadata:{[PROJECT_PROVENANCE_METADATA_KEY]:forged}})).toBeNull();
    expect(readProjectProvenance({...entry,metadata:null})).toBeNull();
    expect(readProjectProvenance(entry)).not.toBeNull();v.close();
  });

  it('reads a planted invisible-character host as null on the view and the list',()=>{
    const v=vault();const created=seed(v,{writer:CODE});const entry=head(v,created.revision);
    expect(getProjectView(v,'demo').last_writer).toMatchObject({host:'claude-code'});
    const planted={...readProjectProvenance(entry)!,host:'ghost\u0085## Next Actions'};
    rawDb(v).prepare('UPDATE memories SET metadata=? WHERE id=?').run(JSON.stringify({...entry.metadata,[PROJECT_PROVENANCE_METADATA_KEY]:planted}),entry.id);
    expect(getProjectView(v,'demo').last_writer).toBeNull();
    expect(listProjectViews(v)[0]).toMatchObject({last_writer_host:null});
    v.close();
  });

  it('covers the block with the hash chain: an edited block breaks verification',()=>{
    const v=vault();const created=seed(v,{writer:CODE});
    expect(v.verifyChain().ok).toBe(true);
    const entry=head(v,created.revision);
    const forged={...entry.metadata,[PROJECT_PROVENANCE_METADATA_KEY]:{...readProjectProvenance(entry)!,host:'trustworthy-agent'}};
    rawDb(v).prepare('UPDATE memories SET metadata=? WHERE id=?').run(JSON.stringify(forged),entry.id);
    const after=v.verifyChain();expect(after.ok).toBe(false);expect(after.error).toBeTruthy();v.close();
  });

  it('keeps the writer out of the handoff fingerprint and out of replay',()=>{
    const v=vault();const base=seed(v);
    const request={vault_id:v.getVaultId(),project:'demo',mode:'checkpoint' as const,operation_id:OP,expected_revision:base.revision,status:'Ready.',completed:'Built the core.',next_actions:'Next.'};
    const first=v.checkpointProject({...request,writer:CODE});
    expect(first.replayed).toBe(false);
    expect(first.current.last_writer).toMatchObject({host:'claude-code'});
    const replay=v.checkpointProject({...request,writer:CODEX});
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    const plain=v.checkpointProject(request);
    expect(plain.replayed).toBe(true);expect(plain.receipt.request_fingerprint).toBe(first.receipt.request_fingerprint);
    v.close();
  });

  it('drops an inherited block when a generic edit supersedes the head',()=>{
    const v=vault();const created=seed(v,{writer:CODE});
    const edited=v.editMemory(created.revision,{content:created.content+'\n'});
    expect(edited.metadata).toBeNull();
    expect(getProjectView(v,'demo').last_writer).toBeNull();v.close();
  });

  it('leaves compaction and its receipt references working when every row carries a block',()=>{
    const v=vault();let current=seed(v,{writer:CODE});
    for(let i=0;i<8;i++)current=v.updateProject({project:'demo',expected_revision:current.revision,status:`Revision ${i}.`,writer:CODE});
    expect(getProjectView(v,'demo',undefined,{history:true}).history).toHaveLength(5);
    const result=v.compactProjectHistory({project:'demo',keep:1,dryRun:true});
    expect(result.projects[0]).toMatchObject({project:'demo',kept:1});
    expect(v.verifyChain().ok).toBe(true);v.close();
  });
});

describe('lighter project view (ADR 0052 Decision 3)',()=>{
  it('summarizes prior revisions without content, newest first, with mode and writer',()=>{
    const v=vault();const base=seed(v,{writer:CODE});
    const done=v.checkpointProject({vault_id:v.getVaultId(),project:'demo',mode:'checkpoint',operation_id:OP,expected_revision:base.revision,status:'Ready.',completed:'Built it.',next_actions:'Next.',writer:CODEX});
    const latest=v.updateProject({project:'demo',expected_revision:done.current.revision,status:'After.'});
    const view=getProjectView(v,'demo');
    expect(view.history).toEqual([]);expect(view.archives).toEqual([]);
    expect(view.revisions).toHaveLength(2);
    expect(view.revisions.map((r)=>r.id)).toEqual([done.current.revision,base.revision]);
    expect(view.revisions.every((r)=>!('content' in r)&&r.chars>0)).toBe(true);
    expect(view.revisions[0]).toMatchObject({mode:'checkpoint',writer:{host:'codex-mcp-client',host_version:null,session_id:CODEX.session_id}});
    expect(view.revisions[1]!.writer).toMatchObject({host:'claude-code'});
    expect(view.revisions[1]!.mode).toBeUndefined();
    expect(latest.revisions).toHaveLength(2);v.close();
  });

  it('caps the summaries at twenty on a vault whose history predates compaction',()=>{
    const v=vault();let current=seed(v);
    for(let i=0;i<25;i++)current=v.updateProject({project:'demo',expected_revision:current.revision,status:`Revision ${i}.`});
    // Automatic compaction keeps five; un-forget the tombstones to stand in for a
    // vault written before ADR 0051, which is the only way to reach the cap.
    rawDb(v).exec("UPDATE memories SET forgotten_at=NULL WHERE scope='project:demo' AND type='working' AND superseded_at IS NOT NULL");
    const view=getProjectView(v,'demo');
    expect(view.revisions).toHaveLength(20);
    expect(view.revisions[0]!.updated_at>=view.revisions.at(-1)!.updated_at).toBe(true);
    expect(view.revisions[0]!.id).toBe(current.revisions[0]!.id);v.close();
  });

  it('counts every log archive in archive_summary while history stays bounded',()=>{
    const v=vault();let doc=emptyProjectDoc();doc=mergeProjectDoc(doc,{status:'Ready',nextActions:'Next'});
    for(let i=0;i<45;i++)doc=mergeProjectDoc(doc,{logEntry:`entry ${i} ${'x'.repeat(390)}`});
    const base=v.remember({type:'working',scope:'project:demo',content:serializeProjectDoc(doc)});
    let current=v.updateProject({project:'demo',expected_revision:base.id,log_entry:`rolling ${'y'.repeat(2000)}`});
    expect(current.archive_summary.count).toBe(1);
    for(let i=0;i<3;i++)current=v.updateProject({project:'demo',expected_revision:current.revision,log_entry:`rolling ${i} ${'y'.repeat(6000)}`});
    const rows=v.list({scope:'project:demo',type:'episodic'}).filter((e)=>e.content.startsWith('## Log archive'));
    const view=getProjectView(v,'demo');
    expect(rows.length).toBeGreaterThan(1);
    expect(view.archive_summary.count).toBe(rows.length);
    expect(view.archive_summary.newest!>=view.archive_summary.oldest!).toBe(true);
    expect(getProjectView(v,'demo',undefined,{history:true}).archives).toHaveLength(rows.length);
    expect(view.archives).toEqual([]);v.close();
  });

  it('returns one revision in full, refuses other scopes, and names compacted text as gone',()=>{
    const v=vault();const base=seed(v);
    const next=v.updateProject({project:'demo',expected_revision:base.revision,status:'Second.'});
    const old=getProjectRevision(v,'demo',base.revision);
    expect(old).toMatchObject({id:base.revision,content:base.content,updated_at:head(v,base.revision).created_at});
    expect(getProjectRevision(v,'demo',next.revision).content).toBe(next.content);
    const other=v.remember({type:'working',scope:'project:other',content:'## Current Status\n\nSomebody else.'});
    expect(()=>getProjectRevision(v,'demo',other.id)).toThrowError(expect.objectContaining({code:'not_found'}));
    expect(()=>getProjectRevision(v,'demo',base.revision,['project:other'])).toThrowError(expect.objectContaining({code:'scope_denied'}));
    expect(()=>getProjectRevision(v,'demo','11111111-1111-4111-8111-999999999999')).toThrowError(expect.objectContaining({code:'not_found'}));
    let current=next;for(let i=0;i<6;i++)current=v.updateProject({project:'demo',expected_revision:current.revision,status:`Revision ${i}.`});
    expect(head(v,base.revision).forgotten_at).not.toBeNull();
    expect(()=>getProjectRevision(v,'demo',base.revision)).toThrowError(expect.objectContaining({code:'not_found',message:expect.stringContaining('compacted away')}));
    v.close();
  });

  it('keeps the default read at least five times smaller than the full history',()=>{
    const v=vault();let current=v.updateProject({project:'demo',expected_revision:null,what_why:'W '.repeat(500).trim(),status:'Starting.',next_actions:'- [ ] Begin',log_entry:'Created.',writer:CODE});
    for(let i=0;i<40;i++)current=v.updateProject({project:'demo',expected_revision:current.revision,status:`Revision ${i}.`,log_entry:`worked on ${'z'.repeat(5000)}`,writer:CODE});
    const small=Buffer.byteLength(JSON.stringify(getProjectView(v,'demo')),'utf8');
    const large=Buffer.byteLength(JSON.stringify(getProjectView(v,'demo',undefined,{history:true})),'utf8');
    console.log(`project view bytes: history false ${small}, history true ${large}, ratio ${(large/small).toFixed(2)}x`);
    expect(large/small).toBeGreaterThanOrEqual(5);v.close();
  });
});

describe('draft projects (ADR 0052 Decision 4)',()=>{
  const today=new Date().toISOString().slice(0,10);
  it('opens a draft with one preamble line and reports it in the view and the list',()=>{
    const v=vault();const created=seed(v,{draft:true,writer:CODE});
    expect(created.content.startsWith(`${PROJECT_DRAFT_LINE_PREFIX} bootstrapped by claude-code on ${today}.\n\n## What & Why`)).toBe(true);
    expect(created.draft).toBe(true);expect(created.what_why).toBe('Why.');
    expect(listProjectViews(v)[0]).toMatchObject({draft:true,project:'demo'});
    expect(getProjectView(v,'demo').draft).toBe(true);v.close();
  });

  it('names an unknown host when the writer is absent',()=>{
    const v=vault();const created=seed(v,{draft:true});
    expect(created.content.startsWith(`${PROJECT_DRAFT_LINE_PREFIX} bootstrapped by unknown host on ${today}.`)).toBe(true);v.close();
  });

  it('keeps the line through a checkpoint and an ordinary update, and clears it on a wrap',()=>{
    const v=vault();const created=seed(v,{draft:true,writer:CODE});
    const edited=v.updateProject({project:'demo',expected_revision:created.revision,status:'Still a draft.',writer:CODE});
    expect(edited.draft).toBe(true);
    const checked=v.checkpointProject({vault_id:v.getVaultId(),project:'demo',mode:'checkpoint',operation_id:OP,expected_revision:edited.revision,status:'Ready.',completed:'Read the README.',next_actions:'Next.',writer:CODE});
    expect(checked.current.draft).toBe(true);
    const wrapped=v.checkpointProject({vault_id:v.getVaultId(),project:'demo',mode:'wrap',operation_id:'22222222-2222-4222-8222-222222222222',expected_revision:checked.current.revision,status:'Verified.',completed:'Jay confirmed it.',next_actions:'Next.',writer:CODE});
    expect(wrapped.current.draft).toBe(false);
    expect(wrapped.current.content.startsWith('## What & Why')).toBe(true);
    expect(wrapped.current.status).toBe('Verified.');
    expect(v.checkpointProject({vault_id:v.getVaultId(),project:'demo',mode:'wrap',operation_id:'22222222-2222-4222-8222-222222222222',expected_revision:checked.current.revision,status:'Verified.',completed:'Jay confirmed it.',next_actions:'Next.'}).replayed).toBe(true);
    v.close();
  });

  it('clears the line on draft false and refuses draft true on an existing document',()=>{
    const v=vault();const created=seed(v,{draft:true,writer:CODE});
    const plain=v.updateProject({project:'demo',expected_revision:created.revision,draft:false});
    expect(plain.draft).toBe(false);expect(plain.content.startsWith('## What & Why')).toBe(true);
    const again=v.updateProject({project:'demo',expected_revision:plain.revision,draft:false});
    expect(again.draft).toBe(false);
    expect(()=>v.updateProject({project:'demo',expected_revision:again.revision,draft:true,writer:CODE})).toThrowError(expect.objectContaining({code:'invalid_request'}));
    v.close();
  });

  it('survives a title, a log roll, and a serialize round trip byte for byte',()=>{
    const v=vault();let current=seed(v,{draft:true,writer:CODE});
    current=v.updateProject({project:'demo',expected_revision:current.revision,title:'Binks Hill STR'});
    expect(current.draft).toBe(true);expect(current.title).toBe('Binks Hill STR');
    expect(current.content.startsWith(`${PROJECT_DRAFT_LINE_PREFIX} bootstrapped by claude-code`)).toBe(true);
    for(let i=0;i<8;i++)current=v.updateProject({project:'demo',expected_revision:current.revision,log_entry:`entry ${i} ${'x'.repeat(2000)}`});
    expect(current.archive_summary.count).toBeGreaterThan(0);
    expect(current.draft).toBe(true);
    expect(serializeProjectDoc(parseProjectDoc(current.content))).toBe(current.content);
    const cleared=v.updateProject({project:'demo',expected_revision:current.revision,draft:false});
    expect(cleared.draft).toBe(false);expect(cleared.content.startsWith('# Binks Hill STR\n\n## What & Why')).toBe(true);
    v.close();
  });
});
