import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function functionSource(name: string) {
  const functionStart = script.indexOf(`function ${name}(`);
  const start = script.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  if (start < 0) throw new Error(`Missing function ${name}`);
  const brace = script.indexOf('{', functionStart);
  let depth = 0;
  for (let i = brace; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

describe('navigation UI', () => {
  it('starts Connect collapsed with only Desktop and Cloud children', () => {
    expect(html).toContain('id="connectToggle" class="nav-disclosure" type="button" aria-expanded="false" aria-controls="connectNavChildren"');
    const children = html.match(/<div id="connectNavChildren" hidden>([\s\S]*?)<\/div>/)?.[1] ?? '';
    expect(children.match(/data-view=/g)).toHaveLength(2);
    expect(children).toContain('data-view="connect" class="sub">Desktop');
    expect(children).toContain('data-view="sharing" class="sub">Cloud');
  });

  it('expands Connect without loading either destination', () => {
    const binding = script.match(/\$\('connectToggle'\)\.addEventListener\('click',[\s\S]*?\}\);/)?.[0] ?? '';
    expect(binding).toContain("$('connectNavChildren').hidden");
    expect(binding).toContain("setAttribute('aria-expanded'");
    expect(binding).not.toMatch(/runLoader|loadConnect|loadSharing|\bapi\s*\(/);
  });

  it('keeps collection, type, and search controls in one Memories workspace', () => {
    expect(html).toContain('id="collectionRail"');
    expect(html).toContain('id="collectionSelect" aria-label="Collection"');
    expect(html).toContain('id="typeChips"');
    expect(html).toContain('id="q"');
    const memories = functionSource('loadMemories');
    expect(memories).toContain("qs.set('q'");
    expect(memories).toContain("qs.set('type', filterType)");
    expect(memories).toContain("qs.set('scope', filterScope)");
    expect(memories).toContain("api('/api/memories?' + qs)");
  });

  it('rejects stale memory responses and preserves the selected collection during refresh', () => {
    const memories = functionSource('loadMemories');
    expect(memories).toContain('const requestId = ++memoryLoadSequence');
    expect(memories).toContain('if (requestId !== memoryLoadSequence || !status.unlocked) return');
    const scopes = functionSource('loadScopes');
    expect(scopes).toContain("$('collectionSelect').value = filterScope");
    expect(scopes).toContain("filterScope === scope ? 'on' : undefined");
  });

  it('does not render a delayed response after a newer filter request starts', async () => {
    let resolveOld!: (value: unknown) => void;
    const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
    const elements = new Map<string, Record<string, unknown>>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { value: id === 'q' ? 'old search' : '', textContent: 'unchanged' });
      return elements.get(id)!;
    };
    const context = vm.createContext({ URLSearchParams, console });
    vm.runInContext(`
      let memoryLoadSequence=0, filterType='', filterScope='first';
      const status={unlocked:true};
      const $=${element.toString()};
      const elements=new Map();
      const api=()=>oldResponse;
      const oldResponse=this.oldResponse;
      let localSearchBusy=false; const showLocalSearchState=()=>{};
      ${functionSource('loadMemories')}
      this.start=loadMemories;
      this.advance=()=>{ filterScope='second'; memoryLoadSequence+=1; };
      this.title=()=>$('memoryCollectionTitle').textContent;
    `, Object.assign(context, { oldResponse }));
    const pending = context.start();
    context.advance();
    resolveOld({ memories: [{ id: 'old', content: 'stale' }] });
    await pending;
    expect(context.title()).toBe('unchanged');
  });

  it('invalidates an older search as soon as the user types, before debounce fires', async () => {
    let resolveOld!: (value: unknown) => void;
    const oldResponse = new Promise(resolve => { resolveOld = resolve; });
    const context = vm.createContext({ oldResponse, URLSearchParams });
    const binding = script.match(/\$\('q'\)\.addEventListener\('input',[\s\S]*?\}\);/)?.[0];
    expect(binding).toBeTruthy();
    vm.runInContext(`
      let memoryLoadSequence=0, filterType='', filterScope='', searchTimer;
      const status={unlocked:true};
      const nodes=new Map();
      const $=(id)=>{if(!nodes.has(id))nodes.set(id,{value:id==='q'?'d':'',textContent:'unchanged',innerHTML:'unchanged',addEventListener(event,fn){this[event]=fn;}});return nodes.get(id);};
      const api=()=>this.oldResponse;
      const clearTimeout=()=>{}; const stopLocalSearchView=()=>{}; const setTimeout=(fn)=>{this.scheduled=fn;return 1;};
      let localSearchBusy=false; const showLocalSearchState=()=>{};
      ${functionSource('loadMemories')}
      ${binding}
      this.start=loadMemories;
      this.type=()=>{$('q').value='dog';$('q').input();};
      this.result=()=>$('memList').innerHTML;
      this.title=()=>$('memoryCollectionTitle').textContent;
    `, context);
    const pending = context.start();
    context.type();
    resolveOld({memories:[],search_mode:'keyword',semantic_reason:'empty query'});
    await pending;
    expect(context.result()).toBe('unchanged');
    expect(context.title()).toBe('unchanged');
    expect(context.scheduled).toBeTypeOf('function');
  });

  it('keeps project collections out of Memories counts and navigation without losing scope choices', async () => {
    const context = vm.createContext({});
    vm.runInContext(`
      let memoryScopeEpoch=0,scopeLoadSequence=0,filterScope='',knownScopes=[],memorySharedScopes;
      const status={unlocked:true}; const NEW_SCOPE='+new';
      const makeNode=(text='')=>({text, textContent:'',value:'',children:[],options:[],dataset:{},replaceChildren(){this.children=[];this.options=[];},append(...nodes){this.children.push(...nodes);},appendChild(node){this.children.push(node);this.options.push(node);return node;}});
      const nodes=new Map(); const $=(id)=>{if(!nodes.has(id))nodes.set(id,makeNode());return nodes.get(id);};
      const el=(tag,klass,text)=>makeNode(text); const esc=(text)=>text; const memoryPrivacyLabel=()=>'';
      const api=async(route)=>route==='/api/scopes'?{scopes:['personal','project:garden']}:
        route==='/api/share/status'?{shared_scopes:[]}:{memories:[{scope:'personal'},{scope:'project:garden'}]};
      ${functionSource('loadScopes')}
      this.load=loadScopes;this.nodes=nodes;this.known=()=>knownScopes;
    `, context);
    await context.load();
    expect(context.nodes.get('memoryVaultSummary').textContent).toBe('1 memory · 1 collection');
    expect(context.nodes.get('collectionSelect').children.map((n: {value:string})=>n.value)).toEqual(['','personal']);
    expect(context.nodes.get('scopeChips').children.map((n: {dataset:{s:string}})=>n.dataset.s)).toEqual(['','personal']);
    expect(context.known()).toContain('project:garden');
  });

  it('does not render delayed scopes or counts after a newer scope refresh starts', async () => {
    let resolveOldScopes!: (value: unknown) => void;
    let resolveOldMemories!: (value: unknown) => void;
    const oldScopes = new Promise((resolve) => { resolveOldScopes = resolve; });
    const oldMemories = new Promise((resolve) => { resolveOldMemories = resolve; });
    const never = new Promise(() => undefined);
    const context = vm.createContext({ oldScopes, oldMemories, never });
    vm.runInContext(`
      let memoryScopeEpoch=0, scopeLoadSequence=0, filterScope='', knownScopes=[];
      const status={unlocked:true};
      const nodes=new Map([['scopeChips',{ marker:'unchanged', replaceChildren(){ this.marker='changed'; }}]]);
      const $=(id)=>nodes.get(id) || {};
      const calls=[this.oldScopes,this.oldMemories,this.never,this.never];
      const api=()=>calls.shift();
      const el=()=>({}); const NEW_SCOPE='+new';
      ${functionSource('loadScopes')}
      this.start=loadScopes;
      this.marker=()=>nodes.get('scopeChips').marker;
    `, context);
    const oldLoad = context.start();
    void context.start();
    resolveOldScopes({ scopes: ['stale'] });
    resolveOldMemories({ memories: [{ scope: 'stale' }] });
    await oldLoad;
    expect(context.marker()).toBe('unchanged');
  });

  it('builds collection navigation from all scopes and separate unfiltered counts', () => {
    const scopes = functionSource('loadScopes');
    expect(scopes).toContain("api('/api/scopes')");
    expect(scopes).not.toContain('/api/curation/collections');
    expect(scopes).toContain("api('/api/memories?exclude_projects=1')");
    expect(scopes).toContain('const counts = new Map()');
  });

  it('ignores sharing status that finishes after the vault locks', async () => {
    let resolveSharing!: (value: unknown) => void;
    let reachedSharing!: () => void;
    const sharing = new Promise(resolve => { resolveSharing = resolve; });
    const reached = new Promise<void>(resolve => { reachedSharing = resolve; });
    const render = vi.fn();
    const api = (route: string) => {
      if (route === '/api/share/status') { reachedSharing(); return sharing; }
      return Promise.resolve(route === '/api/scopes' ? { scopes: ['writing'] } : { memories: [] });
    };
    const context = vm.createContext({ api, $: render });
    vm.runInContext(`let memoryScopeEpoch=0,scopeLoadSequence=0;
      const status={unlocked:true}; ${functionSource('loadScopes')};
      this.start=loadScopes; this.lock=()=>{status.unlocked=false;memoryScopeEpoch+=1;};`, context);
    const pending = context.start();
    await reached;
    context.lock();
    resolveSharing({ shared_scopes: [] });
    await pending;
    expect(render).not.toHaveBeenCalled();
  });

  it('only labels a collection private when sharing state is known', () => {
    const context = vm.createContext({});
    vm.runInContext(`let memorySharedScopes=null; ${functionSource('memoryPrivacyLabel')};
      this.label=memoryPrivacyLabel; this.setShared=(scopes)=>{memorySharedScopes=new Set(scopes);};`, context);
    expect(context.label('writing')).toBe(' · Sharing status unavailable');
    context.setShared(['writing']);
    expect(context.label('writing')).toBe(' · Shared');
    expect(context.label('personal')).toBe(' · Private');
    expect(context.label('')).toBe('');
    expect(functionSource('clearMemorySensitive')).toContain('memorySharedScopes = null');
  });

  it('selects a collection when its nested name or count is clicked', () => {
    const binding = script.match(/\$\('scopeChips'\)\.addEventListener\('click',[\s\S]*?\}\);/)?.[0] ?? '';
    const loadMemories = vi.fn();
    let listener: (event: unknown) => void = () => undefined;
    const button = { dataset: { s: 'writing' }, classList: { toggle: vi.fn() } };
    const rail = { children: [button], contains: (node: unknown) => node === button,
      addEventListener: (_: string, callback: typeof listener) => { listener = callback; } };
    const context = vm.createContext({ $: () => rail, loadMemories });
    vm.runInContext(`let filterScope=''; ${binding}; this.selected=()=>filterScope;`, context);
    listener({ target: { closest: () => button } });
    expect(context.selected()).toBe('writing');
    expect(loadMemories).toHaveBeenCalledOnce();
    expect(button.classList.toggle).toHaveBeenCalledWith('on', true);
  });

  it('keeps Add progressive and routes review without starting model work', () => {
    expect(html).toContain('id="addMemoryToggle" type="button" aria-expanded="false" aria-controls="addMemCard"');
    expect(html).toContain('<div class="card" id="addMemCard" hidden>');
    expect(html).toContain('id="reviewCurrentCollectionBtn" type="button" disabled');
    const reviewStart = script.indexOf("$('reviewCurrentCollectionBtn').addEventListener('click'");
    const reviewBinding = script.slice(reviewStart, reviewStart + 1400);
    expect(reviewBinding).toContain("showSection('curation')");
    expect(reviewBinding).not.toMatch(/\/api\/review\/run|\/api\/curation\/suggest|\/api\/curation\/apply/);
  });

  it('defaults an empty Add draft to the browsed collection without replacing an explicit draft scope', () => {
    const addStart = script.indexOf("$('addMemoryToggle').addEventListener('click'");
    const addBinding = script.slice(addStart, addStart + 900);
    expect(addBinding).toContain("!$('addMemContent').value.trim() && filterScope");
    expect(addBinding).toContain("$('addMemScope').value = filterScope");
    const scopes = functionSource('loadScopes');
    expect(scopes).toContain('const previousAddScope = add.value');
    expect(scopes).toContain('const preferredAddScope = previousAddScope');
    expect(scopes).toContain("$('addMemNewScope').hidden = add.value !== NEW_SCOPE");
  });

  it('invalidates an older detailed report before routing a chosen collection', () => {
    const reviewStart = script.indexOf("$('reviewCurrentCollectionBtn').addEventListener('click'");
    const reviewBinding = script.slice(reviewStart, reviewStart + 1500);
    expect(reviewBinding).toMatch(/reviewRequestSequence\s*\+=\s*1|\+\+reviewRequestSequence/);
    expect(reviewBinding).not.toContain("showTop('curation')");
    expect(reviewBinding).not.toContain("loadReviewPanel()");
    expect(reviewBinding).toContain("showSection('curation')");
  });

  it('carries the chosen collection into the primary guided review', () => {
    const loader = functionSource('loadCurationCollections');
    expect(loader).toContain("function loadCurationCollections(preferredScope = '')");
    expect(loader).toContain('const previousScope = preferredScope || select.value');
    expect(loader).toContain('collection.scope === previousScope');
    const reviewStart = script.indexOf("$('reviewCurrentCollectionBtn').addEventListener('click'");
    const reviewBinding = script.slice(reviewStart, reviewStart + 1800);
    expect(reviewBinding).toContain('loadCurationCollections(scope)');
    expect(reviewBinding).toContain("$('detailedReview').open = false");
    expect(reviewBinding).toContain("$('curationInstruction').focus()");
  });

  it('keeps chosen collection B when an older guided-collection load for A finishes later', async () => {
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    const responseA = new Promise((resolve) => { resolveA = resolve; });
    const responseB = new Promise((resolve) => { resolveB = resolve; });
    const context = vm.createContext({ responseA, responseB });
    vm.runInContext(`
      let curationRequestSequence=0, curationSession=null;
      const status={unlocked:true};
      const select={value:'',options:[],replaceChildren(){this.options=[];this.value='';},appendChild(option){this.options.push(option);if(!this.value)this.value=option.value;}};
      const nodes=new Map([
        ['curationScope',select],['curationStartBtn',{disabled:false}],['curationStatus',{textContent:''}],['curationErr',{textContent:''}]
      ]);
      const $=(id)=>nodes.get(id);
      const calls=[this.responseA,this.responseB];
      const api=()=>calls.shift();
      const el=(tag,klass,text)=>({tag,klass,text,value:''});
      ${functionSource('loadCurationCollections')}
      this.load=loadCurationCollections;
      this.selected=()=>select.value;
    `, context);
    const oldLoad = context.load('A');
    const chosenLoad = context.load('B');
    resolveB({ collections: [{ scope: 'A', count: 1 }, { scope: 'B', count: 2 }] });
    await chosenLoad;
    expect(context.selected()).toBe('B');
    resolveA({ collections: [{ scope: 'A', count: 1 }] });
    await oldLoad;
    expect(context.selected()).toBe('B');
  });

  it('scrubs detailed review state and invalidates pending loads when locked', () => {
    const clear = functionSource('clearDetailedReviewSensitive');
    for (const state of ['reviewRequestSequence', 'reviewCollectionLoadSequence', 'reviewApiPreflight', 'reviewReport', 'reviewSelectedId', 'reviewSelectedScopes']) {
      expect(clear).toContain(state);
    }
    for (const id of ['reviewCollections', 'reviewQueue', 'reviewDetail', 'reviewDialogBody', 'reviewDialogActions', 'reviewApiDetails']) {
      expect(clear).toContain(`$('${id}').replaceChildren()`);
    }
    expect(clear).toContain('reviewPendingOperations.clear()');
    expect(clear).toContain("$('reviewApiOverlay').hidden = true");
    expect(clear).toContain("$('reviewDialogOverlay').hidden = true");
    expect(functionSource('showUnlock')).toContain('clearDetailedReviewSensitive()');
    expect(functionSource('loadReviewPanel')).toContain('if (requestId !== reviewRequestSequence || !status.unlocked) return');
    expect(functionSource('loadReviewCollections')).toContain('if (requestId !== reviewCollectionLoadSequence || !status.unlocked) return []');
  });

  it('finishes onboarding on Memories through the normal navigation function', async () => {
    const showTop = vi.fn();
    const context = vm.createContext({ hideSetup: vi.fn(), refreshStatus: vi.fn(async () => undefined), showTop });
    vm.runInContext(`${functionSource('finishSetup')}; this.finishSetup = finishSetup`, context);
    await context.finishSetup();
    expect(showTop).toHaveBeenCalledOnce();
    expect(showTop).toHaveBeenCalledWith('memories');
  });

  it('retains the provider manager as a separate Settings model surface', () => {
    expect(html).toContain('<button data-sub="models">Models</button>');
    expect(html).toContain('<section id="view-models" hidden>');
    for (const id of ['managePanel', 'epList', 'cwOpen', 'epDiscover', 'epAdd']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('does not bind direct listeners to missing element ids at startup', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
    const directlyBound = [...script.matchAll(/\$\('([^']+)'\)\.addEventListener\(/g)].map((match) => match[1]);
    expect(directlyBound.filter((id) => !ids.has(id))).toEqual([]);
  });

  it('preserves the incumbent self-hosted typography and body palette', () => {
    expect(html).toContain("font-family:'Hanken Grotesk'");
    expect(html).toContain("font-family:'Newsreader'");
    expect(html).toMatch(/--sans:\s*'Hanken Grotesk'/);
    expect(html).toMatch(/--serif:\s*'Newsreader'/);
    expect(html).toMatch(/body\s*\{[^}]*font:\s*15px\/1\.5 var\(--sans\)/);
  });
});
