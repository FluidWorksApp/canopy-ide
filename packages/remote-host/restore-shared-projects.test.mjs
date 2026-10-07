import test from 'node:test';import assert from 'node:assert/strict';
import {matchCopies,restoredStore} from './restore-shared-projects.mjs';
const copy=(n,extra)=>({path:`/workspace/projects/p_muwfihlx_1cy37g/content/.canopy-repositories/repository-${n}`,...extra});
test('copies map back to the original folders with their real names',()=>{
 const originals=[{path:'/workspace/coraa-agent',root:'r1',origin:'https://github.com/o/coraa-agent.git',head:'h1',contains:['h1']},{path:'/workspace/dashboard',root:'r2',origin:'git@github.com:o/dashboard.git',head:'h2',contains:['h2']},{path:'/workspace/fork-a',root:'r3',origin:'u'},{path:'/workspace/fork-b',root:'r3',origin:'u'}];
 const mapping=matchCopies([copy(1,{root:'r1',origin:'https://token@github.com/o/coraa-agent.git',head:'h1'}),copy(2,{root:'r2',origin:'git@github.com:o/dashboard.git',head:'h9',dirty:2}),copy(3,{root:'r3',origin:'u',head:'x'}),copy(4,{root:'zz',origin:null,head:'y'})],originals);
 assert.equal(mapping[0].original,'/workspace/coraa-agent');assert.equal(mapping[0].onlyInCopy,false);
 assert.equal(mapping[1].original,'/workspace/dashboard');assert.equal(mapping[1].onlyInCopy,true,'commits made in the copy are reported');assert.equal(mapping[1].uncommitted,2);
 assert.equal(mapping[2].original,null,'two candidates are left for the owner to choose');assert.deepEqual(mapping[2].candidates,['/workspace/fork-a','/workspace/fork-b']);
 assert.equal(mapping[3].original,null);
});
test('the saved project list points back at originals and lists what it cannot resolve',()=>{
 const base='/workspace/projects/p_muwfihlx_1cy37g/content/.canopy-repositories';
 const store={projects:[{id:'p_muwfihlx_1cy37g',name:'Coraa',sharedWorkspaceId:'ws-a',readOnly:false,components:[{id:'agent',label:'coraa-agent',path:base+'/repository-1'},{id:'web',label:'web',path:base+'/repository-2/apps/web'},{id:'notes',label:'notes',path:'/workspace/projects/p_muwfihlx_1cy37g/content/notes'}]},{id:'own',name:'Own',components:[{id:'x',label:'x',path:'/workspace/x'}]}],openIds:['p_muwfihlx_1cy37g']};
 const {store:next,unresolved}=restoredStore(store,{workspaceId:'ws-a',mapping:[{copy:base+'/repository-1',original:'/workspace/coraa-agent'},{copy:base+'/repository-2',original:'/workspace/dashboard'}]});
 assert.deepEqual(next.projects[0].components.map(c=>c.path),['/workspace/coraa-agent','/workspace/dashboard/apps/web','/workspace/projects/p_muwfihlx_1cy37g/content/notes']);
 assert.equal('sharedWorkspaceId' in next.projects[0],false);assert.deepEqual(next.projects[1],store.projects[1]);assert.deepEqual(next.openIds,store.openIds);
 assert.deepEqual(unresolved,[{project:'Coraa',component:'notes',path:'/workspace/projects/p_muwfihlx_1cy37g/content/notes'}]);
});
