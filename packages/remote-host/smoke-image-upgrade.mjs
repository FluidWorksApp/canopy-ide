// Disposable Docker upgrade/recovery check; never uses existing workspaces.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {DockerWorkspaces,safeDockerError} from './docker.mjs';
import {imageUpgradeJournal,upgradeRuntimeImage,recoverImageUpgrade,readImageUpgrade} from './image-upgrade.mjs';
import {waitForRuntimeReady} from './runtime-readiness.mjs';
const run=promisify(execFile),id='upgrade-smoke-'+randomBytes(4).toString('hex');
const directory=await mkdtemp(path.join(tmpdir(),id+'-'));
const base=process.argv[2]??'canopy-workspace:0.1.0';
if(!/^[a-zA-Z0-9./:@_-]+$/.test(base))throw Error('Invalid smoke image');
const images=[id+':old',id+':new'];
const docker=async args=>{try{return await run('docker',args,{encoding:'utf8',timeout:180000,maxBuffer:1024*1024});}catch(error){throw safeDockerError(error,args[0]);}};
const workspace={id,accounts:[],memoryMiB:2048,cpus:0.5};
const host=new DockerWorkspaces({secret:randomBytes(32).toString('hex'),image:images[0],docker});
const name='canopy-ws-'+id,journal=imageUpgradeJournal(directory,id);
const inspect=async name=>JSON.parse((await docker(['inspect',name])).stdout)[0];
const ready=runtime=>waitForRuntimeReady(runtime);
try{
 for(const [i,image] of images.entries()){
  await writeFile(path.join(directory,'Dockerfile'),`FROM ${base}\nLABEL canopy.synthetic-release="${i}"\n`);
  await docker(['build','--tag',image,directory]);
 }
 const old=await host.open(workspace);assert.ok(await ready(old));
 await docker(['exec',name,'node','-e',"const f=require('fs');f.writeFileSync('/workspace/preserved-project.txt','PROJECT');f.writeFileSync('/home/agent/preserved-account.txt','HOME');f.writeFileSync('/tmp/preserved-writable-layer.txt','CUSTOM');"]);
 await docker(['stop','--timeout','30',name]);const original=await inspect(name);
 const release={reference:images[1]};
 const replacement=await upgradeRuntimeImage(workspace,original,release,{docker,journal,launch:image=>host.ensure(workspace,{releaseImage:image}),verify:ready});
 assert.ok(await ready(replacement));const current=await inspect(name);assert.notEqual(current.Id,original.Id);assert.notEqual(current.Image,original.Image);
 assert.deepEqual(current.Mounts.map(m=>[m.Name,m.Destination,m.RW]).sort(),original.Mounts.map(m=>[m.Name,m.Destination,m.RW]).sort());
 await docker(['exec',name,'node','-e',"const f=require('fs'),a=require('assert');a.equal(f.readFileSync('/workspace/preserved-project.txt','utf8'),'PROJECT');a.equal(f.readFileSync('/home/agent/preserved-account.txt','utf8'),'HOME');"]);
 const committed=await readImageUpgrade(directory,id);assert.equal(committed.phase,'committed');
 await docker(['start',committed.preservedContainer]);
 await docker(['exec',committed.preservedContainer,'node','-e',"require('assert').equal(require('fs').readFileSync('/tmp/preserved-writable-layer.txt','utf8'),'CUSTOM')"]);
 await docker(['stop','--timeout','30',committed.preservedContainer]);
 // Recreate the exact mid-replacement journal state, then use offline recovery.
 await journal({...committed,phase:'replacing'});
 const result=await recoverImageUpgrade(await readImageUpgrade(directory,id),{docker,journal});
 assert.equal(result.containerId,original.Id);assert.equal((await inspect(name)).State.Running,false);
 assert.equal((await readImageUpgrade(directory,id)).phase,'rolled-back');
 console.log('Docker image upgrade PASS: new image, identical persistent mounts, files preserved, old writable layer recoverable, interrupted replacement restored stopped.');
}finally{
 // Strict synthetic label filtering: do not remove any production resource.
 const {stdout}=await docker(['ps','--all','--filter','label=canopy.workspace='+id,'--format','{{.Names}}']);
 for(const candidate of stdout.trim().split('\n').filter(Boolean))await docker(['rm','--force',candidate]);
 for(const volume of ['canopy-home-'+id,'canopy-project-'+id])await docker(['volume','rm',volume]).catch(()=>{});
 await docker(['network','rm','canopy-net-'+id]).catch(()=>{});
 for(const image of images)await docker(['image','rm',image]).catch(()=>{});
 await rm(directory,{recursive:true,force:true});
}
