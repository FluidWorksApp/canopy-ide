import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {peerSmokeArguments,peerSmokeSources} from './peer-smoke-inputs.mjs';
const config={root:'/synthetic/source',image:'canopy-workspace:0.1.0',name:'canopy-peer-smoke-0123456789',network:'canopy-peer-smoke-0123456789-net'};
test('isolated peer proof mounts exactly source modules and preserves no internet/read-only/fresh-home boundaries',async()=>{
 const args=peerSmokeArguments(config),mounts=args.filter(value=>value.startsWith('type=bind,'));assert.equal(mounts.length,7);assert.equal(peerSmokeSources.length,5);assert.ok(mounts.every(value=>value.endsWith(',readonly')));assert.ok(mounts.every(value=>!value.includes('.env')&&!value.includes('.aws')&&!value.includes('docker.sock')));
 assert.equal(args[args.indexOf('--network')+1],config.network);assert.ok(args.includes('--read-only'));assert.equal(args[args.indexOf('--user')+1],'1000:1000');assert.equal(args[args.indexOf('--memory')+1],'1536m');assert.ok(args.includes('/home/agent:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700'));
 const orchestrator=await readFile(new URL('./smoke-peer-direct.mjs',import.meta.url),'utf8');assert.ok(orchestrator.includes("['network','create','--internal',network]"));
 const fixture=await readFile(new URL('./smoke-peer-direct-fixture.mjs',import.meta.url),'utf8');assert.ok(!fixture.includes('WebRtcHideLocalIpsWithMdns'));assert.ok(!fixture.includes('force-webrtc-ip-handling-policy'));assert.ok(!fixture.includes('ignoreHTTPSErrors'));assert.ok(fixture.includes('registrationProof(user,input)'));assert.ok(fixture.includes('relayEnvelope(input,user,sender,recipient)'));
});
test('unsafe network/image/root configuration cannot run or mount unrelated user directories',()=>{
 for(const change of [{root:'relative'},{root:'/synthetic,source'},{image:'--privileged'},{name:'user-container'},{network:'host'},{network:'bridge'}])assert.throws(()=>peerSmokeArguments({...config,...change}),/Invalid isolated peer/);
});
