import test from 'node:test';import assert from 'node:assert/strict';
import {workspaceImageReference,pullWorkspaceImage} from './image-release.mjs';
const repository='ghcr.io/fluidworksapp/canopy-workspace',digest=repository+'@sha256:'+'a'.repeat(64);
test('image selector rejects implicit latest, shell syntax and unqualified images',()=>{
 for(const ref of ['','canopy-workspace:latest',repository,repository+':stable;echo nope','https://'+repository+':stable',repository+'@sha256:abc','--help'])assert.throws(()=>workspaceImageReference(ref));
 assert.equal(workspaceImageReference(repository+':stable'),repository+':stable');assert.equal(workspaceImageReference(digest),digest);
});
test('pull resolves a channel to an immutable registry digest',async()=>{
 const calls=[];const release=await pullWorkspaceImage(repository+':stable',{docker:async args=>{calls.push(args);return {stdout:args[0]==='image'?JSON.stringify([{Id:'sha256:'+'b'.repeat(64),RepoDigests:[digest]}]):''};}});
 assert.deepEqual(calls,[['pull','--quiet',repository+':stable'],['image','inspect',repository+':stable']]);assert.equal(release.reference,digest);
});
test('failed pulls and mismatched registry digests fail closed',async()=>{
 await assert.rejects(pullWorkspaceImage(digest,{docker:async()=>{throw Error('registry unavailable');}}),/registry unavailable/);
 await assert.rejects(pullWorkspaceImage(digest,{docker:async args=>({stdout:args[0]==='image'?JSON.stringify([{Id:'sha256:'+'b'.repeat(64),RepoDigests:[repository+'@sha256:'+'c'.repeat(64)]}]):''})}),/digest could not be verified/);
});
test('cached immutable digest verifies identity without contacting the registry',async()=>{
 const calls=[];const release=await pullWorkspaceImage(digest,{docker:async args=>{calls.push(args);return {stdout:JSON.stringify([{Id:'sha256:'+'b'.repeat(64),RepoDigests:[repository+'@sha256:'+'c'.repeat(64),digest]}])};}});
 assert.deepEqual(calls,[['image','inspect',digest]]);assert.deepEqual(release,{reference:digest,imageId:'sha256:'+'b'.repeat(64)});
});
test('a missing immutable image is pulled and independently verified',async()=>{
 const calls=[];const release=await pullWorkspaceImage(digest,{docker:async args=>{calls.push(args);if(calls.length===1)throw Object.assign(Error('missing'),{missingResource:true});return {stdout:args[0]==='image'?JSON.stringify([{Id:'sha256:'+'b'.repeat(64),RepoDigests:[digest]}]):''};}});
 assert.deepEqual(calls,[['image','inspect',digest],['pull','--quiet',digest],['image','inspect',digest]]);assert.equal(release.reference,digest);
});
test('CLI missing-image stderr allows the pull but unexpected daemon errors do not',async()=>{
 let calls=0;await pullWorkspaceImage(digest,{docker:async args=>{calls++;if(calls===1)throw Object.assign(Error('Docker exit 1'),{stderr:'Error response from daemon: No such image: '+digest+'\n'});return{stdout:args[0]==='image'?JSON.stringify([{Id:'sha256:'+'b'.repeat(64),RepoDigests:[digest]}]):''};}});assert.equal(calls,3);
 for(const error of [Error('registry unavailable'),Object.assign(Error('Docker failed'),{stderr:'Cannot connect to the Docker daemon'}),Object.assign(Error('Docker failed'),{stderr:'permission denied while inspecting image'})]){
  let count=0;await assert.rejects(pullWorkspaceImage(digest,{docker:async()=>{count++;throw error;}}),e=>e===error);assert.equal(count,1);
 }
});
test('malformed cache identity fails closed without a pull',async()=>{
 for(const cached of [{},[],[{Id:'not-an-image',RepoDigests:[digest]}],[{Id:'sha256:'+'b'.repeat(64),RepoDigests:[repository+'@sha256:'+'c'.repeat(64)]}]]){
  const calls=[];await assert.rejects(pullWorkspaceImage(digest,{docker:async args=>{calls.push(args);return{stdout:JSON.stringify(cached)};}}),/could not be verified/);assert.deepEqual(calls,[['image','inspect',digest]]);
 }
});
test('an absent inspection response is not treated as a cache miss',async()=>{
 const calls=[];await assert.rejects(pullWorkspaceImage(digest,{docker:async args=>{calls.push(args);}}));assert.deepEqual(calls,[['image','inspect',digest]]);
});
test('registry failure after a confirmed cache miss remains a failure',async()=>{
 const calls=[];await assert.rejects(pullWorkspaceImage(digest,{docker:async args=>{calls.push(args);if(args[0]==='image')throw Object.assign(Error('missing'),{missingResource:true});throw Error('registry unavailable');}}),/registry unavailable/);assert.deepEqual(calls,[['image','inspect',digest],['pull','--quiet',digest]]);
});

test('image pulls get the startup phase budget and quiet output',async()=>{
 const {WORKSPACE_IMAGE_PULL_TIMEOUT_MS,dockerTimeout}=await import('./image-release.mjs');
 assert.equal(dockerTimeout(['pull','--quiet','x']),WORKSPACE_IMAGE_PULL_TIMEOUT_MS);assert.equal(dockerTimeout(['image','inspect','x']),120_000);
 // Inside the control plane's 15-minute phase budget, well above a 13 GB first pull's typical time.
 assert.ok(WORKSPACE_IMAGE_PULL_TIMEOUT_MS>=10*60*1000&&WORKSPACE_IMAGE_PULL_TIMEOUT_MS<15*60*1000);
});
