import test from 'node:test';
import assert from 'node:assert/strict';
import {memberRuntime} from './member-runtime.mjs';
import {DockerWorkspaces} from './docker.mjs';
const workspace={id:'shared',cgroupParent:'canopy-shared.slice',accounts:['owner-credentials'],memoryMiB:2048,cpus:2};
const principal=memberId=>({memberId,workspaceId:'shared',scope:'drive'});
test('member identity determines private runtime, never inherits owner credentials',()=>{
 const a=memberRuntime(workspace,principal('alice')),b=memberRuntime(workspace,principal('bob'));
 assert.notEqual(a.id,b.id);assert.deepEqual(a.accounts,[]);assert.deepEqual(b.accounts,[]);
 assert.equal(memberRuntime(workspace,principal('alice')).id,a.id);
 assert.throws(()=>memberRuntime(workspace,{...principal('alice'),workspaceId:'other'}),/Forbidden/);
 assert.equal(memberRuntime(workspace,{...principal('alice'),scope:'view'}).readOnly,true);
 const host=new DockerWorkspaces({secret:'host-secret'});assert.notEqual(host.token(a.id),host.token(b.id));assert.notEqual(host.token(a.id),host.token(workspace.id));
});
test('host-generated Docker resource names cannot contain attacker path separators',()=>{
 const runtime=memberRuntime(workspace,principal('../../owner'));assert.match(runtime.id,/^member-[a-f0-9]{40}$/);assert.equal(runtime.id.includes('..'),false);
});
test('member Docker launch contains only that members volumes and no shared credential pool',async()=>{
 const calls=[];const runtime=memberRuntime(workspace,principal('alice'));let launched=false;
 const host=new DockerWorkspaces({secret:'host-secret',verifyCapacity:async()=>{},docker:async args=>{calls.push(args);if(args[0]==='run')launched=true;if(args[0]==='inspect'&&!launched)throw Object.assign(Error('missing'),{missingResource:true});if(args[0]==='inspect')return {stdout:JSON.stringify([{NetworkSettings:{Networks:{['canopy-net-'+runtime.id]:{IPAddress:'172.18.0.2'}},Ports:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'41000'}]}}}])};return {stdout:''};}});
 await host.open(runtime);const run=calls.find(args=>args[0]==='run');
 assert.ok(run.includes('--cgroup-parent'));assert.ok(run.includes('canopy-shared.slice'));
 assert.ok(run.includes(`type=volume,source=canopy-home-${runtime.storageId},target=/home/agent`));
 assert.ok(run.includes('type=volume,source=canopy-project-shared,target=/workspace'),'members share the workspace project volume');
 assert.ok(!run.some(x=>x.includes('owner-credentials')||x.includes('docker.sock')||x.includes('canopy-home-shared')),'never the owner home or accounts');
 assert.ok(run.includes('canopy-net-'+runtime.id),'own network');
});
test('viewers get the workspace project volume read-only; their home stays writable',async()=>{
 const calls=[];const runtime=memberRuntime(workspace,{...principal('vera'),scope:'view'});let launched=false;
 const host=new DockerWorkspaces({secret:'host-secret',verifyCapacity:async()=>{},docker:async args=>{calls.push(args);if(args[0]==='run')launched=true;if(args[0]==='inspect'&&!launched)throw Object.assign(Error('missing'),{missingResource:true});if(args[0]==='inspect')return {stdout:JSON.stringify([{NetworkSettings:{Networks:{['canopy-net-'+runtime.id]:{IPAddress:'172.18.0.3'}},Ports:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'41001'}]}}}])};return {stdout:''};}});
 await host.open(runtime);const run=calls.find(args=>args[0]==='run');
 assert.ok(run.includes('type=volume,source=canopy-project-shared,target=/workspace,readonly'));
 assert.ok(run.includes(`type=volume,source=canopy-home-${runtime.storageId},target=/home/agent`));
});

test('members cannot launch without an aggregate capacity boundary',()=>{assert.throws(()=>memberRuntime({...workspace,cgroupParent:undefined},principal('alice')),/capacity/);});

test('owner filesystem checkpoints are never inherited by members',async()=>{
 const ownerImage='sha256:'+'a'.repeat(64);
 const runtime=memberRuntime({...workspace,ownerImage},principal('alice'));
 assert.equal(runtime.ownerImage,undefined);
 const docker=async()=>{throw Error('Docker must not be reached');};
 const host=new DockerWorkspaces({secret:'test',docker});
 await assert.rejects(host.ensure({...runtime,ownerImage}),/Invalid owner image/);
});
