// Disposable Docker hang-recovery check; never uses existing workspaces.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {DockerWorkspaces,safeDockerError} from './docker.mjs';
import {waitForRuntimeReady} from './runtime-readiness.mjs';
const run=promisify(execFile),id='recovery-smoke-'+randomBytes(4).toString('hex');
const image=process.argv[2]??'canopy-workspace:0.1.0';
if(!/^[a-zA-Z0-9./:@_-]+$/.test(image))throw Error('Invalid smoke image');
const docker=async args=>{try{return await run('docker',args,{encoding:'utf8',timeout:180000,maxBuffer:1024*1024});}catch(error){throw safeDockerError(error,args[0]);}};
const workspace={id,accounts:[],memoryMiB:2048,cpus:0.5};
const host=new DockerWorkspaces({secret:randomBytes(32).toString('hex'),image,docker});
const name='canopy-ws-'+id;
const inspect=async()=>JSON.parse((await docker(['inspect',name])).stdout)[0];
try{
 const runtime=await host.open(workspace);assert.ok(await waitForRuntimeReady(runtime));
 await docker(['exec',name,'node','-e',"const f=require('fs');f.writeFileSync('/workspace/preserved-project.txt','PROJECT');f.writeFileSync('/home/agent/preserved-home.txt','HOME');"]);
 const before=await inspect();let reserved=0;
 assert.equal(await host.recoverRuntime(workspace,before.Id,{authorize:async()=>true,reserve:async()=>reserved++}),true);
 const after=await inspect();
 assert.equal(after.Id,before.Id,'recovery must keep the same container');
 assert.equal(after.State.Running,true,'recovery must leave the container running');
 assert.notEqual(after.State.StartedAt,before.State.StartedAt,'recovery must restart the container');
 assert.equal(reserved,1);
 assert.ok(await waitForRuntimeReady(host.runtimes.get(id).runtime),'the workspace service must answer after recovery');
 const {stdout}=await docker(['exec',name,'cat','/workspace/preserved-project.txt','/home/agent/preserved-home.txt']);
 assert.equal(stdout,'PROJECTHOME');
 await docker(['stop','--time','5',name]);
 assert.equal(await host.recoverRuntime(workspace,before.Id,{authorize:async()=>true,reserve:async()=>assert.fail('A stopped workspace must not be recovered')}),false);
 assert.equal((await inspect()).State.Running,false,'an intentional stop must stay stopped');
 console.log('runtime recovery smoke: PASS');
}finally{
 // Strict synthetic label filtering: do not remove any production resource.
 const {stdout}=await docker(['ps','--all','--filter','label=canopy.workspace='+id,'--format','{{.Names}}']);
 for(const candidate of stdout.trim().split('\n').filter(Boolean))await docker(['rm','--force',candidate]);
 for(const volume of ['canopy-home-'+id,'canopy-project-'+id])await docker(['volume','rm',volume]).catch(()=>{});
 await docker(['network','rm','canopy-net-'+id]).catch(()=>{});
}
