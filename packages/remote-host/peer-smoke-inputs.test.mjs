import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {peerSmokeArguments,peerSmokeSources,peerSmokeRelaySources,peerSmokeBridge,peerSmokeFirewallRules} from './peer-smoke-inputs.mjs';
const config={root:'/synthetic/source',image:'canopy-workspace:0.1.0',name:'canopy-peer-smoke-0123456789',network:'canopy-peer-smoke-0123456789-net',probes:{hostIp:'172.28.0.1',hostPort:23456,externalIp:'172.29.0.2',externalPort:32345}};
test('isolated peer proof mounts exactly source modules and preserves no internet/read-only/fresh-home boundaries',async()=>{
 const args=peerSmokeArguments(config),mounts=args.filter(value=>value.startsWith('type=bind,'));assert.equal(mounts.length,11);assert.equal(peerSmokeSources.length,7);assert.ok(mounts.every(value=>value.endsWith(',readonly')));assert.ok(mounts.every(value=>!value.includes('.env')&&!value.includes('.aws')&&!value.includes('docker.sock')));
 assert.equal(args[args.indexOf('--network')+1],config.network);assert.ok(args.includes('--read-only'));assert.equal(args[args.indexOf('--user')+1],'1000:1000');assert.equal(args[args.indexOf('--memory')+1],'1536m');assert.ok(args.includes('/home/agent:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700'));
 const orchestrator=await readFile(new URL('./smoke-peer-direct.mjs',import.meta.url),'utf8');assert.ok(orchestrator.includes("'--internal','--ipv6=false'"));assert.ok(orchestrator.includes("'iptables','-w','-C'"));assert.ok(!orchestrator.includes("'-F'"));assert.ok(orchestrator.includes("current.Config?.Labels?.['canopy.synthetic-peer-proof']===name"));assert.equal(peerSmokeBridge(config.name).length,13);assert.deepEqual(peerSmokeFirewallRules(config.name),[['DOCKER-USER','-i','cpv0123456789','!','-o','cpv0123456789','-j','DROP'],['INPUT','-i','cpv0123456789','-j','DROP']]);assert.ok(args.includes('net.ipv6.conf.all.disable_ipv6=1'));assert.equal(args[args.indexOf('--dns')+1],'127.0.0.1');
 const fixture=await readFile(new URL('./smoke-peer-direct-fixture.mjs',import.meta.url),'utf8');assert.ok(!fixture.includes('WebRtcHideLocalIpsWithMdns'));assert.ok(!fixture.includes('force-webrtc-ip-handling-policy'));assert.ok(!fixture.includes('ignoreHTTPSErrors'));assert.ok(fixture.includes('registrationProof(user,input)'));assert.ok(fixture.includes('relayEnvelope(input,user,sender,recipient)'));
});
test('unsafe network/image/root configuration cannot run or mount unrelated user directories',()=>{
 for(const change of [{root:'relative'},{root:'/synthetic,source'},{image:'--privileged'},{name:'user-container'},{network:'host'},{network:'bridge'},{probes:{...config.probes,externalIp:'example.com'}},{probes:{...config.probes,hostIp:'8.8.8.8'}},{probes:{...config.probes,hostPort:22}}])assert.throws(()=>peerSmokeArguments({...config,...change}),/Invalid .*peer/);
});

test('mounted browser and relay modules include every relative runtime import',async()=>{
 const mounted=new Set([...peerSmokeSources,...peerSmokeRelaySources]);
 const {posix:path}=await import('node:path');
 for(const file of mounted){
  const source=await readFile(new URL('../../'+file,import.meta.url),'utf8');
  // Type-only imports disappear when the browser fixture transpiles TypeScript.
  for(const match of source.matchAll(/(?:^|\n)import(?!\s+type\b)[^;\n]*?from\s*['"](\.[^'"]+)['"]/g)){
   const dependency=path.normalize(path.join(path.dirname(file),match[1]));
   const runtimeFile=path.extname(dependency)?dependency:dependency+'.ts';
   assert.ok(mounted.has(runtimeFile),`${file} needs unmounted runtime module ${runtimeFile}`);
  }
 }
});
