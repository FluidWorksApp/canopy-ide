import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';
import {updateHostInPlace,validHostUpdate} from './host-update.mjs';
const run=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const OLD='a'.repeat(40),NEW='b'.repeat(40),LOCK='{"lockfileVersion":3}';
async function fixture({lock=LOCK,revision=NEW}={}){
 const dir=await mkdtemp(join(tmpdir(),'canopy-host-update-')),root=join(dir,'canopy-host'),units=join(dir,'units'),build=join(dir,'build');
 await mkdir(join(root,'node_modules','dep'),{recursive:true});await mkdir(units);await mkdir(build);
 await writeFile(join(root,'node_modules','dep','index.js'),'dependency');
 for(const [name,value] of [['gateway.mjs','old gateway'],['package-lock.json',LOCK],['workspace-release.json',JSON.stringify({revision:OLD})],['canopy-host.service','old unit']])await writeFile(join(root,name),value);
 for(const [name,value] of [['gateway.mjs','new gateway'],['package-lock.json',lock],['workspace-release.json',JSON.stringify({revision})],['canopy-host.service','new unit'],['canopy-network.service','network unit'],['network-isolation.sh','#!/bin/sh']])await writeFile(join(build,name),value);
 await run('tar',['-C',build,'-czf',join(dir,'host.tgz'),'.']);
 const archive=await readFile(join(dir,'host.tgz')),calls=[];
 const exec=async(command,args,options)=>{calls.push([command,...args]);if(command==='tar')return run(command,args,options);if(command==='id')return {stdout:'990\n'};return {stdout:''};};
 const payload={url:'https://bucket.s3.ap-southeast-1.amazonaws.com/releases/x/workspace-host.tar.gz?X-Amz-Signature=1',runtimeSha256:sha(archive),runtimeLockSha256:sha(LOCK),revision:NEW};
 const options=ready=>({root,units,exec,ready,fetchImpl:async()=>new Response(archive),readyMs:30,pollMs:1});
 return {dir,root,units,calls,archive,payload,options,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
const text=file=>readFile(file,'utf8');
const exists=async file=>{try{await stat(file);return true;}catch{return false;}};
test('update swaps the tree by rename, keeps the previous one, carries node_modules and restarts the host',async()=>{
 const f=await fixture();
 try{
  const result=await updateHostInPlace(f.payload,f.options(async()=>f.calls.some(c=>c.join(' ')==='systemctl restart canopy-host')));
  assert.deepEqual(result,{code:'updated',revision:NEW});
  assert.equal(await text(join(f.root,'gateway.mjs')),'new gateway');assert.equal(await text(join(f.root+'.prev','gateway.mjs')),'old gateway');
  assert.equal(await text(join(f.root,'node_modules','dep','index.js')),'dependency','dependencies move with the code');
  assert.equal((await text(join(f.root,'workspace-runtime.sha256'))).trim(),f.payload.runtimeSha256,'the installed archive hash is recorded for the gateway to report');
  assert.equal((await stat(join(f.root,'network-isolation.sh'))).mode&0o777,0o755);
  assert.equal(await text(join(f.units,'canopy-host.service')),'new unit');assert.equal(await text(join(f.units,'canopy-network.service')),'network unit');
  assert.ok(f.calls.some(c=>c.join(' ')===`chown -R 990:990 ${f.root}.next`),'the new tree belongs to the management service before it is swapped in');
  const order=f.calls.map(c=>c.join(' '));assert.ok(order.indexOf('systemctl daemon-reload')<order.indexOf('systemctl restart canopy-host'));
  assert.equal(await exists(f.root+'.next'),false);assert.equal(await exists(f.root+'.download.tgz'),false);
  f.calls.length=0;
  assert.deepEqual(await updateHostInPlace(f.payload,f.options(async()=>true)),{code:'current',revision:NEW},'an installed release is not reinstalled');
  assert.equal(f.calls.length,0);
 }finally{await f.cleanup();}
});
test('a hash mismatch, malformed request or different release changes nothing',async()=>{
 const f=await fixture();
 try{
  const ready=async()=>true;
  assert.equal((await updateHostInPlace({...f.payload,runtimeSha256:'0'.repeat(64)},f.options(ready))).code,'invalid');
  for(const bad of [{...f.payload,url:'http://bucket/x'},{...f.payload,revision:'main'},{...f.payload,runtimeLockSha256:undefined},null]){assert.equal(validHostUpdate(bad),false);assert.equal((await updateHostInPlace(bad,f.options(ready))).code,'invalid');}
  assert.equal((await updateHostInPlace(f.payload,{...f.options(ready),fetchImpl:async()=>new Response('gone',{status:403})})).code,'invalid');
  assert.equal((await updateHostInPlace({...f.payload,revision:'c'.repeat(40)},f.options(ready))).code,'invalid','the archive must be the release that was requested');
  assert.equal(await text(join(f.root,'gateway.mjs')),'old gateway');assert.equal(await exists(f.root+'.next'),false);assert.equal(await exists(f.root+'.prev'),false);
  assert.ok(!f.calls.some(c=>c[0]==='systemctl'));
  await assert.rejects(updateHostInPlace(f.payload,{...f.options(ready),ready:undefined}),/readiness/);
 }finally{await f.cleanup();}
});
test('a dependency lock change is refused: that release needs a full refresh',async()=>{
 const f=await fixture({lock:'{"lockfileVersion":3,"changed":true}'});
 try{
  const result=await updateHostInPlace(f.payload,f.options(async()=>true));
  assert.equal(result.code,'refresh-required');
  assert.equal(await text(join(f.root,'gateway.mjs')),'old gateway');assert.equal(await exists(f.root+'.next'),false);assert.ok(!f.calls.some(c=>c[0]==='systemctl'));
  assert.equal((await updateHostInPlace({...f.payload,runtimeLockSha256:'e'.repeat(64)},f.options(async()=>true))).code,'refresh-required','the release lock must also be the installed one');
 }finally{await f.cleanup();}
});
test('a host that does not become ready is rolled back to the previous tree and restarted',async()=>{
 const f=await fixture();
 try{
  let restarts=0;const exec=f.options().exec;
  const options={...f.options(async()=>restarts>=2),exec:async(command,args,o)=>{if(command==='systemctl'&&args[0]==='restart')restarts++;return exec(command,args,o);}};
  const result=await updateHostInPlace(f.payload,options);
  assert.equal(result.code,'rolled-back');assert.equal(restarts,2);
  assert.equal(await text(join(f.root,'gateway.mjs')),'old gateway');assert.equal(await text(join(f.root,'node_modules','dep','index.js')),'dependency');
  assert.equal(await text(join(f.units,'canopy-host.service')),'old unit','the previous units are restored too');
  assert.equal(await exists(f.root+'.next'),false);
  const never=await fixture();
  try{assert.equal((await updateHostInPlace(never.payload,never.options(async()=>false))).code,'failed');assert.equal(await text(join(never.root,'gateway.mjs')),'old gateway');}
  finally{await never.cleanup();}
 }finally{await f.cleanup();}
});
