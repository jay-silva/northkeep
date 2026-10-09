import { describe, expect, it } from 'vitest';
import { listProjectOverview, listProjectViews, type ProjectVaultReader } from '../src/project-handoff.js';
import { applyProjectUpdate } from '../src/project-handoff.js';
import type { MemoryEntry } from '../src/types.js';

function row(project: string, content: string, id=project): MemoryEntry {
  return { id,scope:`project:${project}`,type:'working',content,created_at:'2026-09-01T00:00:00Z',source:'test',metadata:null } as MemoryEntry;
}

describe('current project overview projection', () => {
  it('reads current heads once, honors grants, and keeps the common summary wire shape exact', () => {
    const content=applyProjectUpdate('',{project:'alpha',expected_revision:null,title:'Alpine',status:'Ready',next_actions:'- Read chart',draft:true}).content;
    const entries=[row('alpha',content),row('dupe','One','one'),row('dupe','Two','two'),row('other','Other')];
    const filters: Record<string, unknown>[]=[];
    const vault:ProjectVaultReader={list(filter={}){filters.push(filter);return entries.filter(entry=>!Array.isArray(filter.allowedScopes)||filter.allowedScopes.includes(entry.scope))},getVaultId:()=>'',sharedScopes:()=>{throw new Error('Overview must not read sharing state')}};
    const overview=listProjectOverview(vault,['project:alpha','project:dupe']);
    expect(filters).toEqual([{type:'working',allowedScopes:['project:alpha','project:dupe']}]);
    expect(overview.map(project=>project.project)).toEqual(['alpha','dupe']);
    expect(overview[0]).toMatchObject({title:'Alpine',status:'Ready',next_actions:'- Read chart',draft:true});
    expect(overview[1]).toMatchObject({conflict:true,next_actions:null,status:null,revision:null});
    const summary=listProjectViews(vault,['project:alpha']);
    expect(Object.keys(summary[0]!).sort()).toEqual(['conflict','draft','imported','last_writer_host','project','revision','scope','status','title','updated_at']);
    expect(summary[0]).toEqual({project:'alpha',scope:'project:alpha',title:'Alpine',status:'Ready',revision:'alpha',updated_at:'2026-09-01T00:00:00Z',conflict:false,last_writer_host:null,draft:true,imported:false});
    expect(listProjectOverview(vault,[])).toEqual([]);
  });
});
