/**
 * Review F2 and F3 of ADR 0053 M-A1 import: the live ten are the newest by
 * date whatever the source order, archive notes say the order they really
 * hold, and no imported row passes 60,000 bytes, with the split parts
 * joining back to the source exactly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { parseProjectDoc, serializeProjectDoc } from '../src/project-doc.js';
import { getProjectView } from '../src/project-handoff.js';
import { formatMirrorHeader, renderMirror, splitLogArchive } from '../src/project-export.js';
import { PROJECT_IMPORT_ROW_MAX_BYTES, joinImportedLogArchiveParts, planImport } from '../src/project-import.js';
import { Vault } from '../src/vault.js';

const PASS='synthetic import order passphrase';
let directory:string, secret:Buffer;
beforeEach(()=>{directory=fs.mkdtempSync(path.join(os.tmpdir(),'northkeep-import-order-'));secret=generateDeviceSecret();});
afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
function vault(name='vault.nkv'){return Vault.create({path:path.join(directory,name),passphrase:PASS,deviceSecret:secret,kdf:KDF_INTERACTIVE});}
const day=(i:number)=>`2026-09-${String(i).padStart(2,'0')}`;
const liveLog=(document:string)=>parseProjectDoc(document).sections.find((s)=>s.title==='Log')!.body;
const rows=(v:Vault,slug:string)=>v.list({scope:`project:${slug}`}).map((e)=>e.content);
function allLinesPresent(source:string,out:string[]){const lines=out.flatMap((c)=>c.split('\n'));return source.split('\n').filter((l)=>l.trim()&&!lines.includes(l));}

describe('Log order on import (review F2)',()=>{
  it('keeps the newest ten live for an oldest-first log and archives the rest truly oldest first',()=>{
    const source=`# OldFirst\n\n## Current Status\n\nstatus\n\n## Log\n\n`+Array.from({length:15},(_,i)=>`- ${day(i+1)} - day ${i+1}`).join('\n')+'\n';
    const p=planImport([{name:'oldfirst.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('by date');
    expect(liveLog(p.document)).toBe(Array.from({length:10},(_,k)=>`- ${day(15-k)} - day ${15-k}`).join('\n'));
    expect(p.archives).toHaveLength(1);
    expect(splitLogArchive(p.archives[0]!).entries).toEqual([1,2,3,4,5].map((i)=>`- ${day(i)} - day ${i}`));
    expect(splitLogArchive(p.archives[0]!).note).toContain('Oldest first.');
    const v=vault();const view=v.importProject(p);
    expect(view.log.split('\n')[0]).toBe(`- ${day(15)} - day 15`);
    expect(allLinesPresent(source,rows(v,'oldfirst'))).toEqual([]);v.close();
  });

  it('keeps source order and says so when an entry has no readable date, dropping nothing',()=>{
    const entries=Array.from({length:12},(_,k)=>k===4?'- undated note':`- ${day(12-k)} - e${12-k}`);
    const source=`# Mixed\n\n## Log\n\n${entries.join('\n')}`;
    const p=planImport([{name:'mixed.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('source order');
    expect(liveLog(p.document)).toBe(entries.slice(0,10).join('\n'));
    const archive=splitLogArchive(p.archives[0]!);
    expect(archive.entries).toEqual([entries[11],entries[10]]);
    expect(archive.note).not.toContain('Oldest first');expect(archive.note).toContain('reverse source order');
    expect(p.archived_entries).toBe(2);
  });

  it('orders a bold-date log by date, one entry per bold date paragraph',()=>{
    const paras=Array.from({length:12},(_,i)=>`**${day(i+1)}** - entry ${i+1}\ncontinued ${i+1}, mentioning - 2020-01-01 inline`);
    const source=`# Bold\n\n## Log\n\n${paras.join('\n\n')}\n\n## Open Questions\n\n- q`;
    const p=planImport([{name:'bold.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('by date');expect(p.archived_entries).toBe(2);
    expect(liveLog(p.document).split('\n')[0]).toBe(`**${day(12)}** - entry 12`);
    expect(splitLogArchive(p.archives[0]!).entries.join('\n')).toBe(`${paras[0]}\n${paras[1]}`);
    expect(parseProjectDoc(p.document).sections.find((s)=>s.title==='Open Questions')!.body).toBe('- q');
  });

  it('orders a heading log by the date in each heading, keeping each section whole',()=>{
    const secs=Array.from({length:12},(_,i)=>`### ${day(i+1)} (session ${i+1})\n\nDid thing ${i+1}.\n\n- detail ${i+1}`);
    const source=`# Heads\n\n## Current Status\n\ns\n\n## Log\n\n${secs.join('\n\n')}\n\n## Open Questions\n\n- q`;
    const p=planImport([{name:'heads.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('by date');expect(p.archived_entries).toBe(2);
    const titles=parseProjectDoc(p.document).sections.map((s)=>s.title);
    expect(titles).toEqual(['Heads','Current Status','Log',...Array.from({length:10},(_,k)=>`${day(12-k)} (session ${12-k})`),'Open Questions']);
    expect(splitLogArchive(p.archives[0]!).entries.join('\n')).toContain('### 2026-09-01 (session 1)');
    const v=vault();v.importProject(p);expect(allLinesPresent(source,rows(v,'heads'))).toEqual([]);v.close();
  });

  it('leaves an already newest-first log byte for byte, same-day entries in their written order',()=>{
    const source=`# Bobby\n\n## Log\n\n- 2026-09-22 16:15 (Bobby) - post\n\n- 2026-09-22 09:00 (Bobby) - pre\n\n- 2026-09-22 09:22 (Bobby) - amendment\n\n- 2026-09-21 (Bobby) - older`;
    const p=planImport([{name:'bobby.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('by date');expect(p.document).toBe(serializeProjectDoc(parseProjectDoc(source)));
  });
});

describe('Row cap on import (review F3)',()=>{
  const fat=`# Fat\n\n## Current Status\n\ns\n\n## Log\n\n- 2026-09-01 - ${'q'.repeat(200000)}\n- 2026-09-02 - small\n`;

  it('splits one 200 KB entry into archive rows under 60,000 bytes that join back exactly, and reports sizes',()=>{
    const plan=planImport([{name:'fatentry.md',text:fat}]);const p=plan.projects[0]!;
    const all=[p.document,...p.archives,...p.overflow_parts];
    for(const row of all)expect(Buffer.byteLength(row)).toBeLessThanOrEqual(PROJECT_IMPORT_ROW_MAX_BYTES);
    expect(p.archives.length).toBeGreaterThanOrEqual(4);
    expect(joinImportedLogArchiveParts(p.archives)).toBe(`- 2026-09-01 - ${'q'.repeat(200000)}`);
    expect(p.largest_row_bytes).toBe(Math.max(...all.map((r)=>Buffer.byteLength(r))));
    expect(p.total_bytes).toBe(all.reduce((n,r)=>n+Buffer.byteLength(r),0));
    expect(plan.total_bytes).toBe(p.total_bytes);expect(plan.largest_row_bytes).toBe(p.largest_row_bytes);
    const v=vault();v.importProject(p);
    for(const r of rows(v,'fatentry'))expect(Buffer.byteLength(r)).toBeLessThanOrEqual(PROJECT_IMPORT_ROW_MAX_BYTES);
    v.close();
  });

  it('splits a long multi-line entry on line boundaries and a long emoji line at code points, joining back exactly',()=>{
    const lines=Array.from({length:3000},(_,i)=>`line ${i} ${'x'.repeat(40)}`).join('\n');
    const entry=`- 2026-09-01 - start\n${lines}\n${'\u{1F600}'.repeat(40000)}\nend`;
    const source=`# Multi\n\n## Log\n\n${entry}\n- 2026-09-02 - small`;
    const p=planImport([{name:'multi.md',text:source}]).projects[0]!;
    for(const a of p.archives){expect(Buffer.byteLength(a)).toBeLessThanOrEqual(PROJECT_IMPORT_ROW_MAX_BYTES);expect(a).not.toMatch(/�/);expect(a.startsWith('## Log archive: multi\n\n')).toBe(true);}
    expect(joinImportedLogArchiveParts(p.archives)).toBe(entry);
    const v=vault();v.importProject(p);
    const missing=allLinesPresent(source,rows(v,'multi'));
    expect(missing).toEqual([`${'\u{1F600}'.repeat(40000)}`]);v.close();
  });

  it('splits an oversized archive section in a reattached log file and refuses a non-date archive heading',()=>{
    const vid='0f1e2d3c-4b5a-4968-8776-655443322110';const rev='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const head=formatMirrorHeader({vaultId:vid,kind:'log',slug:'re',revision:rev});
    const big=`${head}\n# Log archives: re\n\n## Archive rolled 2026-09-01\n\n- 2026-09-01 - ${'r'.repeat(150000)}\n`;
    const ok=planImport([{name:'re.md',text:'## What & Why\n\nW.'},{name:'re.log.1.md',text:big}]);
    const p=ok.projects[0]!;
    for(const a of p.archives)expect(Buffer.byteLength(a)).toBeLessThanOrEqual(PROJECT_IMPORT_ROW_MAX_BYTES);
    expect(joinImportedLogArchiveParts(p.archives)).toBe(`- 2026-09-01 - ${'r'.repeat(150000)}`);
    const bad=planImport([{name:'re.md',text:'## What & Why\n\nW.'},{name:'re.log.1.md',text:`${head}\n# Log archives: re\n\n## Archive rolled ${'x'.repeat(100000)}\n\n- 2026-09-01 - a\n`}]);
    expect(bad.projects).toEqual([]);
    expect(bad.skipped[0]!.reason).toMatch(/unexpected heading/);expect(bad.skipped[0]!.reason.length).toBeLessThan(200);
  });

  it('round-trips a split entry through the mirror with every row still under the cap',()=>{
    const a=vault('a.nkv');a.importProject(planImport([{name:'fatentry.md',text:fat}]).projects[0]!);
    const files=renderMirror(a).map((f)=>({name:path.basename(f.path),text:new TextDecoder().decode(f.bytes)}));
    const plan=planImport(files);expect(plan.skipped.map((s)=>s.name)).toEqual(['INDEX.md']);
    const b=vault('b.nkv');for(const p of plan.projects)b.importProject(p);
    for(const r of rows(b,'fatentry'))expect(Buffer.byteLength(r)).toBeLessThanOrEqual(PROJECT_IMPORT_ROW_MAX_BYTES);
    const text=(v:Vault)=>getProjectView(v,'fatentry',undefined,{history:true}).archives.slice().reverse().flatMap((x)=>splitLogArchive(x.content).entries).join('');
    expect(text(b)).toBe(text(a));expect(text(b)).toBe(`- 2026-09-01 - ${'q'.repeat(200000)}`);
    a.close();b.close();
  });
});
