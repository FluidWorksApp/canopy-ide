import test from 'node:test';import assert from 'node:assert/strict';
import {workspaceImageReference,pullWorkspaceImage} from './image-release.mjs';
const repository='ghcr.io/fluidworksapp/canopy-workspace',digest=repository+'@sha256:'+'a'.repeat(64);
test('image selector rejects implicit latest, shell syntax and unqualified images',()=>{
 for(const ref of ['','canopy-workspace:latest',repository,repository+':stable;echo nope','https://'+repository+':stable',repository+'@sha256:abc','--help'])assert.throws(()=>workspaceImageReference(ref));
 assert.equal(workspaceImageReference(repository+':stable'),repository+':stable');assert.equal(workspaceImageReference(digest),digest);
});
test('pull resolves a channel to an immutable registry digest',async()=>{
 const calls=[];const release=await pullWorkspaceImage(repository+':stable',{docker:async args=>{calls.push(args);return {stdout:args[0]==='image'?JSON.stringify([{Id:'sha256:'+'b'.repeat(64),RepoDigests:[digest]}]):''};}});
 assert.deepEqual(calls,[['pull',repository+':stable'],['image','inspect',repository+':stable']]);assert.equal(release.reference,digest);
});
test('failed pulls and mismatched registry digests fail closed',async()=>{
 await assert.rejects(pullWorkspaceImage(digest,{docker:async()=>{throw Error('registry unavailable');}}),/registry unavailable/);
 await assert.rejects(pullWorkspaceImage(digest,{docker:async args=>({stdout:args[0]==='image'?JSON.stringify([{Id:'sha256:'+'b'.repeat(64),RepoDigests:[repository+'@sha256:'+'c'.repeat(64)]}]):''})}),/digest could not be verified/);
});
