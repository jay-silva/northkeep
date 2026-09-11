import { exactCanonicalJson } from './consolidation.js';
import {
  PROJECT_DOC_MAX_CHARS,
  PROJECT_DOC_CAP_MESSAGE,
  formatLogArchive,
  getProjectSection,
  parseProjectDoc,
  parseProjectSlug,
  projectScope,
  rollProjectLog,
  serializeProjectDoc,
  type ProjectDoc,
} from './project-doc.js';
import type { MemoryEntry } from './types.js';

export const PROJECT_HANDOFF_METADATA_KEY = 'northkeep_project_handoff_v1';
export const PROJECT_HANDOFF_METADATA_VERSION = 1;
export const PROJECT_HISTORY_LIMIT = 20;
export const PROJECT_FILE_LIMIT = 40;
export const PROJECT_FIELD_MAX_CHARS = PROJECT_DOC_MAX_CHARS;

export type ProjectHandoffMode = 'checkpoint' | 'wrap';
export type ProjectFileAccess = 'reported_available' | 'unavailable' | 'unverified';
export type ProjectHandoffErrorCode = 'invalid_request' | 'not_found' | 'stale_project' | 'project_conflict' | 'operation_conflict' | 'scope_denied';

export interface ProjectFileReference {
  type: 'local_path' | 'url' | 'memory';
  label: string;
  locator: string;
  access: ProjectFileAccess;
  checked_at?: string;
  context?: string;
}

export interface ProjectRevision { id: string; updated_at: string; content: string; mode?: ProjectHandoffMode }
export interface ProjectArchive { id: string; updated_at: string; content: string }
export interface ProjectView {
  vault_id: string;
  project: string;
  scope: string;
  shared: boolean;
  revision: string;
  updated_at: string;
  content: string;
  what_why: string;
  status: string;
  next_actions: string;
  decisions: string;
  open_questions: string;
  files: ProjectFileReference[] | null;
  files_text: string;
  log: string;
  history: ProjectRevision[];
  archives: ProjectArchive[];
}
export interface ProjectSummary { project:string; scope:string; status:string|null; revision:string|null; updated_at:string|null; conflict:boolean }

export interface ProjectCheckpointRequest {
  vault_id:string; project:string; mode:ProjectHandoffMode; operation_id:string; expected_revision:string;
  status:string; completed:string; next_actions:string; decision?:string; open_questions?:string; files?:ProjectFileReference[];
}
export interface ProjectUpdateRequest {
  project:string; expected_revision:string|null; what_why?:string; status?:string; next_actions?:string;
  decision?:string; log_entry?:string; open_questions?:string; files?:ProjectFileReference[];
}
export interface ProjectHandoffReceipt {
  operation_id:string; project:string; mode:ProjectHandoffMode; base_revision:string; result_revision:string;
  request_fingerprint:string; archive_ids:string[]; saved_at:string; local_only:true;
}
export interface ProjectCheckpointResult { receipt:ProjectHandoffReceipt; current:ProjectView; replayed:boolean }

export interface ProjectHandoffMetadata {
  version:1; operation_id:string; result_id:string; project:string; base_revision:string; mode:ProjectHandoffMode;
  request_fingerprint:string; archive_ids:string[]; saved_at:string;
}

export class ProjectHandoffError extends Error {
  constructor(public readonly code:ProjectHandoffErrorCode, message:string, public readonly current?:ProjectView) { super(message); this.name='ProjectHandoffError'; }
}

interface ProjectVaultReader { list(filter?:Record<string,unknown>):MemoryEntry[]; getVaultId():string; sharedScopes():string[] }

