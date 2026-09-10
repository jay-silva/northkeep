import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'index.html'), 'utf8');

describe('memory curation UI', () => {
  it('exposes the approved task navigation while keeping legacy chat inert', () => {
    expect(html).toMatch(/<button data-view="memories" class="active">[\s\S]*?Memories[\s\S]*?<\/button>/);
    expect(html).toMatch(/<button data-view="curation">[\s\S]*?Review[\s\S]*?<\/button>/);
    expect(html).not.toContain('data-view="collections"');
    expect(html).not.toContain('data-view="converse"');
    expect(html).toContain('<section id="view-converse" hidden inert aria-hidden="true">');
    expect(html).toMatch(/<button data-view="settings">[\s\S]*?Settings[\s\S]*?<\/button>/);
  });

  it('uses the exact guided-curation API contract and has no cloud generation path', () => {
    expect(html).toContain("api('/api/curation/collections')");
    expect(html).toContain("api('/api/curation/suggest',{method:'POST',json:{scope,instruction}})");
    expect(html).toContain("api('/api/curation/apply'");
    expect(html).toContain("api('/api/curation/history')");
    expect(html).toContain("api('/api/curation/restore'");
    const start = html.indexOf('// --- guided consolidation');
    const end = html.indexOf('// --- trustworthy memory review');
    expect(html.slice(start, end)).not.toContain('/api/review/api-options');
  });

  it('freezes exact preview payloads and retains operation ids for uncertain retries', () => {
    expect(html).toContain("curationPreview={vault_id:curationSession.vault_id,sources:(group.sources||[]).map((source)=>({...source})),content}");
    expect(html).toContain("const snapshot=curationPreview;if(!snapshot)return;const payload={vault_id:snapshot.vault_id,sources:snapshot.sources.map((source)=>({...source})),content:snapshot.content}");
    expect(html).toContain('curationPendingOperations.get(key)||crypto.randomUUID()');
    expect(html).toContain('if(ex.status&&ex.status>=400&&ex.status<500)curationPendingOperations.delete(key)');
  });

  it('guards stale suggestion responses and clears sensitive curation state on lock', () => {
    expect(html).toContain('const requestId=++curationRequestSequence');
    expect(html).toContain("if(requestId!==curationRequestSequence||scope!==$('curationScope').value||instruction!==$('curationInstruction').value.trim())return");
    expect(html).toContain('function showUnlock() { clearCurationSensitive();');
    expect(html).toContain("$('curationDialogBody').replaceChildren()");
    expect(html).toContain('curationPendingOperations.clear()');
  });

  it('renders curation content as text and separates explanation from editable wording', () => {
    const start = html.indexOf('// --- guided consolidation');
    const end = html.indexOf('// --- trustworthy memory review');
    const source = html.slice(start, end);
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(source).toContain("el('p','curation-explanation',group.explanation");
    expect(source).toContain("editor.value=group.proposed_content||''");
    expect(source).toContain("el('div','curation-label','Source memories')");
    expect(source).toContain("el('div','curation-label','Proposed memory')");
  });

  it('keeps separate without writing and invalidates a draft when a source is removed', () => {
    expect(html).toContain("group.sources=group.sources.filter((source)=>source.id!==entry.id);group.proposed_content=null;group.draftInvalid=true");
    expect(html).toContain("keep.addEventListener('click',()=>{curationSession.groups=curationSession.groups.filter");
    expect(html).toContain('Source selection changed. Review the remaining sources and write the exact result before previewing.');
  });

  it('supports narrow queue return and protected-focus dialogs', () => {
    expect(html).toContain('.curation-stage.detail-open .curation-queue { display:none; }');
    expect(html).toContain("el('button','btn curation-back','‹ Suggestions')");
    expect(html).toContain("if(event.key==='Escape')");
    expect(html).toContain("if(event.shiftKey&&document.activeElement===first)");
  });

  it('uses the wide workspace and desktop comparison while preserving mobile access', () => {
    expect(html).toContain('body:has(#view-curation:not([hidden])) main { max-width:1500px; width:100%; }');
    expect(html).toContain('.curation-grid { display:grid; grid-template-columns:240px minmax(0, 1fr);');
    expect(html).toContain('.curation-comparison { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1.08fr);');
    expect(html).toContain('.curation-back { display:none; }');
    expect(html).toContain('.curation-back { display:inline-flex; }');
    expect(html).toContain('nav button { border: 0; background: none; width: 100%; text-align: left; cursor: pointer;');
    expect(html.match(/nav button \{[^}]*\}/)?.[0]).toContain('min-height:44px');
    expect(html).toContain('header #countPill, header #connectPill');
    expect(html).toContain('nav::-webkit-scrollbar { display:none; }');
    expect(html).toContain('scrollbar-width:none;');
  });

  it('computes the history reassurance and uses ordinary current buttons', () => {
    expect(html).toContain("sourceCount+' '+(sourceCount===1?'original':'originals')+' kept in history · 1 active memory'");
    expect(html).toContain("button.setAttribute('aria-current',String(group.id===curationSelectedId))");
    expect(html).toContain('.curation-queue button[aria-current=true]');
    expect(html).not.toContain('<div id="curationQueue" role="listbox">');
    const start = html.indexOf('// --- guided consolidation');
    const end = html.indexOf('// --- trustworthy memory review');
    expect(html.slice(start, end)).not.toContain("button.setAttribute('role','option')");
  });

  it('persists exact drafts without trimming and describes prospective restore copies accurately', () => {
    expect(html).toContain("editor.addEventListener('input',()=>{group.proposed_content=editor.value");
    expect(html).toContain('openCurationApplyPreview(group,editor.value)');
    expect(html).toContain("'Restore as new copies · '+(item.sources||[]).length+' memories'");
    expect(html).toContain("(item.sources||[]).forEach((entry)=>block.appendChild(curationSourceNode(entry,false)))");
    expect(html).toContain("receipt.appendChild(el('strong',undefined,'Consolidation change'))");
  });

  it('scrubs collection, instruction, errors and modal state when the vault locks', () => {
    expect(html).toContain("$('curationInstruction').value=''");
    expect(html).toContain("$('curationScope').replaceChildren(el('option',undefined,'Loading collections…'))");
    expect(html).toContain("$('curationErr').textContent=''");
    expect(html).toContain("$('curationCoverage').textContent=''");
    expect(html).toContain("$('curationDialogBody').replaceChildren()");
  });

  it('labels incomplete coverage honestly and binds restore to the exact result', () => {
    expect(html).toContain("(incomplete?' · Incomplete':'')");
    expect(html).toContain("expected_result:expectedResult");
    expect(html).toContain("ex.status===409?'This result changed after the receipt was loaded.");
    expect(html).toContain("addCurationPreview(body,item.sources||[],item.result&&item.result.content||'')");
  });

  it('uses readable muted text in the light curation surface without overriding dark mode', () => {
    expect(html).toMatch(/@media not \(prefers-color-scheme: dark\)\s*\{\s*#view-memories, #view-curation, #curationDialogOverlay \{ --muted: #6d675c; \}/);
    const luminance = (hex: string) => hex.match(/\w{2}/g)!.map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    for (const background of ['f6f4ef', 'fffdf8', 'efeadd']) expect((luminance(background) + 0.05) / (luminance('6d675c') + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps selected collection names and counts readable in both themes', () => {
    expect(html).toContain('.review-choice:has(input:checked) { background:color-mix(in srgb, var(--accent) 16%, var(--panel)); border-color:var(--accent); color:var(--ink); }');
    expect(html).toContain('.review-choice:has(input:checked) small { color:var(--ink); }');
  });

  it('binds every proposal mutation to the report and proposal fingerprint', () => {
    expect(html).toContain('report_id:reviewReport.report_id');
    expect(html).toContain('proposal_fingerprint:proposal.proposal_fingerprint');
    expect(html).toContain("'/api/review/' + proposal.id + '/' + action");
  });

  it('retains an operation id while a network result is uncertain', () => {
    expect(html).toContain('reviewPendingOperations.get(key) || crypto.randomUUID()');
    expect(html).toContain('if (ex.status && ex.status >= 400 && ex.status < 500) reviewPendingOperations.delete(key)');
  });

  it('renders supplied review text through text nodes, never HTML parsing', () => {
    const start = html.indexOf('// --- trustworthy memory review');
    const end = html.indexOf('// --- md-render-start');
    const reviewSource = html.slice(start, end);
    expect(reviewSource).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(reviewSource).toContain('document.createTextNode');
    expect(reviewSource).toContain('textContent');
  });

  it('includes explicit duplicate survivor and removal confirmation', () => {
    expect(html).toContain("radio.name='review-survivor'");
    expect(html).toContain('survivor_id:survivor');
    expect(html).toContain('REMOVED FROM CURRENT MEMORIES');
  });

  it('treats changed lineage as stale evidence and excludes inactive duplicates', () => {
    expect(html).toContain('live.superseded_at!==snapshot.superseded_at');
    expect(html).toContain('live.superseded_by!==snapshot.superseded_by');
    expect(html).toContain('live.forgotten_at!==snapshot.forgotten_at');
    expect(html).toContain('!live.forgotten_at&&!live.superseded_at');
  });

  it('reloads collection choices without claiming model readiness', () => {
    expect(html).toContain('await loadReviewCollections()');
    expect(html).toContain('Local model availability is checked when review starts.');
    expect(html).not.toContain('Review on this device is ready.');
  });

  it('binds restore to the visible resulting head and exact content', () => {
    expect(html).toContain("const head=receipt.action==='forget' ? after[0]");
    expect(html).toContain("const expectedContent=receipt.action==='forget' ? before&&before.content : head&&head.content");
    expect(html).toContain('expected_head_id:head&&head.id');
    expect(html).toContain('expected_content:expectedContent');
    expect(html).toContain("receipt.action==='forget'?'Removed from active memories':head&&head.content");
    expect(html).toContain("'Saved your wording. View Change history to inspect or restore it.'");
  });
});
