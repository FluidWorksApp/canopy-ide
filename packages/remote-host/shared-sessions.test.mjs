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
