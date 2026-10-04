import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedProjectDefinitions,mergeSharedProjects} from './project-catalog.mjs';
import {memberRuntime} from './member-runtime.mjs';
const workspace={id:'owner',cgroupParent:'canopy-owner.slice',projectMounts:[{id:'app',name:'Product',writable:true,components:[{id:'web',label:'Frontend',relativePath:'web'},{id:'api',label:'Backend',relativePath:'services/api',env:{SECRET:'excluded'},runCommand:'excluded'}]},{id:'private',writable:true}]};
test('member project discovery preserves granted project components without owner execution settings',()=>{
 const member=memberRuntime(workspace,{memberId:'alice',workspaceId:'owner',scope:'drive'},{allRead:false,allWrite:false,selected:[{id:'app',writable:true}]});
 const projects=sharedProjectDefinitions(member);
 assert.deepEqual(projects,[{id:'app',name:'Product',sharedWorkspaceId:'owner',components:[{id:'web',label:'Frontend',path:'/workspace/projects/app/web'},{id:'api',label:'Backend',path:'/workspace/projects/app/services/api'}]}]);
});
test('refresh removes revoked shared metadata while retaining private projects and tab state',()=>{
 const result=JSON.parse(mergeSharedProjects(JSON.stringify({projects:[{id:'personal',name:'Mine'},{id:'revoked',sharedWorkspaceId:'owner'}],openIds:['personal','revoked'],activeId:'revoked'}),{id:'member',parentWorkspaceId:'owner',projectMounts:[workspace.projectMounts[0]]}));
 assert.deepEqual(result.projects.map(p=>p.id),['personal','app']);assert.deepEqual(result.openIds,['personal']);assert.equal(result.activeId,'personal');
});
test('catalog rejects component paths outside its project and duplicate identifiers',()=>{
 for(const relativePath of ['/home/agent','../secret','web/../../secret','web\\secret','web//secret','web/./secret','web\0secret']){
  assert.throws(()=>sharedProjectDefinitions({id:'owner',projectMounts:[{id:'app',writable:true,components:[{id:'web',label:'Web',relativePath}]}]}),/component/);
 }
 const project=structuredClone(workspace.projectMounts[0]);project.components.push(project.components[0]);
 assert.throws(()=>sharedProjectDefinitions({id:'owner',projectMounts:[project]}),/component/);
});
test('owner project paths switch to migrated shared mounts while private projects remain unchanged',()=>{
 const store={projects:[{id:'app',name:'Old',components:[{id:'web',path:'/workspace/old/web'}]},{id:'personal',name:'Private'}],openIds:['app'],activeId:'app'};
 const merged=JSON.parse(mergeSharedProjects(JSON.stringify(store),{...workspace,projectMounts:[{...workspace.projectMounts[0],components:[{id:'web',label:'Web',relativePath:'content/web'}]}]}));
 assert.equal(merged.projects.find(p=>p.id==='app').components[0].path,'/workspace/projects/app/content/web');
 assert.deepEqual(merged.projects.find(p=>p.id==='personal'),store.projects[1]);assert.equal(merged.activeId,'app');
});
