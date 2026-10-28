import test from 'node:test';import assert from 'node:assert/strict';
import {SharedSessions} from './shared-sessions.mjs';
const workspace={id:'ws-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',cgroupParent:'canopy-abcd.slice',accounts:['owner'],ownerImage:'sha256:'+'a'.repeat(64),projectMounts:[{id:'app',writable:true},{id:'secret',writable:true}]};
const access=(ids,write=false)=>({allRead:false,allWrite:false,selected:ids.map(id=>({id,writable:write}))});
const principal={workspaceId:workspace.id,memberId:'alice',expiresAt:1000,scope:'drive'};
test('published sessions require explicit disclosure and fresh project/session grants',async()=>{
 let current={projectAccess:access(['app'],true),sessionAccess:{view:access(['app']),interact:access([])}};
 const shares=new SharedSessions({now:()=>10,authorizeMember:async()=>current});try{
 assert.throws(()=>shares.publish(workspace,{sessionId:1,projectId:'app',title:'Build',mode:'view'}));
 const p=shares.publish(workspace,{sessionId:1,projectId:'app',title:'Build',mode:'view',acknowledged:true});
 assert.equal((await shares.resolve(workspace,principal,'Bearer own',p.id)).sessionId,1);
 await assert.rejects(shares.resolve(workspace,principal,'Bearer own',p.id,'interact'));
 assert.deepEqual(Object.keys((await shares.list(workspace,principal,'Bearer own'))[0]).sort(),['expiresAt','id','mode','projectId','title']);
 current={...current,sessionAccess:{view:access([]),interact:access([])}};
 await assert.rejects(shares.resolve(workspace,principal,'Bearer own',p.id));
 }finally{shares.close();}
});
test('broad personal develop cannot widen narrow session interactions',async()=>{
 const shares=new SharedSessions({now:()=>10,authorizeMember:async()=>({projectAccess:{allRead:true,allWrite:true,selected:[]},sessionAccess:{view:{allRead:true,allWrite:false,selected:[]},interact:access(['app'],true)}})});try{
 const entry=shares.collaboration(workspace,{projectId:'secret',title:'Separate'});shares.register(entry,1);
 await assert.rejects(shares.resolve(workspace,principal,'Bearer own',entry.id,'interact'));
 assert.equal((await shares.resolve(workspace,principal,'Bearer own',entry.id)).projectId,'secret');
 }finally{shares.close();}
});
test('collaboration runtime mounts one project and never owner home accounts/image',async()=>{
 const stopped=[],shares=new SharedSessions({now:()=>10,stop:async runtime=>stopped.push(runtime.id)});try{
 const p=shares.collaboration(workspace,{projectId:'app',title:'Together'});shares.register(p,7);
 assert.deepEqual(p.runtime.accounts,[]);assert.equal(p.runtime.ownerImage,undefined);assert.deepEqual(p.runtime.projectMounts,[{id:'app',writable:true}]);assert.notEqual(p.runtime.id,workspace.id);
 assert.equal(shares.activeRuntime(p.runtime.id),true);shares.revoke(workspace.id,p.id);assert.equal(shares.activeRuntime(p.runtime.id),false);await Promise.resolve();assert.deepEqual(stopped,[p.runtime.id]);
 }finally{shares.close();}
});
test('revoke during authority await, expiry and restart invalidate publication IDs',async()=>{
 let finish;let now=10;const shares=new SharedSessions({now:()=>now,maxAgeMs:20,authorizeMember:()=>new Promise(resolve=>{finish=resolve;})});try{
 const p=shares.publish(workspace,{sessionId:1,projectId:'app',title:'Build',mode:'view',acknowledged:true});
 const waiting=shares.resolve(workspace,principal,'Bearer own',p.id);shares.revoke(workspace.id,p.id);finish({projectAccess:access(['app']),sessionAccess:{view:access(['app']),interact:access([])}});await assert.rejects(waiting);
 const q=shares.publish(workspace,{sessionId:1,projectId:'app',title:'Build',mode:'view',acknowledged:true});assert.notEqual(q.id,p.id);now=31;assert.deepEqual(shares.ownerList(workspace.id),[]);
 const fresh=new SharedSessions();assert.equal(fresh.entries.size,0);fresh.close();
 }finally{shares.close();}
});
test('failed shutdown revokes access immediately and retains a retryable cleanup record',async()=>{
 let failure=true;const shares=new SharedSessions({stop:async()=>{if(failure)throw Error('Docker unavailable');}});try{
 const p=shares.collaboration(workspace,{projectId:'app',title:'Pair'});shares.register(p,1);await assert.rejects(shares.revoke(workspace.id,p.id),/shutdown is pending/);assert.equal(shares.entries.has(p.id),false);assert.equal(shares.pendingStops.size,1);failure=false;await shares.stopPending(shares.pendingStops.values().next().value);assert.equal(shares.pendingStops.size,0);
 }finally{shares.close();}
});
test('a published terminal may carry its live session room, strictly shaped, to viewers with access',async()=>{
 const current={projectAccess:access(['app']),sessionAccess:{view:access(['app']),interact:access([])}};
 const shares=new SharedSessions({now:()=>10,authorizeMember:async()=>current});try{
 const room={id:'0f8fad5b-d9cb-469f-a165-70867728950e',owner:'owner-account',team:'team-1'};
 for(const bad of [{...room,id:'nope'},{...room,owner:''},{...room,team:'a‮b'},{...room,extra:1},[room],'room'])
  assert.throws(()=>shares.publish(workspace,{sessionId:2,projectId:'app',title:'Agent',mode:'view',acknowledged:true,room:bad}));
 const p=shares.publish(workspace,{sessionId:2,projectId:'app',title:'Agent',mode:'view',acknowledged:true,room});
 assert.deepEqual(p.room,room);assert.deepEqual(shares.ownerList(workspace.id)[0].room,room);
 assert.deepEqual((await shares.list(workspace,principal,'Bearer own'))[0].room,room);
 }finally{shares.close();}
});
test('an owner project can be published for watching, only to members granted that project id',async()=>{
 const owners={ownerProjectIds:new Set(['suprflow','other'])};let current;
 const shares=new SharedSessions({now:()=>10,authorizeMember:async()=>current});try{
 assert.throws(()=>shares.publish(workspace,{sessionId:3,projectId:'suprflow',title:'Build',mode:'view',acknowledged:true}),/Invalid session publication/,'unknown without the owner catalog');
 assert.throws(()=>shares.publish(workspace,{sessionId:3,projectId:'nowhere',title:'Build',mode:'view',acknowledged:true},owners),/Invalid session publication/);
 const p=shares.publish(workspace,{sessionId:3,projectId:'suprflow',title:'Build',mode:'view',acknowledged:true},owners);
 assert.equal(p.catalog,undefined);assert.deepEqual(Object.keys(shares.ownerList(workspace.id)[0]).sort(),['collaborative','expiresAt','id','mode','projectId','sessionId','title','workspaceId']);
 current={projectAccess:access(['suprflow']),sessionAccess:{view:access(['suprflow']),interact:access(['suprflow'],true)}};
 assert.equal((await shares.resolve(workspace,principal,'Bearer own',p.id)).sessionId,3);
 await assert.rejects(shares.resolve(workspace,principal,'Bearer own',p.id,'interact'));
 assert.deepEqual((await shares.list(workspace,principal,'Bearer own')).map(s=>[s.projectId,s.mode]),[['suprflow','view']]);
 current={projectAccess:{allRead:true,allWrite:true,selected:[]},sessionAccess:{view:{allRead:true,allWrite:false,selected:[]},interact:access([])}};
 assert.equal((await shares.resolve(workspace,principal,'Bearer own',p.id)).projectId,'suprflow','a whole-workspace grant covers owner projects');
 for(const denied of [
  {projectAccess:access(['other']),sessionAccess:{view:access(['suprflow']),interact:access([])}},
  {projectAccess:access(['app'],true),sessionAccess:{view:{allRead:true,allWrite:false,selected:[]},interact:access([])}},
  {projectAccess:access(['suprflow']),sessionAccess:{view:access(['other']),interact:access([])}},
 ]){current=denied;await assert.rejects(shares.resolve(workspace,principal,'Bearer own',p.id),/Forbidden/);assert.deepEqual(await shares.list(workspace,principal,'Bearer own'),[]);}
 }finally{shares.close();}
});
test('Pair on an owner project is refused in plain words; unknown projects keep the generic refusal',()=>{
 const shares=new SharedSessions();try{
 const owners={ownerProjectIds:new Set(['suprflow','app'])};
 assert.throws(()=>shares.collaboration(workspace,{projectId:'suprflow',title:'Pair'},owners),/^Error: Pair needs a shared project/);
 assert.throws(()=>shares.collaboration(workspace,{projectId:'nowhere',title:'Pair'},owners),/Invalid collaboration project/);
 assert.deepEqual(shares.collaboration(workspace,{projectId:'app',title:'Pair'},owners).runtime.projectMounts,[{id:'app',writable:true}],'a mount with the same id still pairs');
 assert.equal(shares.entries.size,0);
 }finally{shares.close();}
});
