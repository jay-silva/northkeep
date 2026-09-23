/**
 * Review F2 and F3 of ADR 0053 M-A1 import: the live ten are the newest by
 * date whatever the source order, archive notes say the order they really
 * hold, and no imported row passes 60,000 bytes, with the split parts
 * joining back to the source exactly. The Log-shape fixes: a partly dated Log
 * keeps the newest entries live whichever way it runs, and a heading Log
 * becomes dash entries every reader of the live Log sees.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { parseProjectDoc, serializeProjectDoc } from '../src/project-doc.js';
import { getProjectView } from '../src/project-handoff.js';
import { formatMirrorHeader, renderMirror, splitLogArchive } from '../src/project-export.js';
import { splitLogEntries } from '../src/project-doc.js';
import { newestLogDate } from '../src/project-board.js';
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
/** Line text without indent or its heading or bullet marker, for a heading Log that import re-shapes (an output line may carry an added date prefix). */
const bare=(l:string)=>l.trimStart().replace(/^(?:#{1,6} |- )/,'');
function allTextPresent(source:string,out:string[]){const lines=new Set(out.flatMap((c)=>c.split('\n')).flatMap((l)=>[bare(l),bare(l).replace(/^\d{4}-\d{2}-\d{2} - /,'')]));return source.split('\n').filter((l)=>l.trim()&&!lines.has(bare(l)));}

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

  it('keeps a newest-first source order and says so when an entry has no readable date, dropping nothing',()=>{
    const entries=Array.from({length:12},(_,k)=>k===4?'- undated note':`- ${day(12-k)} - e${12-k}`);
    const source=`# Mixed\n\n## Log\n\n${entries.join('\n')}`;
    const p=planImport([{name:'mixed.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('source order');
    expect(liveLog(p.document)).toBe(entries.slice(0,10).join('\n'));
    const archive=splitLogArchive(p.archives[0]!);
    expect(archive.entries).toEqual([entries[11],entries[10]]);
    expect(archive.note).not.toContain('Oldest first');expect(archive.note).toContain('not sorted by date');
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

  it('orders a heading log by the date in each heading, storing each as one dash entry',()=>{
    const secs=Array.from({length:12},(_,i)=>`### ${day(i+1)} (session ${i+1})\n\nDid thing ${i+1}.\n\n- detail ${i+1}`);
    const source=`# Heads\n\n## Current Status\n\ns\n\n## Log\n\n${secs.join('\n\n')}\n\n## Open Questions\n\n- q`;
    const p=planImport([{name:'heads.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('by date');expect(p.archived_entries).toBe(2);
    expect(parseProjectDoc(p.document).sections.map((s)=>s.title)).toEqual(['Heads','Current Status','Log','Open Questions']);
    const live=splitLogEntries(liveLog(p.document));
    expect(live).toHaveLength(10);
    expect(live[0]).toBe(`- ${day(12)} (session 12)\n\n    Did thing 12.\n\n    - detail 12`);
    expect(live[9]!.split('\n')[0]).toBe(`- ${day(3)} (session 3)`);
    expect(p.sections.filter((m)=>m.from.startsWith('2026-')).every((m)=>m.to==='Log')).toBe(true);
    expect(splitLogArchive(p.archives[0]!).entries.map((e)=>e.split('\n')[0])).toEqual([`- ${day(1)} (session 1)`,`- ${day(2)} (session 2)`]);
    const v=vault();const view=v.importProject(p);
    expect(splitLogEntries(view.log)).toEqual(live);
    expect(allTextPresent(source,rows(v,'heads'))).toEqual([]);v.close();
  });

  it('leaves an already newest-first log byte for byte, same-day entries in their written order',()=>{
    const source=`# Bobby\n\n## Log\n\n- 2026-09-22 16:15 (Bobby) - post\n\n- 2026-09-22 09:00 (Bobby) - pre\n\n- 2026-09-22 09:22 (Bobby) - amendment\n\n- 2026-09-21 (Bobby) - older`;
    const p=planImport([{name:'bobby.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('by date');expect(p.document).toBe(serializeProjectDoc(parseProjectDoc(source)));
  });
});

describe('Partly dated Log direction',()=>{
  it('keeps the newest live for an oldest-first log with one undated entry past the live limit',()=>{
    const entries=Array.from({length:12},(_,i)=>i===6?'- undated note between days 6 and 8':`- ${day(i+1)} - e${i+1}`);
    const source=`# Asc\n\n## Current Status\n\ns\n\n## Log\n\n${entries.join('\n')}\n`;
    const p=planImport([{name:'asc.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('source order reversed');
    expect(liveLog(p.document)).toBe([...entries].reverse().slice(0,10).join('\n'));
    expect(liveLog(p.document).split('\n')[0]).toBe(`- ${day(12)} - e12`);
    const archive=splitLogArchive(p.archives[0]!);
    expect(archive.entries).toEqual([entries[0],entries[1]]);
    expect(archive.note).toContain('not sorted by date');expect(archive.note).not.toContain('Oldest first.');
    expect(p.archived_entries).toBe(2);
    const v=vault();const view=v.importProject(p);
    const lines=view.log.split('\n');
    expect(lines[0]).toBe(`- ${day(12)} - e12`);
    expect(lines.indexOf('- undated note between days 6 and 8')).toBe(lines.indexOf(`- ${day(8)} - e8`)+1);
    expect(lines.indexOf('- undated note between days 6 and 8')).toBe(lines.indexOf(`- ${day(6)} - e6`)-1);
    expect(allLinesPresent(source,rows(v,'asc'))).toEqual([]);v.close();
  });

  it('keeps undated entries at either end beside their neighbours when an oldest-first log is turned',()=>{
    const entries=['- undated first',...Array.from({length:11},(_,i)=>`- ${day(i+1)} - e${i+1}`),'- undated last'];
    const p=planImport([{name:'ends.md',text:`# Ends\n\n## Log\n\n${entries.join('\n')}`}]).projects[0]!;
    expect(p.log_order).toBe('source order reversed');
    expect(liveLog(p.document)).toBe(['- undated last',...Array.from({length:9},(_,k)=>`- ${day(11-k)} - e${11-k}`)].join('\n'));
    expect(splitLogArchive(p.archives[0]!).entries).toEqual(['- undated first',`- ${day(1)} - e1`,`- ${day(2)} - e2`]);
  });

  it('reads the direction from most adjacent dated pairs, so one year typo at an end does not flip it',()=>{
    const entries=['- 2099-01-01 - typo',...Array.from({length:10},(_,i)=>`- ${day(i+1)} - e${i+1}`),'- undated'];
    const p=planImport([{name:'typo.md',text:`# Typo\n\n## Log\n\n${entries.join('\n')}`}]).projects[0]!;
    expect(p.log_order).toBe('source order reversed');
    expect(liveLog(p.document).split('\n').slice(0,2)).toEqual(['- undated',`- ${day(10)} - e10`]);
    expect(splitLogArchive(p.archives[0]!).entries).toEqual(['- 2099-01-01 - typo',`- ${day(1)} - e1`]);
  });

  it('leaves a log with no dated direction as written',()=>{
    const source=`# Plain\n\n## Log\n\n- first note\n- 2026-09-01 - only dated\n- last note`;
    const p=planImport([{name:'plain.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('source order');expect(p.document).toBe(serializeProjectDoc(parseProjectDoc(source)));
  });
});

describe('Heading Log shape',()=>{
  const small=`# Small\n\n## Current Status\n\ns\n\n## Log\n\n### 2026-09-10 shipped\n\nText ten.\n\n#### Detail\n\n- sub point\n\n### Week of 2026-09-01\n\nWeek text.\n\n### Undated retro\n\nRetro text.\n\n## Open Questions\n\n- q`;

  it('converts a short, already ordered heading log into dash entries the live Log reads; an undated heading joins the entry above',()=>{
    const p=planImport([{name:'small.md',text:small}]).projects[0]!;
    expect(p.log_order).toBe('by date');expect(p.archives).toEqual([]);
    expect(parseProjectDoc(p.document).sections.map((s)=>s.title)).toEqual(['Small','Current Status','Log','Open Questions']);
    expect(splitLogEntries(liveLog(p.document))).toEqual([
      '- 2026-09-10 shipped\n\n    Text ten.\n\n    #### Detail\n\n    - sub point',
      '- 2026-09-01 - Week of 2026-09-01\n\n    Week text.\n\n    ### Undated retro\n\n    Retro text.',
    ]);
    const v=vault();const view=v.importProject(p);
    expect(splitLogEntries(view.log)).toHaveLength(2);
    expect(newestLogDate(view.log,new Date('2026-09-23T12:00:00.000Z'))).toBe('2026-09-10');
    expect(allTextPresent(small,rows(v,'small'))).toEqual([]);v.close();
  });

  it('round-trips a converted heading log through the mirror unchanged',()=>{
    const secs=Array.from({length:12},(_,i)=>`### ${day(i+1)} (session ${i+1})\n\nDid thing ${i+1}.\n\n- detail ${i+1}`);
    const a=vault('a.nkv');const first=a.importProject(planImport([{name:'heads.md',text:`# Heads\n\n## Log\n\n${secs.join('\n\n')}`}]).projects[0]!);
    const files=renderMirror(a).map((f)=>({name:path.basename(f.path),text:new TextDecoder().decode(f.bytes)}));
    const plan=planImport(files);expect(plan.skipped.map((s)=>s.name)).toEqual(['INDEX.md']);
    const b=vault('b.nkv');const second=b.importProject(plan.projects[0]!);
    expect(second.log).toBe(first.log);
    const hist=(v:Vault)=>getProjectView(v,'heads',undefined,{history:true}).archives.flatMap((x)=>splitLogArchive(x.content).entries);
    expect(hist(b)).toEqual(hist(a));a.close();b.close();
  });
});


describe('Heading Log review round 1 (FW1, FW2)',()=>{
  const f8="# Proj\n\n## What & Why\n\nWhy.\n\n## Current Status\n\nOK.\n\n## Log\n\n\n### 2026-09-01 first\n\nRan:\n\n```md\n### not a heading, markdown sample\n- nor a bullet\n```\n\n### 2026-09-02 second\n\nbody two\n\n### 2026-09-03 third\n\nbody three\n\n## Decisions\n\n- 2026-09-01 d";
  const f19="# Proj\n\n## What & Why\n\nWhy.\n\n## Current Status\n\nOK.\n\n## Log\n\n\n### 2026-09-01 a\nx\n### Next Actions\n- do the thing";
  const f21="# Proj\n\n## Log\n\n### 2026-09-01 first\n\ndid one\n\n### Notes\n\nnote about first\n\n### 2026-09-02 second\n\ndid two\n\n### Follow-up\n\nfollow-up about second\n\n### 2026-09-03 third\n\ndid three\n";
  /** Non-blank lines of the source Log, in order, found in order in the output (indent and heading or bullet markers aside). */
  function inOrder(sourceLog:string,out:string){const want=sourceLog.split('\n').filter((l)=>l.trim()).map(bare);const got=out.split('\n').map(bare);let i=0;for(const line of got){if(i<want.length&&line===want[i])i+=1;}return want.slice(i);}

  it('f8: a heading-looking line inside a code fence is never a heading and never rewritten, and the text stays in order',()=>{
    const p=planImport([{name:'f8.md',text:f8}]).projects[0]!;
    expect(p.log_order).toBe('by date');
    const log=liveLog(p.document);
    const live=splitLogEntries(log);
    expect(live.map((e)=>e.split('\n')[0])).toEqual(['- 2026-09-03 third','- 2026-09-02 second','- 2026-09-01 first']);
    expect(live[2]).toBe('- 2026-09-01 first\n\n    Ran:\n\n    ```md\n    ### not a heading, markdown sample\n    - nor a bullet\n    ```');
    expect(log).not.toContain('- not a heading');
    expect(parseProjectDoc(p.document).sections.map((s)=>s.title)).toEqual(['Proj','What & Why','Current Status','Log','Decisions']);
    // The pre-fix import's content, in source order within the one entry that holds it.
    const firstEntry=f8.slice(f8.indexOf('### 2026-09-01'),f8.indexOf('### 2026-09-02'));
    expect(inOrder(firstEntry,live[2]!)).toEqual([]);
    const v=vault();v.importProject(p);expect(allTextPresent(f8,rows(v,'f8'))).toEqual([]);v.close();
  });

  it('f21: an undated same-level heading is text of the dated entry above it, never an entry of its own',()=>{
    const p=planImport([{name:'f21.md',text:f21}]).projects[0]!;
    expect(p.log_order).toBe('by date');
    const live=splitLogEntries(liveLog(p.document));
    expect(live).toEqual([
      '- 2026-09-03 third\n\n    did three',
      '- 2026-09-02 second\n\n    did two\n\n    ### Follow-up\n\n    follow-up about second',
      '- 2026-09-01 first\n\n    did one\n\n    ### Notes\n\n    note about first',
    ]);
  });

  it('f19: an owned section nested under the Log stays a section, so Next Actions is populated',()=>{
    const p=planImport([{name:'f19.md',text:f19}]).projects[0]!;
    expect(p.sections.find((m)=>m.from==='Next Actions')!.to).toBe('Next Actions');
    const v=vault();const view=v.importProject(p);
    expect(view.next_actions).toBe('- do the thing');
    expect(splitLogEntries(view.log)).toEqual(['- 2026-09-01 a\n\n    x']);
    v.close();
  });

  it('keeps text before the first dated heading as the Log preamble, on top',()=>{
    const source=`# Pre\n\n## Log\n\n### About this log\n\nOldest first.\n\n### 2026-09-01 one\n\na\n\n### 2026-09-02 two\n\nb`;
    const p=planImport([{name:'pre.md',text:source}]).projects[0]!;
    expect(liveLog(p.document)).toBe('    ### About this log\n\n    Oldest first.\n- 2026-09-02 two\n\n    b\n- 2026-09-01 one\n\n    a');
    expect(parseProjectDoc(p.document).sections.map((s)=>s.title)).toEqual(['Pre','Log']);
  });

  it('leaves a heading Log with no dated heading as written, and ignores an unclosed fence',()=>{
    const undated=`# U\n\n## Log\n\n### Notes\n\nn\n\n### More\n\nm`;
    const p=planImport([{name:'u.md',text:undated}]).projects[0]!;
    expect(p.document).toBe(serializeProjectDoc(parseProjectDoc(undated)));
    const open=`# O\n\n## Log\n\n### 2026-09-01 one\n\n\`\`\`\nnever closed\n\n### 2026-09-02 two\n\nb`;
    const q=planImport([{name:'o.md',text:open}]).projects[0]!;
    expect(splitLogEntries(liveLog(q.document)).map((e)=>e.split('\n')[0])).toEqual(['- 2026-09-02 two','- 2026-09-01 one']);
  });
});

describe('Dash Log preamble (review round 1 note)',()=>{
  it('keeps prose before the first entry on top when an oldest-first partly dated Log is turned',()=>{
    const entries=Array.from({length:12},(_,i)=>i===4?'- undated':`- ${day(i+1)} - e${i+1}`);
    const source=`# Pre\n\n## Log\n\nOldest first; newest at the bottom.\n${entries.join('\n')}`;
    const p=planImport([{name:'pre.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('source order reversed');
    const lines=liveLog(p.document).split('\n');
    expect(lines[0]).toBe('Oldest first; newest at the bottom.');
    expect(lines[1]).toBe(`- ${day(12)} - e12`);
    expect(lines.filter((l)=>l.startsWith('Oldest first'))).toHaveLength(1);
    expect(splitLogArchive(p.archives[0]!).entries).toEqual([entries[0],entries[1]]);
  });

  it('sorts an otherwise fully dated Log by date, the preamble no longer counting as an undated entry',()=>{
    const source=`# Pre\n\n## Log\n\nA note.\n- ${day(1)} - a\n- ${day(2)} - b`;
    const p=planImport([{name:'pre.md',text:source}]).projects[0]!;
    expect(p.log_order).toBe('by date');
    expect(liveLog(p.document)).toBe(`A note.\n- ${day(2)} - b\n- ${day(1)} - a`);
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
