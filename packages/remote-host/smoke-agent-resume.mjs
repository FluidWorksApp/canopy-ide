// Disposable Docker agent-resume check; never uses existing workspaces.
// A stand-in `claude` records how it was launched, so the check reads exactly
// what a hang recovery restarts: the command, its directory and its flags. It
// stays alive as a script (no exec) so its own argv is what the host observes.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DockerWorkspaces,safeDockerError} from './docker.mjs';
import {waitForRuntimeReady} from './runtime-readiness.mjs';
import {SessionResume} from './session-resume.mjs';
const run=promisify(execFile),id='resume-smoke-'+randomBytes(4).toString('hex');
const image=process.argv[2]??'canopy-workspace:0.1.0';
if(!/^[a-zA-Z0-9./:@_-]+$/.test(image))throw Error('Invalid smoke image');
const docker=async args=>{try{return await run('docker',args,{encoding:'utf8',timeout:180000,maxBuffer:1024*1024});}catch(error){throw safeDockerError(error,args[0]);}};
const workspace={id,accounts:[],memoryMiB:2048,cpus:0.5};
const host=new DockerWorkspaces({secret:randomBytes(32).toString('hex'),image,docker});
const name='canopy-ws-'+id,conversation=randomUUID();
const inspect=async()=>JSON.parse((await docker(['inspect',name])).stdout)[0];
const asAgent=(...args)=>docker(['exec','-u','1000:1000',name,...args]);
// The runner serves /native on its published port too; the container address
// behind nativeUrl is not reachable from a macOS Docker host.
const view={get runtimes(){return new Map([...host.runtimes].map(([key,entry])=>[key,{...entry,runtime:{...entry.runtime,nativeUrl:undefined}}]));},inspectRuntime:w=>host.inspectRuntime(w),docker};
const call=async(path,body)=>{const {runtime}=view.runtimes.get(id);const response=await fetch(runtime.url+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${runtime.token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Error(value.error);return value;};
const launch=async pty=>{for(let i=0;i<100;i++){try{return (await asAgent('cat',`/home/agent/claude-launch-${pty}.txt`)).stdout.split('\n');}catch{await new Promise(resolve=>setTimeout(resolve,200));}}throw Error(`claude never started in terminal ${pty}`);};
const state=await mkdtemp(join(tmpdir(),'agent-resume-smoke-'));
try{
 assert.ok(await waitForRuntimeReady(await host.open(workspace)));
 await asAgent('sh','-c',`mkdir -p /home/agent/.local/bin /workspace/app && printf '%s\\n' '#!/bin/sh' 'printf "%s\\n" "$PWD" "$*" > /home/agent/claude-launch-$CANOPY_PTY.txt' 'sleep 3600' > /home/agent/.local/bin/claude && chmod +x /home/agent/.local/bin/claude`);
 const first=await call('/sessions',{requestId:'smoke-desktop-1',command:"cd '/workspace/app' && claude --permission-mode auto --dangerously-skip-permissions 'first prompt'"});
 const shell=await call('/sessions',{requestId:'smoke-desktop-2',command:'exec sleep 3600'});
 assert.deepEqual(await launch(first.id),['/workspace/app','--permission-mode auto --dangerously-skip-permissions first prompt','']);
 await call('/native',{command:'pty_metadata_set',args:{id:first.id,value:{cwd:'/workspace/app',projectId:'p1',title:'Smoke agent',command:'/bin/bash',requestId:'smoke-desktop-1'}}});
 const event=JSON.stringify({agent:'claude',canopy_pty:first.id,session_id:conversation,cwd:'/workspace/app',hook_event_name:'UserPromptSubmit',permission_mode:'auto',transcript_path:`/home/agent/.claude/projects/-workspace-app/${conversation}.jsonl`});
 await asAgent('sh','-c',`mkdir -p /home/agent/.canopy && printf '%s\\n' '${event}' >> /home/agent/.canopy/agent-events.jsonl`);
 const resume=new SessionResume({directory:state,host:view,config:{workspaces:[workspace]},log:message=>console.log(message)});
 assert.equal(await resume.observe(workspace,view.runtimes.get(id).runtime),'watching');

 const before=await inspect();
 assert.equal(await host.recoverRuntime(workspace,before.Id,{authorize:async()=>true,reserve:async()=>{}}),true);
 assert.ok(await waitForRuntimeReady(host.runtimes.get(id).runtime));
 const after=await inspect();
 assert.equal(after.Id,before.Id);assert.notEqual(after.State.StartedAt,before.State.StartedAt);

 assert.equal(await resume.observe(workspace,view.runtimes.get(id).runtime),'resumed');
 const sessions=await call('/sessions');
 const resumed=sessions.find(s=>s.exitCode==null&&s.id>shell.id);
 assert.ok(resumed,'a new terminal runs the resumed agent');
 assert.equal(sessions.filter(s=>s.exitCode==null).length,1,'only the agent comes back; the plain command is not re-run');
 assert.deepEqual(await launch(resumed.id),['/workspace/app',`--resume ${conversation} --permission-mode auto --dangerously-skip-permissions`,''],'same directory and flags, conversation reopened, prompt not replayed');
 const metadata=(await call('/native',{command:'pty_metadata_get',args:{}})).result;
 assert.equal(metadata[resumed.id].resumedFrom,first.id);
 assert.equal(metadata[first.id].resumedAs,resumed.id);
 assert.equal(metadata[shell.id].interrupted.reason,'no-agent');
 assert.equal(await resume.observe(workspace,view.runtimes.get(id).runtime),'watching');
 assert.equal((await call('/sessions')).filter(s=>s.exitCode==null).length,1,'resumed exactly once');

 // An intentional stop, then the owner resuming the workspace: the agent that
 // was running when it was closed comes back too.
 const second=JSON.stringify({agent:'claude',canopy_pty:resumed.id,session_id:conversation,cwd:'/workspace/app',hook_event_name:'SessionStart',source:'resume',transcript_path:`/home/agent/.claude/projects/-workspace-app/${conversation}.jsonl`});
 await asAgent('sh','-c',`printf '%s\\n' '${second}' >> /home/agent/.canopy/agent-events.jsonl`);
 assert.equal(await resume.observe(workspace,view.runtimes.get(id).runtime),'watching');
 await docker(['stop','--time','5',name]);
 assert.ok(await waitForRuntimeReady(await host.open(workspace,{resume:true})));
 assert.equal(await resume.observe(workspace,view.runtimes.get(id).runtime),'resumed');
 const reopened=(await call('/sessions')).filter(s=>s.exitCode==null);
 assert.equal(reopened.length,1);
 assert.deepEqual(await launch(reopened[0].id),['/workspace/app',`--resume ${conversation} --permission-mode auto --dangerously-skip-permissions`,''],'after a stop and resume');
 console.log('agent resume smoke: PASS');
}finally{
 await rm(state,{recursive:true,force:true});
 // Strict synthetic label filtering: do not remove any production resource.
 const {stdout}=await docker(['ps','--all','--filter','label=canopy.workspace='+id,'--format','{{.Names}}']);
 for(const candidate of stdout.trim().split('\n').filter(Boolean))await docker(['rm','--force',candidate]);
 for(const volume of ['canopy-home-'+id,'canopy-project-'+id])await docker(['volume','rm',volume]).catch(()=>{});
 await docker(['network','rm','canopy-net-'+id]).catch(()=>{});
}
