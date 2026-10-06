import test from 'node:test';
import assert from 'node:assert/strict';
import {projectMounts} from './project-mounts.mjs';
import {memberRuntime} from './member-runtime.mjs';
import {DockerWorkspaces} from './docker.mjs';

test('project volumes are workspace scoped and paths cannot escape their mount root',()=>{
 const w={id:'owner',projectMounts:[{id:'app',writable:false}]};
 const mount=projectMounts(w)[0];
 assert.equal(mount[0],'/workspace/projects/app');assert.equal(mount[2],false);
 assert.deepEqual(projectMounts({...w,id:'member-a',parentWorkspaceId:'owner'}),[mount]);
 assert.notEqual(projectMounts({...w,id:'other'})[0][1],mount[1]);
 for(const id of ['../home','a/b','a,target=/home/agent','',null])assert.throws(()=>projectMounts({...w,projectMounts:[{id,writable:true}]}));
 assert.throws(()=>projectMounts({...w,projectMounts:[{id:'app',writable:true},{id:'app',writable:false}]}));
 assert.throws(()=>projectMounts({...w,projectMounts:[{id:'app',writable:'false'}]}));
});

test('member derivation does not inherit owner project grants',()=>{
 const member=memberRuntime({id:'owner',cgroupParent:'canopy-owner.slice',projectMounts:[{id:'secret',writable:true}]},{memberId:'alice',workspaceId:'owner',scope:'drive'});
 assert.deepEqual(member.projectMounts,[]);
});

test('changed grants bypass cached and concurrent runtime opens',async()=>{
 const host=new DockerWorkspaces({secret:'synthetic'});let release;const seen=[];
 const gate=new Promise(resolve=>{release=resolve;});
 host.ensure=async w=>{seen.push(structuredClone(w));if(seen.length===1)await gate;return {url:'synthetic'};};
 const original={id:'owner',projectMounts:[{id:'app',writable:true}]};
 const first=host.open(original);const revoked=host.open({...original,projectMounts:[]});
 release();await Promise.all([first,revoked]);assert.equal(seen.length,2);assert.deepEqual(seen[1].projectMounts,[]);
 await host.open({...original,projectMounts:[]});assert.equal(seen.length,2);
 await host.open(original);assert.equal(seen.length,3);
});
