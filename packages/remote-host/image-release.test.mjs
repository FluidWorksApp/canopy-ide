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

test('a pull that loses containerd mid-write is retried once, only after the runtimes are active again',async()=>{
 const {containerdConnectionLost}=await import('./image-release.mjs');
 const digest='ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'5e'.repeat(32);
 const eof=Object.assign(Error('Command failed: docker pull'),{stderr:'failed to copy: failed to send write: EOF'});
 assert.equal(containerdConnectionLost(eof),true);
 for(const other of [Error('registry unavailable'),{stderr:'no space left on device'},{stderr:'manifest unknown'}])assert.equal(containerdConnectionLost(other),false);
 const inspect={stdout:JSON.stringify([{Id:'sha256:'+'c'.repeat(64),RepoDigests:[digest]}])};
 const script=pulls=>{const calls=[];let failures=pulls;return {calls,docker:async args=>{calls.push(args.join(' '));if(args[0]==='image'&&calls.filter(c=>c.startsWith('pull')).length===0)throw Object.assign(Error('missing'),{stderr:'Error: No such image: '+digest});if(args[0]==='pull'&&failures-->0)throw eof;return args[0]==='image'?inspect:{stdout:''};}};};
 // Restart observed, runtimes active again: one retry succeeds.
 let ready=0;const once=script(1),logged=[];
 assert.equal((await pullWorkspaceImage(digest,{docker:once.docker,retry:{runtimeReady:async()=>{ready++;return true;},log:m=>logged.push(m)}})).reference,digest);
 assert.equal(once.calls.filter(c=>c.startsWith('pull')).length,2);assert.equal(ready,1);assert.equal(logged.length,1);
 // Never more than one retry.
 const twice=script(2);
 await assert.rejects(pullWorkspaceImage(digest,{docker:twice.docker,retry:{runtimeReady:async()=>true}}),/docker pull/);
 assert.equal(twice.calls.filter(c=>c.startsWith('pull')).length,2);
 // containerd not back: the original failure, no blind retry.
 const down=script(1);
 await assert.rejects(pullWorkspaceImage(digest,{docker:down.docker,retry:{runtimeReady:async()=>false}}),/docker pull/);
 assert.equal(down.calls.filter(c=>c.startsWith('pull')).length,1);
 // Other failures and callers without `retry` (the gateway) are unchanged.
 const plain=script(1);
 await assert.rejects(pullWorkspaceImage(digest,{docker:plain.docker}),/docker pull/);
 assert.equal(plain.calls.filter(c=>c.startsWith('pull')).length,1);
});

test('the bootstrap CLI checks containerd and Docker before its retry',async()=>{
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(new URL('./image-release.mjs',import.meta.url),'utf8');
 assert.match(source,/active\('containerd\.service'\)&&await active\('docker\.service'\)/);
 assert.match(source,/retry:\{runtimeReady,log\}/);
});
