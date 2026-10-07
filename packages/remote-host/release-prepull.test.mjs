import test from 'node:test';import assert from 'node:assert/strict';
import {startReleasePrepull} from './release-prepull.mjs';
const digest='ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'a'.repeat(64);
const timers={setTimeout:()=>null,setInterval:()=>null,clearTimeout(){},clearInterval(){}};
const inspected=JSON.stringify([{Id:'sha256:'+'b'.repeat(64),RepoDigests:[digest]}]);
test('pulls the current release only when it is not already on disk',async()=>{
 const calls=[];let present=false;
 const docker=async args=>{calls.push(args.join(' '));if(args[0]==='image'){if(!present)throw Object.assign(Error('missing'),{missingResource:true});return {stdout:inspected};}present=true;return {stdout:''};};
 const prepull=startReleasePrepull({workspace:{id:'ws-1',generation:1},release:async()=>digest,docker,timers});
 assert.equal((await prepull.tick()).reference,digest);
 assert.deepEqual(calls,[`image inspect ${digest}`,`pull --quiet ${digest}`,`image inspect ${digest}`]);
 calls.length=0;await prepull.tick();
 assert.deepEqual(calls,[`image inspect ${digest}`]);
});
test('one pull at a time, failures are reported and never thrown',async()=>{
 let release;const results=[];
 const prepull=startReleasePrepull({workspace:{id:'ws-1',generation:1},release:()=>new Promise((_,reject)=>{release=reject;}),docker:async()=>({stdout:''}),timers,onResult:r=>results.push(r)});
 const first=prepull.tick(),second=prepull.tick();assert.equal(first,second);
 release(Error('Current workspace release is unavailable'));assert.equal(await first,null);
 assert.deepEqual(results,[{ok:false,error:'Current workspace release is unavailable'}]);
});
test('does nothing without a managed workspace or release authority, and stops cleanly',async()=>{
 assert.equal(await startReleasePrepull({workspace:null,release:async()=>digest,docker:async()=>({})}).tick(),null);
 assert.equal(await startReleasePrepull({workspace:{id:'ws-1'},release:undefined,docker:async()=>({})}).tick(),null);
 const prepull=startReleasePrepull({workspace:{id:'ws-1',generation:1},release:async()=>digest,docker:async()=>{throw Error('should not run');},timers});
 prepull.stop();assert.equal(await prepull.tick(),undefined);
});
