import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SharedCatalog,sanitizeOwnerProjects} from './shared-catalog.mjs';
import {mergeSharedProjects} from './project-catalog.mjs';
const store={projects:[
 {id:'agent',name:'coraa-agent',components:[{id:'api',label:'API',path:'/workspace/coraa-agent',run:'rm -rf /',env:{TOKEN:'secret'}}],accounts:{claude:'owner'}},
 {id:'home',name:'Dotfiles',components:[{id:'h',label:'Home',path:'/home/agent/.config'}]},
 {id:'escape',name:'Escape',components:[{id:'e',label:'E',path:'/workspace/../home/agent'}]},
 {id:'legacy',name:'Copied',components:[{id:'c',label:'C',path:'/workspace/projects/p_1/content'}]},
 {id:'shared',name:'Other share',sharedWorkspaceId:'ws-b',components:[{id:'s',label:'S',path:'/workspace/s'}]},
],openIds:['agent']};
test('only names and /workspace paths of the owner projects are kept',()=>{
 assert.deepEqual(sanitizeOwnerProjects(store),[{id:'agent',name:'coraa-agent',components:[{id:'api',label:'API',path:'/workspace/coraa-agent'}]}]);
});
test('the catalog persists privately and feeds member stores with the same paths',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'canopy-catalog-'));
 try{
  const catalog=new SharedCatalog({directory});await catalog.update('ws-a',JSON.stringify(store));
  assert.equal((await stat(join(directory,'ws-a.json'))).mode&0o777,0o600);
  assert.equal((await readFile(join(directory,'ws-a.json'),'utf8')).includes('secret'),false);
  const restarted=new SharedCatalog({directory});const owner=await restarted.definitions('ws-a',{readOnly:true});
  assert.deepEqual(owner,[{id:'agent',name:'coraa-agent',sharedWorkspaceId:'ws-a',readOnly:true,components:[{id:'api',label:'API',path:'/workspace/coraa-agent'}]}]);
  const member=JSON.parse(mergeSharedProjects(JSON.stringify({projects:[{id:'mine',name:'Mine',components:[]}],openIds:[]}),{id:'member-x',parentWorkspaceId:'ws-a',projectMounts:[]},owner));
  assert.deepEqual(member.projects.map(p=>p.id),['mine','agent']);assert.equal(member.projects[1].readOnly,true);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('a member without a saved store still sees the owner projects',()=>{
 const owner=[{id:'agent',name:'coraa-agent',sharedWorkspaceId:'ws-a',readOnly:false,components:[{id:'api',label:'API',path:'/workspace/coraa-agent'}]}];
 for(const empty of [null,'','null'])assert.deepEqual(JSON.parse(mergeSharedProjects(empty,{id:'member-x',parentWorkspaceId:'ws-a',projectMounts:[]},owner)).projects.map(p=>p.id),['agent']);
});
test('run commands travel for the Servers list, never automatic and never outside /workspace',()=>{
 const commands=[
  {id:'dev',name:'Dev server',command:'npm run dev',cwd:'/workspace/coraa-agent/web',purpose:'serve',automatic:true,readiness:{kind:'http',path:'/health',timeoutMs:60000},env:{TOKEN:'secret'}},
  {id:'home',name:'Home',command:'ls',cwd:'/home/agent'},
  {id:'dev',name:'Duplicate',command:'echo'},
  {id:'ctl',name:'Control',command:'echo \u0007'},
  {id:'argv',name:'Migrate',command:'npm run migrate',argv:['npm','run','migrate'],purpose:'setup',readiness:{kind:'bogus'}},
 ];
 const [project]=sanitizeOwnerProjects({projects:[{id:'agent',name:'coraa-agent',components:[{id:'api',label:'API',path:'/workspace/coraa-agent',role:'web',commands}]}]});
 assert.deepEqual(project.components,[{id:'api',label:'API',path:'/workspace/coraa-agent',role:'web',commands:[
  {id:'dev',name:'Dev server',command:'npm run dev',cwd:'/workspace/coraa-agent/web',purpose:'serve',readiness:{kind:'http',path:'/health',timeoutMs:60000}},
  {id:'argv',name:'Migrate',command:'npm run migrate',argv:['npm','run','migrate'],purpose:'setup'},
 ]}]);
});
test('shared projects open once as tabs and replace the raw /workspace root projects',()=>{
 const owner=[{id:'coraa',name:'Coraa',sharedWorkspaceId:'ws-a',readOnly:false,components:[{id:'c',label:'coraa-ai',path:'/workspace/p_1/repo-1'}]},
  {id:'canopy',name:'Canopy',sharedWorkspaceId:'ws-a',readOnly:false,components:[{id:'k',label:'canopy',path:'/workspace/p_2/repo-1'}]}];
 const member={id:'member-x',parentWorkspaceId:'ws-a',projectMounts:[]};
 const root=id=>({id,name:'Workspace',components:[{id:id+'-root',label:'Workspace',path:'/workspace'}]});
 // The store Vijay had: two raw roots open, shared projects saved before the mark existed.
 const before={projects:[root('remote-member-1'),root('remote-ws-a'),{id:'mine',name:'Mine',components:[{id:'m',label:'M',path:'/workspace/mine'}]},{...owner[0]}],openIds:['remote-member-1','remote-ws-a'],activeId:'remote-member-1'};
 const first=JSON.parse(mergeSharedProjects(JSON.stringify(before),member,owner));
 assert.deepEqual(first.projects.map(p=>p.id),['mine','coraa','canopy']);
 assert.deepEqual(first.openIds,['coraa','canopy']);assert.equal(first.activeId,'coraa');
 assert.ok(first.projects.filter(p=>p.sharedWorkspaceId).every(p=>p.sharedOpened===true));
 // A tab the member closes stays closed after their save and the next load.
 const closed=JSON.parse(mergeSharedProjects(JSON.stringify({...first,openIds:['canopy'],activeId:'canopy'}),member,owner));
 assert.deepEqual(closed.openIds,['canopy']);assert.equal(closed.activeId,'canopy');
 // A project the owner adds later opens once.
 const added=JSON.parse(mergeSharedProjects(JSON.stringify(closed),member,[...owner,{id:'relay',name:'The Relay',sharedWorkspaceId:'ws-a',readOnly:false,components:[{id:'r',label:'Web',path:'/workspace/p_3/repo-1'}]}]));
 assert.deepEqual(added.openIds,['canopy','relay']);
 // The owner's own root project in the catalog is dropped too (it was the active tab).
 const ownerRoot={...root('remote-ws-a'),sharedWorkspaceId:'ws-a',readOnly:false};
 const withOwnerRoot=JSON.parse(mergeSharedProjects(JSON.stringify(before),member,[ownerRoot,...owner]));
 assert.deepEqual(withOwnerRoot.projects.map(p=>p.id),['mine','coraa','canopy']);assert.equal(withOwnerRoot.activeId,'coraa');
 // An owner with only the root project still shares it.
 assert.deepEqual(JSON.parse(mergeSharedProjects(null,member,[ownerRoot])).projects.map(p=>p.id),['remote-ws-a']);
 // Without owner projects the root project is the member's only view and stays.
 assert.deepEqual(JSON.parse(mergeSharedProjects(JSON.stringify(before),member,[])).projects.map(p=>p.id),['remote-member-1','remote-ws-a','mine']);
});
