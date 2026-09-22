/**
 * ADR 0053 Decision 10: planImport as the dry run and Vault.importProject as
 * the write. Covers the command repo shape (title block, extra headings, Open
 * Questions / Risks, a 200-entry Log, a document over the cap) with a
 * nothing-lost check over every source line, refusal of an existing slug with
 * zero mutation, and a round trip of NorthKeep's own rendered mirror.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { PROJECT_DOC_MAX_CHARS, PROJECT_LOG_ARCHIVE_HEADING, splitLogEntries } from '../src/project-doc.js';
import { getProjectView, type ProjectWriter } from '../src/project-handoff.js';
import { formatMirrorHeader, renderMirror, splitLogArchive } from '../src/project-export.js';
import { PROJECT_IMPORT_OVERFLOW_HEADING, PROJECT_IMPORT_OVERFLOW_PART_MAX_BYTES, PROJECT_IMPORT_OVERFLOW_POINTER, formatImportedLogArchive, joinImportOverflowParts, planImport, splitImportOverflow } from '../src/project-import.js';
import { Vault, projectScopeInUse } from '../src/vault.js';

const PASS='synthetic project import passphrase';
const CODE:ProjectWriter={host:'claude-code',host_version:'0.24.0',session_id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'};
let directory:string, secret:Buffer;
beforeEach(()=>{directory=fs.mkdtempSync(path.join(os.tmpdir(),'northkeep-import-'));secret=generateDeviceSecret();});
afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
function vault(name='vault.nkv'){return Vault.create({path:path.join(directory,name),passphrase:PASS,deviceSecret:secret,kdf:KDF_INTERACTIVE});}
function scopeContents(v:Vault,slug:string){return v.list({scope:`project:${slug}`}).map((e)=>e.content);}

/** A synthetic file in the Command Repo's shape; entry i is dated so newest comes first. */
function commandRepoFile():string{
  const day=(i:number)=>new Date(Date.UTC(2026,0,1)+i*86400000).toISOString().slice(0,10);
  const log=Array.from({length:200},(_,k)=>199-k).map((i)=>`- ${day(i)} (Agent ${i%3}) - Entry number ${i} ${'detail '.repeat(20)}`).join('\n\n');
  return [
    '# Sample Project','','**Area:** Software','**State:** Active','',
    '## What & Why','','A sample of the command repo shape.','',
    '## Current Status','','As of 2026-09-22 the thing works.','Second status line.','',
    '## Direction shift (2026-08-22, Jay)','','Changed course.','',
    '## Next Actions','','- Ship it.','- Test it.','',
    '## Decisions','','- 2026-08-01 - Chose the boring option.','',
    '## Blueprint','',Array.from({length:300},(_,i)=>`Blueprint line ${i} ${'spec '.repeat(8)}`).join('\n'),'',
    '## Links & Locations','','- Repo: somewhere','- Docs: elsewhere','',
    '## Log','',log,'',
    '## Open Questions / Risks','','- Will it scale?','',
  ].join('\n');
}

