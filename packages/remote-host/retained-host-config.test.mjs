import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,chmod,symlink,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mergeRetainedHostConfig,persistRetainedHostConfig} from './retained-host-config.mjs';
const config=()=>({workspaces:[{id:'owner',generation:2,desiredState:'running',memoryMiB:2048,cpus:2,accounts:['owner']}],principals:[{id:'managed-account',tokenSha256:'0'.repeat(64),scope:'drive',workspaces:['owner']}],managedSession:{workspaceId:'owner',key:'k'.repeat(32)}});
test('resume retains project mounts and capacity identity while adopting current intent and credentials',()=>{
 const previous=config();previous.workspaces[0].projectMounts=[{id:'app',name:'App',writable:true,components:[{id:'api',label:'API',relativePath:'content/api'}]}];previous.workspaces[0].ownerImage='sha256:'+'a'.repeat(64);previous.workspaces[0].cgroupParent='canopy-'+'b'.repeat(24)+'.slice';previous.workspaces[0].desiredState='stopped';
 const incoming=config();incoming.workspaces[0].generation=3;incoming.workspaces[0].memoryMiB=4096;incoming.managedSession.key='n'.repeat(32);
 const result=mergeRetainedHostConfig(incoming,previous);
 assert.deepEqual(result.workspaces[0].projectMounts,previous.workspaces[0].projectMounts);assert.equal(result.workspaces[0].ownerImage,previous.workspaces[0].ownerImage);assert.equal(result.workspaces[0].cgroupParent,previous.workspaces[0].cgroupParent);assert.equal(result.workspaces[0].desiredState,'running');assert.equal(result.workspaces[0].memoryMiB,4096);assert.equal(result.managedSession.key,'n'.repeat(32));assert.equal(incoming.workspaces[0].projectMounts,undefined);
});
test('cross-workspace metadata, stale generations and invalid capacity groups fail closed',()=>{
 const previous=config(),incoming=config();incoming.managedSession.workspaceId='other';assert.throws(()=>mergeRetainedHostConfig(incoming,previous));
 incoming.managedSession.workspaceId='owner';incoming.workspaces[0].generation=1;assert.throws(()=>mergeRetainedHostConfig(incoming,previous),/regressed/);
 incoming.workspaces[0].generation=2;previous.workspaces[0].cgroupParent='../../host';assert.throws(()=>mergeRetainedHostConfig(incoming,previous),/capacity/);
});
test('durable metadata is private, survives restart, and rejects public files and symlinks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'canopy-retained-'));const file=join(dir,'host.json');
 try{
  const initial=config();initial.workspaces[0].projectMounts=[{id:'app',writable:true}];await persistRetainedHostConfig(file,initial);
  const next=config();next.workspaces[0].generation=3;assert.equal((await persistRetainedHostConfig(file,next)).workspaces[0].projectMounts[0].id,'app');assert.equal(JSON.parse(await readFile(file)).workspaces[0].generation,3);
  await chmod(file,0o644);await assert.rejects(persistRetainedHostConfig(file,next),/Unsafe/);await chmod(file,0o600);
  const link=join(dir,'link');await symlink(file,link);await assert.rejects(persistRetainedHostConfig(link,next));
  await writeFile(file,'corrupt');await assert.rejects(persistRetainedHostConfig(file,next));
 }finally{await rm(dir,{recursive:true,force:true});}
});
