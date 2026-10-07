import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,mkdir,copyFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
test('packaging binds actual lock and both Linux gates while excluding retained factory proof and node_modules',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'canopy-package-proof-'));
 try{
  const source=join(dir,'runtime');await mkdir(source);await copyFile(new URL('./package-host-release.sh',import.meta.url),join(source,'package-host-release.sh'));await copyFile(new URL('./runtime-package-integrity.mjs',import.meta.url),join(source,'runtime-package-integrity.mjs'));
  const pkg={name:'fixture-runtime',version:'1.0.0',dependencies:{example:'1.0.0'}},lock={name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':pkg}};
  await writeFile(join(source,'package.json'),JSON.stringify(pkg));await writeFile(join(source,'package-lock.json'),JSON.stringify(lock));
  for(const file of ['install.sh','network-isolation.sh','agents.lock.json','canopy-host.service','canopy-network.service','safe.mjs','excluded.test.mjs','factory.json'])await writeFile(join(source,file),'synthetic');
  await mkdir(join(source,'node_modules'));await writeFile(join(source,'node_modules','private-fixture'),'never package');
  await mkdir(join(source,'chrome-stream'));for(const file of ['server.mjs','playwright.mjs','protocol.mjs','viewer.html','viewer.js','preview_picker.js'])await writeFile(join(source,'chrome-stream',file),'synthetic');
  const manifest={runtimeLockSha256:createHash('sha256').update(await readFile(join(source,'package-lock.json'))).digest('hex'),checks:{linuxAmd64:true,linuxArm64:true}},release=join(dir,'release.json'),archive=join(dir,'runtime.tgz');
  const run=()=>spawnSync('bash',[join(source,'package-host-release.sh'),archive,release],{encoding:'utf8'});
  await writeFile(release,JSON.stringify(manifest));let result=run();assert.equal(result.status,0,result.stderr);const list=spawnSync('tar',['-tzf',archive],{encoding:'utf8'}).stdout;assert.match(list,/safe.mjs/);assert.doesNotMatch(list,/factory.json|node_modules|excluded.test.mjs/);
  for(const changed of [{...manifest,runtimeLockSha256:'f'.repeat(64)},{...manifest,checks:{linuxAmd64:true,linuxArm64:false}},{...manifest,checks:undefined}]){await writeFile(release,JSON.stringify(changed));assert.notEqual(run().status,0);}
  await writeFile(release,JSON.stringify(manifest));await writeFile(join(source,'package.json'),JSON.stringify({...pkg,dependencies:{example:'2.0.0'}}));assert.notEqual(run().status,0,'Package-only dependency changes must fail before an archive is emitted');
 }finally{await rm(dir,{recursive:true,force:true});}
});
