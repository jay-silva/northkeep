import { exactCanonicalJson } from './consolidation.js';
import {
  PROJECT_DOC_MAX_CHARS,
  PROJECT_LOG_ARCHIVE_HEADING,
  PROJECT_DOC_CAP_MESSAGE,
  PROJECT_SECTION_HEADINGS,
  formatLogArchive,
  formatProjectDraftLine,
  getProjectSection,
  isProjectDraft,
  parseProjectDoc,
  parseProjectSlug,
  projectScope,
  rollProjectLog,
  serializeProjectDoc,
  setProjectDraft,
  type ProjectDoc,
} from './project-doc.js';
import type { MemoryEntry } from './types.js';

/** Row source of a head written by `northkeep projects import` (vault.ts importProject). */
export const PROJECT_IMPORT_SOURCE = 'northkeep:project-import';
export const PROJECT_HANDOFF_METADATA_KEY = 'northkeep_project_handoff_v1';
/** Reserved metadata key for the writer of a project head (ADR 0052 Decision 1). */
export const PROJECT_PROVENANCE_METADATA_KEY = 'northkeep_provenance_v1';
export const PROJECT_REVISION_SUMMARY_LIMIT = 20;
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

/** Host-reported writer of a project write. Any process can present any name. */
export interface ProjectWriter { host: string; host_version?: string | null; session_id: string }
export interface ProjectProvenance { version: 1; host: string; host_version: string | null; model: null; session_id: string; recorded_at: string }

export interface ProjectRevision { id: string; updated_at: string; content: string; mode?: ProjectHandoffMode }
export interface ProjectRevisionSummary { id: string; updated_at: string; mode?: ProjectHandoffMode; writer?: { host: string; host_version: string | null; session_id: string }; chars: number }
export interface ProjectArchiveSummary { count: number; oldest: string | null; newest: string | null }
export interface ProjectArchive { id: string; updated_at: string; content: string }
export interface ProjectView {
  vault_id: string;
  project: string;
  scope: string;
  shared: boolean;
  revision: string;
  updated_at: string;
  content: string;
  /** Owner-set display title (level-1 heading), or null when the slug is the name. */
  title: string | null;
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
  /** Always present, content free, newest first (ADR 0052 Decision 3). */
  revisions: ProjectRevisionSummary[];
  archive_summary: ProjectArchiveSummary;
  last_writer: ProjectProvenance | null;
  draft: boolean;
}
/** `imported`: the current head was written by `projects import`, so `updated_at` is the import time, not the work's (ADR 0054). */
export interface ProjectSummary { project:string; scope:string; title:string|null; status:string|null; revision:string|null; updated_at:string|null; conflict:boolean; last_writer_host:string|null; draft:boolean; imported:boolean }