function fail(message:string):never { throw new ProjectHandoffError('invalid_request',message); }
export function assertProjectText(value:string, field:string, allowEmpty:boolean):void {
  if (typeof value !== 'string' || value.length > PROJECT_FIELD_MAX_CHARS) fail(`${field} is invalid or too long.`);
  if (/\r/.test(value) || /^\n|\n$/.test(value) || /^( {0,3})#{1,6}[ \t]+\S/m.test(value)) fail(`${field} contains unsupported section formatting.`);
  if (!allowEmpty && value.trim().length===0) fail(`${field} must not be empty.`);
  if (value.length>0 && value.trim().length===0) fail(`${field} cannot contain only whitespace.`);
}
export function validateProjectFileReferences(files:ProjectFileReference[]):ProjectFileReference[] {
  if (!Array.isArray(files) || files.length>PROJECT_FILE_LIMIT) fail(`files must contain at most ${PROJECT_FILE_LIMIT} references.`);
  return files.map((file) => {
    if (!file || !['local_path','url','memory'].includes(file.type) || !['reported_available','unavailable','unverified'].includes(file.access)) fail('A file reference is malformed.');
    const allowed=new Set(['type','label','locator','access','checked_at','context']); if(Object.keys(file).some((key)=>!allowed.has(key)))fail('A file reference has unsupported fields.');
    for (const [name,value,max] of [['label',file.label,200],['locator',file.locator,2048]] as const) if(typeof value!=='string'||value.trim().length===0||value.length>max||/[\r\n]/.test(value)) fail(`File ${name} is invalid.`);
    if (file.access==='reported_available') {
      const checkedAt=typeof file.checked_at==='string'?Date.parse(file.checked_at):NaN;
      if (typeof file.checked_at!=='string' || !Number.isFinite(checkedAt) || new Date(checkedAt).toISOString()!==file.checked_at || typeof file.context!=='string' || file.context.trim().length===0 || file.context.length>500 || /[\r\n\u0000-\u001f]/.test(file.context)) fail('Reported file availability requires checked_at and context.');
    } else if (file.checked_at!==undefined || file.context!==undefined) fail('Only reported_available files may include checked_at or context.');
    return {type:file.type,label:file.label,locator:file.locator,access:file.access,...(file.checked_at!==undefined?{checked_at:file.checked_at}:{}),...(file.context!==undefined?{context:file.context}:{})};
  });
}

function owned(doc:ProjectDoc,title:string):string {
  const matches=doc.sections.filter((s)=>s.title===title); if(matches.length>1) fail(`Project document has duplicate ${title} sections.`); return matches[0]?.body??'';
}
function setSection(doc:ProjectDoc,title:string,body:string):void { const found=doc.sections.find((s)=>s.title===title); if(found) found.body=body; else doc.sections.push({level:2,title,body}); }
const FILES_FENCE='```northkeep-files-json';
export function parseProjectFiles(text:string):ProjectFileReference[]|null {
  if (!text.startsWith(FILES_FENCE+'\n') || !text.endsWith('\n```')) return null;
  try { return validateProjectFileReferences(JSON.parse(text.slice(FILES_FENCE.length+1,-4)) as ProjectFileReference[]); } catch { return null; }
}
export function formatProjectFiles(files:ProjectFileReference[]):string { return `${FILES_FENCE}\n${exactCanonicalJson(validateProjectFileReferences(files))}\n\`\`\``; }

export function applyProjectUpdate(content:string, request:ProjectUpdateRequest, now=new Date()):{content:string;archives:string[]} {
  const doc=parseProjectDoc(content); for(const h of ['What & Why','Current Status','Next Actions','Decisions','Log','Open Questions','Files']) owned(doc,h);
  const replacements:[string,string|undefined,boolean][]=[['What & Why',request.what_why,false],['Current Status',request.status,false],['Next Actions',request.next_actions,true],['Open Questions',request.open_questions,true]];
  for(const [heading,value,empty] of replacements) if(value!==undefined){assertProjectText(value,heading,empty);setSection(doc,heading,value);}
  const date=now.toISOString().slice(0,10);
  if(request.decision!==undefined){assertProjectText(request.decision,'decision',false);const old=owned(doc,'Decisions');setSection(doc,'Decisions',`${old}${old?'\n':''}- ${date} - ${request.decision}`);}
  if(request.log_entry!==undefined){assertProjectText(request.log_entry,'log_entry',false);const old=owned(doc,'Log');setSection(doc,'Log',`- ${date} - ${request.log_entry}${old?'\n'+old:''}`);}
  if(request.files!==undefined)setSection(doc,'Files',formatProjectFiles(request.files));
  const rolled=rollProjectLog(doc); const result=serializeProjectDoc(rolled.doc); if (result.length > PROJECT_DOC_MAX_CHARS) fail(PROJECT_DOC_CAP_MESSAGE); return {content:result,archives:rolled.archived};
}

export function readProjectHandoffMetadata(entry:MemoryEntry):ProjectHandoffMetadata|null {
  const raw=entry.metadata?.[PROJECT_HANDOFF_METADATA_KEY]; if(raw===undefined)return null;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ProjectHandoffError('operation_conflict','Malformed project handoff receipt metadata.');
  const m=raw as Record<string,unknown>; const keys=['operation_id','result_id','project','base_revision','request_fingerprint','saved_at'];
  const exactKeys=new Set(['version','operation_id','result_id','project','base_revision','mode','request_fingerprint','archive_ids','saved_at']);
  if(Object.keys(m).length!==exactKeys.size||Object.keys(m).some((key)=>!exactKeys.has(key))||m.version!==1||!['checkpoint','wrap'].includes(String(m.mode))||keys.some((k)=>typeof m[k]!=='string')||!Array.isArray(m.archive_ids)||m.archive_ids.some((x)=>typeof x!=='string')||m.result_id!==entry.id||!/^[0-9a-f]{64}$/.test(String(m.request_fingerprint))||!Number.isFinite(Date.parse(String(m.saved_at))))throw new ProjectHandoffError('operation_conflict','Malformed project handoff receipt metadata.');
  return m as unknown as ProjectHandoffMetadata;
}
export function projectReceiptMode(entry:MemoryEntry):ProjectHandoffMode|undefined { try{return readProjectHandoffMetadata(entry)?.mode;}catch{return undefined;} }

export function getProjectView(vault:ProjectVaultReader, project:string, allowedScopes?:string[], options:{history?:boolean}={}):ProjectView {
  const scope=projectScope(project); if(allowedScopes!==undefined&&!allowedScopes.includes(scope))throw new ProjectHandoffError('scope_denied','Project scope is outside this connection grant.');
  const all=vault.list({scope,includeSuperseded:true,allowedScopes}); const live=all.filter((e)=>e.type==='working'&&!e.forgotten_at&&!e.superseded_at);
  if(live.length===0)throw new ProjectHandoffError('not_found','Project was not found.'); if(live.length>1)throw new ProjectHandoffError('project_conflict','Project has multiple current documents.');
  const head=live[0]!; const doc=parseProjectDoc(head.content); for(const h of ['What & Why','Current Status','Next Actions','Decisions','Log','Open Questions','Files'])owned(doc,h);
  const fileText=owned(doc,'Files'); const entries=all.filter((e)=>!e.forgotten_at);
  const history=options.history?entries.filter((e)=>e.type==='working'&&e.superseded_at).reverse().slice(0,20).map((e)=>({id:e.id,updated_at:e.created_at,content:e.content,...(projectReceiptMode(e)?{mode:projectReceiptMode(e)}:{})})):[];
  const archives=options.history?entries.filter((e)=>e.type==='episodic'&&e.content.startsWith('## Log archive')).reverse().slice(0,20).map((e)=>({id:e.id,updated_at:e.created_at,content:e.content})):[];
  return {vault_id:vault.getVaultId(),project,scope,shared:vault.sharedScopes().includes(scope),revision:head.id,updated_at:head.created_at,content:head.content,what_why:owned(doc,'What & Why'),status:owned(doc,'Current Status'),next_actions:owned(doc,'Next Actions'),decisions:owned(doc,'Decisions'),open_questions:owned(doc,'Open Questions'),files:parseProjectFiles(fileText),files_text:fileText,log:owned(doc,'Log'),history,archives};
}
export function listProjectViews(vault:ProjectVaultReader,allowedScopes?:string[]):ProjectSummary[]{
  const groups=new Map<string,MemoryEntry[]>(); for(const e of vault.list({type:'working',allowedScopes})){const p=parseProjectSlug(e.scope);if(p){const a=groups.get(p)||[];a.push(e);groups.set(p,a);}}
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([project,heads])=>heads.length!==1?{project,scope:projectScope(project),status:null,revision:null,updated_at:null,conflict:true}:{project,scope:projectScope(project),status:getProjectSection(parseProjectDoc(heads[0]!.content),'Current Status')||null,revision:heads[0]!.id,updated_at:heads[0]!.created_at,conflict:false});
}