describe('planImport (dry run)',()=>{
  it('plans the command repo shape: maps headings, archives old entries with their dates, overflows extras, loses nothing',()=>{
    const source=commandRepoFile();expect(source.length).toBeGreaterThan(PROJECT_DOC_MAX_CHARS);
    const input=Object.freeze([Object.freeze({name:'sample.md',text:source})]);
    const plan=planImport(input as {name:string;text:string}[]);
    expect(input[0]!.text).toBe(source);
    expect(plan.skipped).toEqual([]);
    const p=plan.projects[0]!;
    expect(p.slug).toBe('sample');
    expect(p.sections.find((s)=>s.from==='Open Questions / Risks')!.to).toBe('Open Questions');
    expect(p.sections.find((s)=>s.from==='Blueprint')!.to).toBe('Blueprint');
    expect(p.document.length).toBeLessThanOrEqual(PROJECT_DOC_MAX_CHARS);
    expect(p.overflow_sections).toEqual(['Blueprint','Links & Locations']);
    expect(p.overflow!.startsWith(`${PROJECT_IMPORT_OVERFLOW_HEADING}: sample\n`)).toBe(true);
    expect(p.archived_entries).toBe(190);
    expect(p.largest_row_bytes).toBe(Math.max(...[p.document,...p.archives,...p.overflow_parts].map((r)=>Buffer.byteLength(r))));
    expect(p.archives.length).toBeGreaterThan(1);
    for(const a of p.archives){expect(a.startsWith(`${PROJECT_LOG_ARCHIVE_HEADING}: sample\n`)).toBe(true);expect(a.length).toBeLessThanOrEqual(PROJECT_DOC_MAX_CHARS);}
    const archived=p.archives.flatMap((a)=>splitLogArchive(a).entries);
    expect(archived[0]).toContain('Entry number 0 ');expect(archived.at(-1)).toContain('Entry number 189 ');
    expect(archived[0]!.startsWith('- 2026-01-01 (Agent 0) - ')).toBe(true);
  });

  it('moves an owned section too large for the cap whole, leaving a pointer, after the Log has shrunk',()=>{
    const log=Array.from({length:30},(_,k)=>`- 2026-02-${String(28-k).padStart(2,'0')} - ${'long entry '.repeat(120)}`).join('\n');
    const source=`# Big\n\n## What & Why\n\nWhy.\n\n## Current Status\n\n${'status '.repeat(3000)}\n\n## Decisions\n\n- 2026-01-01 - Kept.\n\n## Log\n\n${log}`;
    const p=planImport([{name:'big.md',text:source}]).projects[0]!;
    expect(p.overflow_sections).toEqual(['Current Status']);
    expect(p.document).toContain(`## Current Status\n\n${PROJECT_IMPORT_OVERFLOW_POINTER}`);
    expect(p.document.length).toBeLessThanOrEqual(PROJECT_DOC_MAX_CHARS);
    expect(p.archived_entries).toBeGreaterThan(20);
    const v=vault();v.importProject(p);
    const out=scopeContents(v,'big').flatMap((c)=>c.split('\n'));
    expect(source.split('\n').filter((l)=>l.trim()&&!out.includes(l))).toEqual([]);v.close();
  });

  it('skips index and marker files, bad names, near-miss headers, duplicate owned sections and orphan logs, each with a reason',()=>{
    const vid='0f1e2d3c-4b5a-4968-8776-655443322110';const rev='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const doc=formatMirrorHeader({vaultId:vid,kind:'document',slug:'demo',revision:rev});
    const dbl=formatMirrorHeader({vaultId:vid,kind:'document',slug:'double',revision:rev});
    const plan=planImport([
      {name:'INDEX.md',text:`${formatMirrorHeader({vaultId:vid,kind:'index'})}\n| x |`},
      {name:'.northkeep-mirror.md',text:`${formatMirrorHeader({vaultId:vid,kind:'marker'})}\nmarker`},
      {name:'_TEMPLATE.md',text:'## What & Why\n\nTemplate.'},
      {name:'notes.txt',text:'hello'},
      {name:'crlf.md',text:doc.replace(/\n/g,'\r\n').replace('<!--',' <!--')+'## What & Why\r\n\r\nX.'},
      {name:'twice.md',text:'## Open Questions\n\nA\n\n## Open Questions / Risks\n\nB'},
      {name:'ghost.log.1.md',text:`${formatMirrorHeader({vaultId:vid,kind:'log',slug:'ghost',revision:rev})}\n# Log archives: ghost\n`},
      {name:'renamed.md',text:`${doc}\n## What & Why\n\nMoved.`},
      {name:'forged.md',text:`## Log\n\n${doc}- 2026-09-22 - real entry`},
      {name:'double.md',text:`${dbl}\n${dbl}## What & Why\n\nX.`},
      {name:'gap.md',text:'## What & Why\n\nGap.'},
      {name:'gap.log.2.md',text:`${formatMirrorHeader({vaultId:vid,kind:'log',slug:'gap',revision:rev})}\n# Log archives: gap\n`},
    ]);
    const reasons=Object.fromEntries(plan.skipped.map((s)=>[s.name,s.reason]));
    expect(Object.keys(reasons).sort()).toEqual(['.northkeep-mirror.md','INDEX.md','_TEMPLATE.md','crlf.md','double.md','gap.md','ghost.log.1.md','notes.txt','renamed.md','twice.md']);
    // The dry run applies the write's own checks, so a plan it lists is one importProject accepts.
    expect(reasons['double.md']).toMatch(/still carries a NorthKeep header/);expect(reasons['gap.md']).toMatch(/without gaps/);
    expect(reasons['INDEX.md']).toMatch(/INDEX/);expect(reasons['crlf.md']).toMatch(/not exact/);expect(reasons['twice.md']).toMatch(/Open Questions/);
    expect(reasons['ghost.log.1.md']).toMatch(/no importable ghost\.md/);expect(reasons['renamed.md']).toMatch(/not demo\.md/);
    // A header forged in body text is content, not a header: it is not stripped and not trusted.
    expect(plan.projects.map((p)=>p.slug)).toEqual(['forged']);
    expect(plan.projects[0]!.document).toContain('<!-- northkeep: vault');
  });

  it('formats an imported archive with the heading getProjectView finds, oldest first',()=>{
    const a=formatImportedLogArchive('demo',['- 2026-01-01 - a','- 2026-01-02 - b'],'demo.md\nInjected');
    expect(a.split('\n')[0]).toBe('## Log archive: demo');expect(a).toContain('Imported from demo.md Injected by');
    expect(splitLogArchive(a).entries).toEqual(['- 2026-01-01 - a','- 2026-01-02 - b']);
  });
});

