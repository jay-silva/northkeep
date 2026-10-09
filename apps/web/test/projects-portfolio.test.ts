import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve(import.meta.dirname, '../static/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
function source(name: string) {
  const start = script.indexOf(`function ${name}(`);
  const brace = script.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < script.length; index++) {
    if (script[index] === '{') depth++;
    if (script[index] === '}' && --depth === 0) return script.slice(script.slice(start - 6, start) === 'async ' ? start - 6 : start, index + 1);
  }
  throw new Error(`Missing ${name}`);
}
function callbackSource(prefix: string) {
  const start = script.indexOf(prefix);
  const brace = script.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < script.length; index++) {
    if (script[index] === '{') depth++;
    if (script[index] === '}' && --depth === 0) return script.slice(start + prefix.length, index + 1);
  }
  throw new Error(`Missing callback ${prefix}`);
}
function harness(api: (route: string, options?: {json?: Record<string,unknown>}) => Promise<unknown>) {
  const context = vm.createContext({ api, crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'} });
  vm.runInContext(`
    const makeNode=(text='')=>({text,textContent:'',hidden:false,value:'',dataset:{},children:[],attrs:{},classList:{toggle(){},add(){}},scrollIntoView(){},
      append(...nodes){this.children.push(...nodes)},appendChild(node){this.children.push(node);return node},replaceChildren(...nodes){this.children=nodes},
      setAttribute(key,value){this.attrs[key]=value},addEventListener(event,handler){this[event]=handler},querySelectorAll(){return []},focus(){this.focused=true}});
    const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,makeNode());return nodes.get(id)};
    const el=(tag,cls,text)=>makeNode(text);const document={createElementNS:()=>makeNode()};
    const status={unlocked:true};let projectLoadSequence=0,projectActionSequence=0,projectDecisionSequence=0;
    let projectIndex=[],currentProjectSlug='',currentProject=null,projectReview=null,projectReturnFocus=null,projectFocusDetail=false;
    let projectNavigation={mode:'home'},projectQuery='',projectSort='recent',projectFilter='all';
    let projectDecisions=new Map(),projectDecisionsLoaded=true,pendingDecisionSlug='';const projectPendingOperations=new Map();
    const closeGuardDialog=()=>{};const projectAnnounce=()=>{};const projectFocusPanel=()=>{};const projectCloseButton=label=>el('button','btn',label);const renderProjectReceipt=()=>{projectReview=null};const renderProjectConflict=()=>{};
    const showProjectsMirror=()=>{};const renderProjectDetail=project=>$('projectDetail').replaceChildren(makeNode(project.status));const openProjectDecision=()=>{};
    ${['projectLines','projectDate','projectName','projectPill','projectNeedsAttention','filteredProjects','invalidateProjectView','showProjectsHome','renderProjectsEmpty','renderProjectChoices','loadProject','loadProjects','openProjectFromList','noteProjectDecisions','refreshProjectDecisions','clearProjectsSensitive','updateProjectOverview','projectWriteViewCurrent','projectWriteCurrent','saveProjectDraft','renderProjectCorrection','projectOperation','projectField'].map(source).join('\n')}
    this.draft=()=>{projectReview={mode:'checkpoint',slug:currentProjectSlug,vault_id:'vault',expected_revision:currentProject.revision,status:'Changed',completed:'Saved',next_actions:'New action',open_questions:'',decision:''}};
    this.save=()=>saveProjectDraft(makeNode(),makeNode());
    this.edit=()=>{renderProjectCorrection(currentProject);const panel=$('projectLive').children[0];panel.children[1].children[1].children[1].value='Changed';return panel.children[3].children[1].click()};
    this.load=loadProjects;this.open=loadProject;this.openFromList=openProjectFromList;this.back=showProjectsHome;this.clear=clearProjectsSensitive;this.nodes=nodes;this.refresh=refreshProjectDecisions;
    this.lock=()=>{status.unlocked=false;clearProjectsSensitive()};this.leave=()=>{$('view-projects').hidden=true;invalidateProjectView()};
    this.filter=(query,filter='all',sort='recent')=>{projectQuery=query;projectFilter=filter;projectSort=sort;renderProjectChoices()};
    this.state=()=>({navigation:projectNavigation,query:projectQuery,filter:projectFilter,sort:projectSort,index:projectIndex,decisions:[...projectDecisions]});
    this.needs=slug=>{projectDecisions.set(slug,1);renderProjectChoices()};
    this.slugs=()=>filteredProjects().map(item=>item.project);
  `, context);
  return context;
}
const rows = [
  { project:'zebra',title:'Zebra',status:'First line\nSearch later paragraph',next_actions:'- Start\n- Find the compass',updated_at:'2026-09-02',draft:false,conflict:false },
  { project:'alpha',title:'Alpine',status:'Draft scope',next_actions:'- Review scope',updated_at:'2026-09-01',draft:true,conflict:false },
  { project:'conflict',title:null,status:null,next_actions:null,updated_at:null,draft:false,conflict:true },
];

describe('Projects Portfolio navigation', () => {
  it('opens the overview without fetching or auto-selecting a detail, searches all saved text, and filters truthful signals', async () => {
    const calls: string[]=[];
    const app=harness(async route=>{calls.push(route);return {projects:rows}});
    await app.load();
    expect(calls.filter(route => route.startsWith('/api/projects'))).toEqual(['/api/projects']);
    expect(app.state().navigation).toEqual({mode:'home'});
    expect(app.slugs()).toEqual(['conflict','zebra','alpha']);
    app.filter('compass');expect(app.slugs()).toEqual(['zebra']);
    app.filter('later paragraph');expect(app.slugs()).toEqual(['zebra']);
    app.filter('', 'draft');expect(app.slugs()).toEqual(['alpha']);
    app.needs('zebra');app.filter('', 'attention');expect(app.slugs()).toEqual(['zebra','conflict']);
    expect(app.nodes.get('projectsAttentionCount').textContent).toBe('2');
    app.filter('', 'all', 'name');expect(app.slugs()).toEqual(['conflict','zebra','alpha']);
  });

  it('puts projects that need a choice first under both sorts', async () => {
    const app=harness(async()=>({projects:rows}));
    await app.load();
    expect(app.slugs()).toEqual(['conflict','zebra','alpha']);
    app.filter('', 'all', 'name');expect(app.slugs()).toEqual(['conflict','alpha','zebra']);
    app.needs('zebra');expect(app.slugs()).toEqual(['conflict','zebra','alpha']);
    app.filter('', 'all', 'recent');expect(app.slugs()).toEqual(['zebra','conflict','alpha']);
  });

  it('moves focus to the project title only when opened from the list', async () => {
    const app=harness(async route=>route==='/api/projects'?{projects:rows}:{...rows[0],revision:'old'});
    await app.load();
    await app.open('zebra');
    expect(app.nodes.get('projectDetailHeading')?.focused).toBeFalsy();
    app.back(false);
    await app.openFromList('zebra');
    expect(app.nodes.get('projectDetailHeading').focused).toBe(true);
  });

  it('preserves search and filters on Back and ignores a detail arriving after Back', async () => {
    let finish!: (value: unknown)=>void;
    const delayed=new Promise(resolve=>{finish=resolve});
    const app=harness(async route=>route==='/api/projects'?{projects:rows}:delayed);
    await app.load();app.filter('compass','all','name');
    const pending=app.open('zebra');
    expect(app.state().navigation).toEqual({mode:'detail',slug:'zebra'});
    app.back(false);finish({project:'zebra',status:'Late private detail'});await pending;
    expect(app.state()).toMatchObject({navigation:{mode:'home'},query:'compass',filter:'all',sort:'name'});
    expect(app.nodes.get('projectsWorkspace').hidden).toBe(true);
    expect(app.nodes.get('projectDetail').children).toEqual([]);
  });

  it('shows a successful checkpoint in the cached portfolio on Back', async () => {
    const saved={project:'zebra',title:'Zebra',status:'Changed',next_actions:'New action',updated_at:'2026-09-03',revision:'new',shared:false,draft:false,last_writer:{host:'northkeep-app'}};
    const app=harness(async route=>route==='/api/projects'?{projects:rows}:route.endsWith('/checkpoint')?{current:saved,replayed:false}:{...rows[0],revision:'old'});
    await app.load();await app.open('zebra');app.draft();await app.save();app.back(false);
    expect(app.state().index.find((project:{project:string})=>project.project==='zebra')).toMatchObject({status:saved.status,next_actions:saved.next_actions,updated_at:saved.updated_at,revision:saved.revision,last_writer_host:'northkeep-app'});
    expect(app.slugs()).toEqual(['conflict','zebra','alpha']);
  });

  it('keeps the portfolio open when an edit finishes after Back, and refreshes its saved state', async () => {
    let finish!: (value: unknown)=>void;
    const pendingWrite=new Promise(resolve=>{finish=resolve});let changed=false;const calls:string[]=[];
    const app=harness(async route=>{
      calls.push(route);
      if(route.endsWith('/update'))return pendingWrite;
      if(route==='/api/projects')return {projects:rows.map(row=>row.project==='zebra'&&changed?{...row,status:'Changed'}:row)};
      return {...rows[0],revision:'old'};
    });
    await app.load();await app.open('zebra');const pending=app.edit();app.back(false);changed=true;finish({});await pending;
    expect(app.state().navigation).toEqual({mode:'home'});
    expect(app.state().index.find((project:{project:string})=>project.project==='zebra').status).toBe('Changed');
    expect(calls.filter(route=>route==='/api/projects/zebra')).toHaveLength(1);
    expect(app.nodes.get('projectsWorkspace').hidden).toBe(true);
  });

  it('keeps Back authoritative when a cloud choice finishes, while retaining its revision-bound request', async () => {
    let finish!: (value:unknown)=>void;const pendingWrite=new Promise(resolve=>{finish=resolve});const calls:string[]=[];let sent:Record<string,unknown>|undefined;
    const app=harness(async(route,options)=>{
      calls.push(route);
      if(route==='/api/share/resolve'){sent=options?.json;return pendingWrite}
      if(route==='/api/projects')return {projects:rows};
      return {...rows[0],revision:'old'};
    });
    await app.load();await app.open('zebra');
    vm.runInContext(`const slug='zebra',c={server_id:'waiting'},local={revision:'old'},root=$('projectDecision'),err=makeNode(),keep=makeNode(),take=makeNode(),cancel=makeNode();
      const resolve=${callbackSource('    const resolve = ')};this.choose=()=>resolve('take-theirs',take);`,app);
    const pending=app.choose();app.back(false);finish({});await pending;
    expect(sent).toEqual({project:'zebra',choice:'take-theirs',server_id:'waiting',expected_revision:'old'});
    expect(app.state().navigation).toEqual({mode:'home'});
    expect(calls.filter(route=>route==='/api/projects/zebra')).toHaveLength(1);
  });

  it('keeps Back authoritative when a restore finishes and retains both revision checks', async () => {
    let finish!: (value:unknown)=>void;const pendingWrite=new Promise(resolve=>{finish=resolve});let sent:Record<string,unknown>|undefined;
    const app=harness(async(route,options)=>{
      if(route.endsWith('/restore')){sent=options?.json;return pendingWrite}
      return route==='/api/projects'?{projects:rows}:{...rows[0],revision:'old'};
    });
    await app.load();await app.open('zebra');
    vm.runInContext(`const restore=makeNode(),err=makeNode(),project={project:'zebra',revision:'old'},row={id:'historic'},body=makeNode();
      this.restore=async ${callbackSource("    restore.addEventListener('click', async ")};`,app);
    const pending=app.restore();app.back(false);finish({});await pending;
    expect(sent).toEqual({revision:'historic',expected_revision:'old'});
    expect(app.state().navigation).toEqual({mode:'home'});
    expect(app.nodes.get('projectsWorkspace').hidden).toBe(true);
  });

  it('clears the old import-date note after a successful restore creates a new head', async () => {
    const imported=rows.map(row=>row.project==='zebra'?{...row,imported:true}:row);
    let restored=false;
    const app=harness(async route=>{
      if(route.endsWith('/restore')){restored=true;return {}}
      if(route==='/api/projects')return {projects:imported};
      return {...imported[0],revision:restored?'restored':'old',updated_at:restored?'2026-09-04':'2026-09-02'};
    });
    await app.load();await app.open('zebra');
    expect(app.state().index[0].imported).toBe(true);
    vm.runInContext(`const restore=makeNode(),err=makeNode(),project={project:'zebra',revision:'old'},row={id:'historic',updated_at:'2026-09-01'},body=makeNode();
      this.restore=async ${callbackSource("    restore.addEventListener('click', async ")};`,app);
    await app.restore();app.back(false);
    expect(app.state().index.find((project:{project:string})=>project.project==='zebra')).toMatchObject({revision:'restored',updated_at:'2026-09-04',imported:false});
  });

  it('clears all portfolio data on lock and ignores late list and cloud decisions', async () => {
    let finishList!: (value: unknown)=>void;
    const list=new Promise(resolve=>{finishList=resolve});
    const app=harness(async ()=>list);
    const pending=app.load();app.lock();finishList({projects:rows});await pending;
    expect(app.state()).toMatchObject({index:[],query:'',filter:'all',sort:'recent',decisions:[]});
    expect(app.nodes.get('projectsAllCount').textContent).toBe('0');
    let finishDecisions!: (value: unknown)=>void;
    const decisions=new Promise(resolve=>{finishDecisions=resolve});
    const connected=harness(async route=>route==='/api/share/status'?{configured:true,unlocked:true,paired:true}:decisions);
    const refresh=connected.refresh();await Promise.resolve();connected.lock();finishDecisions({conflicts:[{project:'zebra'}]});await refresh;
    expect(connected.state().decisions).toEqual([]);
  });
});
