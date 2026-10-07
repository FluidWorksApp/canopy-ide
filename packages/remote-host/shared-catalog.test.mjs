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
