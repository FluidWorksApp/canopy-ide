import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {acquireResourceAdmission,hostResourceAdmission} from './resource-admission.mjs';import {DockerWorkspaces} from './docker.mjs';
// Real kernel flock with inherited fd3 on Linux and macOS; the production
// handshake invokes util-linux flock, and Python uses the same OS lock API.
const spawnImpl=(_cmd,args,options)=>spawn('python3',['-c',`import fcntl,os,sys,time
end=time.monotonic()+float(sys.argv[1])
while True:
 try: fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB);break
 except BlockingIOError:
  if time.monotonic()>=end:sys.exit(75)
  time.sleep(.01)
os.write(1,b'ADMITTED\\n')
sys.stdin.buffer.read()
`,args.at(-1)],options);
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'canopy-admission-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'lock');await writeFile(file,'',{mode:0o660});return{file,options:{spawnImpl,expectedOwnerUid:process.getuid(),timeoutMs:300}};}
test('independent repair drains an admitted start and holds queued starts until release',async t=>{const f=await fixture(t),gate=hostResourceAdmission(f.file,f.options);let finishStart;const started=new Promise(resolve=>finishStart=resolve);let entered;const enteredStart=new Promise(resolve=>entered=resolve);const host=new DockerWorkspaces({secret:'synthetic',resourceAdmission:gate});host.ensure=async w=>{entered();await started;return{id:w.id};};const opening=host.open({id:'owner'});await enteredStart;let acquired=false;const recovery=acquireResourceAdmission(f.file,f.options).then(release=>{acquired=true;return release;});await new Promise(r=>setTimeout(r,40));assert.equal(acquired,false);finishStart();await opening;const release=await recovery;let queued=false;host.ensure=async w=>{queued=true;return{id:w.id};};const member=host.open({id:'member',memberId:'synthetic',parentWorkspaceId:'owner'});await new Promise(r=>setTimeout(r,40));assert.equal(queued,false);await release();await member;assert.equal(queued,true);});
test('owner, member and collaboration starts queued behind repair reauthorize after release',async t=>{const f=await fixture(t),release=await acquireResourceAdmission(f.file,f.options);let allowed=true,started=0;const host=new DockerWorkspaces({secret:'synthetic',resourceAdmission:hostResourceAdmission(f.file,f.options),authorizeAdmission:async()=>allowed});host.ensure=async()=>{started++;return{};};const opens=['owner','member','collaboration'].map(id=>host.open({id}, {authorize:async()=>allowed}).then(()=>null,e=>e));allowed=false;await release();for(const error of await Promise.all(opens))assert.match(error.message,/admission changed/);assert.equal(started,0);});
test('lock timeout and unsafe file refuse admission; no path symlink or public file accepted',async t=>{const f=await fixture(t),release=await acquireResourceAdmission(f.file,f.options);await assert.rejects(acquireResourceAdmission(f.file,{...f.options,timeoutMs:30}),/busy/);await release();const link=f.file+'-link';await symlink(f.file,link);await assert.rejects(acquireResourceAdmission(link,f.options));await chmod(f.file,0o666);await assert.rejects(acquireResourceAdmission(f.file,f.options),/Unsafe/);await chmod(f.file,0o660);await writeFile(f.file,'not a lock');await assert.rejects(acquireResourceAdmission(f.file,f.options),/Unsafe/);});
