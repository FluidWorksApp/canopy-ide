import test from 'node:test';
import assert from 'node:assert/strict';
import {DockerWorkspaces} from './docker.mjs';
const id='member-'+'a'.repeat(40),runtime={id,parentWorkspaceId:'shared'};
test('revocation stops only verified member ownership and invalidates endpoint cache',async()=>{
 const calls=[];let running=true,owned=true;
 const host=new DockerWorkspaces({secret:'synthetic',docker:async args=>{
  calls.push(args);if(args[0]==='stop')running=false;
  return {stdout:JSON.stringify([{Config:{Labels:{'canopy.workspace':owned?id:'other'}},State:{Running:running}}])};
 }});
 host.runtimes.set(id,{runtime:{}});await host.suspendMember(runtime);
 assert.equal(host.runtimes.has(id),false);assert.deepEqual(calls.find(a=>a[0]==='stop'),['stop','--time','5','canopy-ws-'+id]);
 calls.length=0;owned=false;running=true;await assert.rejects(host.suspendMember(runtime),/ownership/);assert.equal(calls.some(a=>a[0]==='stop'),false);
 await assert.rejects(host.suspendMember({id:'owner',parentWorkspaceId:'shared'}),/Invalid/);
});
test('host recovery stops unleased member containers before serving',async()=>{
 const host=new DockerWorkspaces({secret:'synthetic',docker:async args=>{
  assert.deepEqual(args,['ps','--all','--filter','name=^/canopy-ws-member-','--format','{{.Names}}']);
  return {stdout:'canopy-ws-'+id+'\n'};
 }}),stopped=[];host.suspendMember=async r=>stopped.push(r.id);
 await host.suspendUnleasedMembers();assert.deepEqual(stopped,[id]);
});
test('unconfirmed Docker stop fails rather than reporting revocation complete',async()=>{
 const host=new DockerWorkspaces({secret:'synthetic',docker:async()=>({stdout:JSON.stringify([{Config:{Labels:{'canopy.workspace':id}},State:{Running:true}}])})});
 await assert.rejects(host.suspendMember(runtime),/did not stop/);
});