describe('Vault.importProject (the write)',()=>{
  it('writes document, archives and overflow in one go, with every source line present and no provenance block',()=>{
    const v=vault();const source=commandRepoFile();const p=planImport([{name:'sample.md',text:source}]).projects[0]!;
    const view=v.importProject(p);
    expect(view.title).toBe('Sample Project');expect(view.open_questions).toBe('- Will it scale?');
    expect(splitLogEntries(view.log)).toHaveLength(10);expect(view.log).toContain('Entry number 199 ');
    expect(view.archives).toHaveLength(p.archives.length);expect(view.last_writer).toBeNull();
    expect(v.list({scope:'project:sample'}).every((e)=>e.metadata===null)).toBe(true);
    const out=scopeContents(v,'sample').flatMap((c)=>c.split('\n'));
    const missing=source.split('\n').filter((line)=>line.trim().length>0).map((line)=>line==='## Open Questions / Risks'?'## Open Questions':line).filter((line)=>!out.includes(line));
    expect(missing).toEqual([]);
    expect(scopeContents(v,'sample').filter((c)=>c.startsWith(PROJECT_IMPORT_OVERFLOW_HEADING))).toHaveLength(1);
    expect(v.verifyChain().ok).toBe(true);
    v.updateProject({project:'sample',expected_revision:view.revision,status:'Imported and edited.'});
    v.close();
  });

  it('splits a bobby-hood-sized overflow into numbered rows under the cap, losing nothing',()=>{
    const status=Array.from({length:2600},(_,i)=>`Status line ${i} ${'observed detail '.repeat(4)}`).join('\n');
    const log=Array.from({length:400},(_,k)=>`- 2026-03-${String(1+(k%28)).padStart(2,'0')} - Entry ${k} ${'work done '.repeat(40)}`).join('\n');
    const links=Array.from({length:600},(_,i)=>`- Link ${i}: somewhere/${'x'.repeat(40)}`).join('\n');
    const source=`# Bobby\n\n## What & Why\n\nWhy.\n\n## Current Status\n\n${status}\n\n## Links & Locations\n\n${links}\n\n## Log\n\n${log}`;
    expect(Buffer.byteLength(source)).toBeGreaterThan(330000);
    const p=planImport([{name:'bobby.md',text:source}]).projects[0]!;
    expect(Buffer.byteLength(p.overflow!)).toBeGreaterThan(3*PROJECT_IMPORT_OVERFLOW_PART_MAX_BYTES);
    const m=p.overflow_parts.length;expect(m).toBeGreaterThan(3);
    p.overflow_parts.forEach((part,i)=>{expect(Buffer.byteLength(part)).toBeLessThanOrEqual(PROJECT_IMPORT_OVERFLOW_PART_MAX_BYTES);expect(part.startsWith(`${PROJECT_IMPORT_OVERFLOW_HEADING}: bobby (part ${i+1} of ${m})\n\n`)).toBe(true);});
    expect(joinImportOverflowParts(p.overflow_parts)).toBe(p.overflow);
    expect(p.largest_row_bytes).toBeLessThanOrEqual(60000);
    const v=vault();v.importProject(p);
    const rows=v.list({scope:'project:bobby'});
    expect(rows.every((e)=>Buffer.byteLength(e.content)<=65536)).toBe(true);
    expect(joinImportOverflowParts(rows.filter((e)=>e.content.startsWith(PROJECT_IMPORT_OVERFLOW_HEADING)).map((e)=>e.content))).toBe(p.overflow);
    const out=rows.flatMap((e)=>e.content.split('\n'));
    expect(source.split('\n').filter((l)=>l.trim()&&!out.includes(l))).toEqual([]);
    v.close();
  });

  it('cuts only a line longer than a part, at code points, and says so in that part',()=>{
    const text=`first line\n${'\u{1F600}'.repeat(40000)}\nlast line\n`;
    const parts=splitImportOverflow('demo',text);
    expect(joinImportOverflowParts(parts)).toBe(text);
    for(const part of parts){expect(Buffer.byteLength(part)).toBeLessThanOrEqual(PROJECT_IMPORT_OVERFLOW_PART_MAX_BYTES);expect(part).not.toMatch(/\uFFFD/);}
    const noted=parts.filter((part)=>part.split('\n')[1]!.startsWith('A source line longer'));
    expect(noted.length).toBeGreaterThanOrEqual(3);
    expect(parts[0]!.startsWith(`${PROJECT_IMPORT_OVERFLOW_HEADING}: demo (part 1 of ${parts.length})\n`)).toBe(true);
    expect(splitImportOverflow('demo','a\nb\n')).toEqual([`${PROJECT_IMPORT_OVERFLOW_HEADING}: demo (part 1 of 1)\n\na\nb\n`]);
  });

  it('refuses a slug that already has a live document, with zero mutation',()=>{
    const v=vault();v.updateProject({project:'sample',expected_revision:null,what_why:'Existing.',status:'Here.'});
    const before=v.export().memories;const p=planImport([{name:'sample.md',text:commandRepoFile()}]).projects[0]!;
    expect(()=>v.importProject(p)).toThrowError(expect.objectContaining({code:'stale_project',message:'Project sample already has entries in this vault; delete the project from the Projects page first.'}));
    expect(v.export().memories).toEqual(before);expect(v.verifyChain().ok).toBe(true);
    expect(()=>v.importProject(p,['project:other'])).toThrowError(expect.objectContaining({code:'scope_denied'}));
    expect(()=>v.importProject({...p,slug:'fresh',document:`${formatMirrorHeader({vaultId:v.getVaultId(),kind:'index'})}x`,archives:[],overflow:null})).toThrowError(expect.objectContaining({code:'invalid_request'}));
    expect(()=>v.importProject({...p,slug:'fresh'})).toThrowError(expect.objectContaining({code:'invalid_request'}));
    expect(v.export().memories).toEqual(before);v.close();
  });

  it('refuses a slug whose document was forgotten but whose archives remain, and says so in a dry run (review F6, S2)',()=>{
    const v=vault();const p=planImport([{name:'sample.md',text:commandRepoFile()}]).projects[0]!;
    expect(projectScopeInUse(v,'sample')).toBe(false);
    v.importProject(p);expect(projectScopeInUse(v,'sample')).toBe(true);
    const working=v.list({scope:'project:sample',type:'working'});expect(working).toHaveLength(1);
    v.forget(working[0]!.id);
    expect(projectScopeInUse(v,'sample')).toBe(true);
    const before=v.export().memories;
    expect(()=>v.importProject(p)).toThrowError(expect.objectContaining({code:'stale_project',message:'Project sample already has entries in this vault; delete the project from the Projects page first.'}));
    expect(v.export().memories).toEqual(before);
    expect(v.list({scope:'project:sample'}).filter((e)=>e.content.startsWith(PROJECT_LOG_ARCHIVE_HEADING))).toHaveLength(p.archives.length);
    for(const e of v.list({scope:'project:sample'}))v.forget(e.id);
    expect(projectScopeInUse(v,'sample')).toBe(false);
    expect(v.importProject(p).project).toBe('sample');
    v.close();
  });

  it('round-trips NorthKeep\'s own rendered mirror: document identical, log reattached, index skipped, no header stored',()=>{
    const a=vault('a.nkv');
    let cur=a.updateProject({project:'demo',expected_revision:null,title:'Demo',what_why:'Why.',status:'Starting.',log_entry:'Created.',draft:true,writer:CODE});
    for(let i=0;i<14;i+=1)cur=a.updateProject({project:'demo',expected_revision:cur.revision,log_entry:`Entry ${i} ${'z'.repeat(1500)}`});
    a.updateProject({project:'plain',expected_revision:null,what_why:'P.',status:'Plain.'});
    const original=getProjectView(a,'demo',undefined,{history:true});
    expect(original.archives.length).toBeGreaterThan(0);expect(splitLogEntries(original.log).length).toBeLessThanOrEqual(10);
    const files=renderMirror(a).map((f)=>({name:path.basename(f.path),text:new TextDecoder().decode(f.bytes)}));
    const plan=planImport(files);
    expect(plan.skipped).toEqual([{name:'INDEX.md',reason:expect.stringContaining('INDEX')}]);
    expect(plan.projects.find((p)=>p.slug==='demo')!.log_files).toEqual(['demo.log.1.md']);
    const b=vault('b.nkv');for(const p of plan.projects)b.importProject(p);
    const copy=getProjectView(b,'demo',undefined,{history:true});
    expect(copy.content).toBe(original.content);expect(copy.draft).toBe(true);expect(copy.title).toBe('Demo');
    const entries=(v:typeof original)=>v.archives.flatMap((x)=>splitLogArchive(x.content).entries);
    expect(entries(copy)).toEqual(entries(original));
    expect(getProjectView(b,'plain').content).toBe(getProjectView(a,'plain').content);
    expect(b.list({includeSuperseded:true}).some((e)=>e.content.includes('<!-- northkeep:'))).toBe(false);
    expect(copy.archives[0]!.content).toMatch(/demo\.log\.1\.md, archive rolled \d{4}-\d{2}-\d{2}/);
    a.close();b.close();
  });
});