export interface ProjectCheckpointRequest {
  vault_id:string; project:string; mode:ProjectHandoffMode; operation_id:string; expected_revision:string;
  status:string; completed:string; next_actions:string; decision?:string; open_questions?:string; files?:ProjectFileReference[];
  writer?:ProjectWriter;
}
export interface ProjectUpdateRequest {
  project:string; expected_revision:string|null; what_why?:string; status?:string; next_actions?:string;
  decision?:string; log_entry?:string; open_questions?:string; files?:ProjectFileReference[];
  /** Display title, kept as a level-1 heading at the top of the document. Empty string removes it. */
  title?:string;
  writer?:ProjectWriter;
  /** True only on creation; false removes the draft line from an existing document. */
  draft?:boolean;
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

export interface ProjectVaultReader { list(filter?:Record<string,unknown>):MemoryEntry[]; getVaultId():string; sharedScopes():string[] }

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

const SESSION_ID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Invisible characters steer whoever reads the block back, so they never enter it. */
const UNSAFE_WRITER_CHARS=/[\p{Cc}\p{Cf}\u2028\u2029]/u;
/** A lone surrogate half is not a character; JSON escapes it and a reader sees a gap. */
const UNPAIRED_SURROGATE=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const unsafeWriterText=(value:string):boolean=>UNSAFE_WRITER_CHARS.test(value)||UNPAIRED_SURROGATE.test(value);
/** Refuses rather than sanitizes: a host that sends junk should learn it did. */
export function validateProjectWriter(writer:ProjectWriter):{host:string;host_version:string|null;session_id:string}{
  if(!writer||typeof writer!=='object'||Array.isArray(writer))fail('writer is malformed.');
  const allowed=new Set(['host','host_version','session_id']); if(Object.keys(writer).some((key)=>!allowed.has(key)))fail('writer has unsupported fields.');
  if(typeof writer.host!=='string'||writer.host.length<1||writer.host.length>80||writer.host.trim().length===0||unsafeWriterText(writer.host))fail('writer host must be 1 to 80 characters, not blank, without control, format, line separator or unpaired surrogate characters.');
  if(writer.host_version!==undefined&&writer.host_version!==null&&(typeof writer.host_version!=='string'||writer.host_version.length>40||unsafeWriterText(writer.host_version)))fail('writer host_version must be at most 40 characters without control, format, line separator or unpaired surrogate characters, or null.');
  if(typeof writer.session_id!=='string'||!SESSION_ID_PATTERN.test(writer.session_id))fail('writer session_id must be a lowercase RFC 4122 v4 UUID.');
  return {host:writer.host,host_version:writer.host_version??null,session_id:writer.session_id};
}
export function projectProvenanceBlock(writer:ProjectWriter,recordedAt:string):ProjectProvenance{
  const valid=validateProjectWriter(writer);
  return {version:1,host:valid.host,host_version:valid.host_version,model:null,session_id:valid.session_id,recorded_at:recordedAt};
}
/** Null for absent or malformed blocks. A read of the record never fails the read. */
export function readProjectProvenance(entry:MemoryEntry):ProjectProvenance|null{
  const raw=entry.metadata?.[PROJECT_PROVENANCE_METADATA_KEY];
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const m=raw as Record<string,unknown>; const keys=new Set(['version','host','host_version','model','session_id','recorded_at']);
  if(Object.keys(m).length!==keys.size||Object.keys(m).some((key)=>!keys.has(key)))return null;
  if(m.version!==1||m.model!==null)return null;
  if(typeof m.host!=='string'||m.host.length<1||m.host.length>80||m.host.trim().length===0||unsafeWriterText(m.host))return null;
  if(m.host_version!==null&&(typeof m.host_version!=='string'||m.host_version.length>40||unsafeWriterText(m.host_version)))return null;
  if(typeof m.session_id!=='string'||!SESSION_ID_PATTERN.test(m.session_id))return null;
  if(typeof m.recorded_at!=='string'||!Number.isFinite(Date.parse(m.recorded_at)))return null;
  return {version:1,host:m.host,host_version:m.host_version as string|null,model:null,session_id:m.session_id,recorded_at:m.recorded_at};
}

export function applyProjectUpdate(content:string, request:ProjectUpdateRequest, now=new Date()):{content:string;archives:string[]} {
  const doc=parseProjectDoc(content); for(const h of ['What & Why','Current Status','Next Actions','Decisions','Log','Open Questions','Files']) owned(doc,h);
  const replacements:[string,string|undefined,boolean][]=[['What & Why',request.what_why,false],['Current Status',request.status,false],['Next Actions',request.next_actions,true],['Open Questions',request.open_questions,true]];
  for(const [heading,value,empty] of replacements) if(value!==undefined){assertProjectText(value,heading,empty);setSection(doc,heading,value);}
  if(request.title!==undefined)setProjectTitle(doc,request.title);
  const date=now.toISOString().slice(0,10);
  if(request.decision!==undefined){assertProjectText(request.decision,'decision',false);const old=owned(doc,'Decisions');setSection(doc,'Decisions',`${old}${old?'\n':''}- ${date} - ${request.decision}`);}
  if(request.log_entry!==undefined){assertProjectText(request.log_entry,'log_entry',false);const old=owned(doc,'Log');setSection(doc,'Log',`- ${date} - ${request.log_entry}${old?'\n'+old:''}`);}
  if(request.files!==undefined)setSection(doc,'Files',formatProjectFiles(request.files));
  if(request.draft!==undefined){
    if(typeof request.draft!=='boolean')fail('draft must be a boolean.');
    if(request.draft&&request.expected_revision!==null)fail('draft can only be set when a project is created.');
    const host=request.writer!==undefined?validateProjectWriter(request.writer).host:'unknown host';
    setProjectDraft(doc,request.draft,formatProjectDraftLine(host,now));
  }
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

/** The display title is a level-1 heading that opens the document; owned sections stay level 2. */
export function getProjectTitle(doc:ProjectDoc):string|null {
  const first=doc.sections[0]; return first&&first.level===1?first.title:null;
}
export const PROJECT_TITLE_MAX_CHARS=120;
function setProjectTitle(doc:ProjectDoc, title:string):void {
  const value=title.trim();
  if(value.length>PROJECT_TITLE_MAX_CHARS)fail(`Project title is too long (${PROJECT_TITLE_MAX_CHARS} characters max).`);
  if(/[\r\n]/.test(value))fail('Project title must be a single line.');
  if((PROJECT_SECTION_HEADINGS as readonly string[]).includes(value)||value==='Log archive')fail('Project title cannot be the name of a document section.');
  const first=doc.sections[0]; const hasTitle=first!==undefined&&first.level===1;
  if(value.length===0){ if(hasTitle){ if(first.body.length>0){doc.preamble=[doc.preamble,first.body].filter((s)=>s.length>0).join('\n\n');} doc.sections.shift(); } return; }
  if(hasTitle){first.title=value;return;}
  doc.sections.unshift({level:1,title:value,body:''});
}

export function getProjectView(vault:ProjectVaultReader, project:string, allowedScopes?:string[], options:{history?:boolean}={}):ProjectView {
  const scope=projectScope(project); if(allowedScopes!==undefined&&!allowedScopes.includes(scope))throw new ProjectHandoffError('scope_denied','Project scope is outside this connection grant.');
  const all=vault.list({scope,includeSuperseded:true,allowedScopes}); const live=all.filter((e)=>e.type==='working'&&!e.forgotten_at&&!e.superseded_at);
  if(live.length===0)throw new ProjectHandoffError('not_found','Project was not found.'); if(live.length>1)throw new ProjectHandoffError('project_conflict','Project has multiple current documents.');
  const head=live[0]!; const doc=parseProjectDoc(head.content); for(const h of ['What & Why','Current Status','Next Actions','Decisions','Log','Open Questions','Files'])owned(doc,h);
  const fileText=owned(doc,'Files'); const entries=all.filter((e)=>!e.forgotten_at);
  const priors=entries.filter((e)=>e.type==='working'&&e.superseded_at).reverse();
  const archiveRows=entries.filter((e)=>e.type==='episodic'&&e.content.startsWith(PROJECT_LOG_ARCHIVE_HEADING)).reverse();
  const history=options.history?priors.slice(0,PROJECT_REVISION_SUMMARY_LIMIT).map((e)=>({id:e.id,updated_at:e.created_at,content:e.content,...(projectReceiptMode(e)?{mode:projectReceiptMode(e)}:{})})):[];
  const archives=options.history?archiveRows.slice(0,PROJECT_REVISION_SUMMARY_LIMIT).map((e)=>({id:e.id,updated_at:e.created_at,content:e.content})):[];
  const revisions=priors.slice(0,PROJECT_REVISION_SUMMARY_LIMIT).map((e)=>projectRevisionSummary(e));
  const stamps=archiveRows.map((e)=>e.created_at);
  const archive_summary={count:archiveRows.length,oldest:stamps.length?stamps[stamps.length-1]!:null,newest:stamps.length?stamps[0]!:null};
  return {vault_id:vault.getVaultId(),project,scope,shared:vault.sharedScopes().includes(scope),revision:head.id,updated_at:head.created_at,content:head.content,title:getProjectTitle(doc),what_why:owned(doc,'What & Why'),status:owned(doc,'Current Status'),next_actions:owned(doc,'Next Actions'),decisions:owned(doc,'Decisions'),open_questions:owned(doc,'Open Questions'),files:parseProjectFiles(fileText),files_text:fileText,log:owned(doc,'Log'),history,archives,revisions,archive_summary,last_writer:readProjectProvenance(head),draft:isProjectDraft(doc)};
}

function projectRevisionSummary(entry:MemoryEntry):ProjectRevisionSummary{
  const mode=projectReceiptMode(entry); const writer=readProjectProvenance(entry);
  return {id:entry.id,updated_at:entry.created_at,...(mode?{mode}:{}),...(writer?{writer:{host:writer.host,host_version:writer.host_version,session_id:writer.session_id}}:{}),chars:entry.content.length};
}

/**
 * One prior or current working revision in full. Rows outside this exact scope
 * are not found rather than denied, so a probe learns nothing about them.
 */
export function getProjectRevision(vault:ProjectVaultReader,project:string,revisionId:string,allowedScopes?:string[]):ProjectRevision{
  let scope:string; try{scope=projectScope(project);}catch{throw new ProjectHandoffError('invalid_request','Project slug is invalid.');}
  if(allowedScopes!==undefined&&!allowedScopes.includes(scope))throw new ProjectHandoffError('scope_denied','Project scope is outside this connection grant.');
  if(typeof revisionId!=='string'||revisionId.length===0)throw new ProjectHandoffError('invalid_request','Revision id is invalid.');
  const row=vault.list({scope,includeSuperseded:true,includeForgotten:true,allowedScopes}).find((e)=>e.id===revisionId&&e.scope===scope&&e.type==='working');
  if(row&&row.forgotten_at)throw new ProjectHandoffError('not_found','That project revision was compacted away: its text is gone and only the row remains.');
  if(!row)throw new ProjectHandoffError('not_found','Project revision was not found.');
  const mode=projectReceiptMode(row);
  return {id:row.id,updated_at:row.created_at,content:row.content,...(mode?{mode}:{})};
}
export function listProjectViews(vault:ProjectVaultReader,allowedScopes?:string[]):ProjectSummary[]{
  const groups=new Map<string,MemoryEntry[]>(); for(const e of vault.list({type:'working',allowedScopes})){const p=parseProjectSlug(e.scope);if(p){const a=groups.get(p)||[];a.push(e);groups.set(p,a);}}
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([project,heads])=>heads.length!==1?{project,scope:projectScope(project),title:null,status:null,revision:null,updated_at:null,conflict:true,last_writer_host:null,draft:false,imported:false}:(()=>{const head=heads[0]!;const doc=parseProjectDoc(head.content);return {project,scope:projectScope(project),title:getProjectTitle(doc),status:getProjectSection(doc,'Current Status')||null,revision:head.id,updated_at:head.created_at,conflict:false,last_writer_host:readProjectProvenance(head)?.host??null,draft:isProjectDraft(doc),imported:head.source===PROJECT_IMPORT_SOURCE};})());
}
