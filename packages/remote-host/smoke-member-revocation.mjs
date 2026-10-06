// Disposable real-engine check: no user volumes, credentials or source mounts.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {DockerWorkspaces} from './docker.mjs';
import {MemberLeases} from './member-leases.mjs';
const exec=promisify(execFile);
const docker=args=>exec('docker',args,{timeout:30000,maxBuffer:65536});
const image=process.argv[2]??'canopy-workspace:validation';
const members=Array.from({length:2},()=>({id:'member-'+randomBytes(20).toString('hex'),parentWorkspaceId:'synthetic'}));
const name=r=>'canopy-ws-'+r.id;
const host=new DockerWorkspaces({secret:'synthetic-smoke-only',docker});
let allowed=true;
const leases=new MemberLeases({intervalMs:50,authorize:async()=>{if(!allowed)throw Error('revoked');},stop:r=>host.suspendMember(r)});
const running=async r=>JSON.parse((await docker(['inspect',name(r)])).stdout)[0].State.Running;
try{
 for(const member of members)await docker(['run','-d','--name',name(member),'--label','canopy.workspace='+member.id,
  '--network','none','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true',
  '--memory','256m','--memory-swap','448m','--pids-limit','128','--restart','no',image,'node','-e','setInterval(()=>{},1000)']);
 await leases.open(members[0],{expiresAt:Date.now()+30000},'synthetic',async()=>{});
 allowed=false;
 const deadline=Date.now()+15000;
 while(await running(members[0])){if(Date.now()>deadline)throw Error('Revoked container stayed running');await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(await running(members[1]),true);
 console.log('PASS: background authorization revoked and stopped one real member container; the other remains running.');
 // Simulate host recovery on our exact test container, without enumerating or
 // modifying any existing user containers.
 await host.suspendMember(members[1]);assert.equal(await running(members[1]),false);
 console.log('PASS: verified stop preserves the stopped container for later resume.');
}finally{
 leases.close();await leases.checking;
 for(const member of members)await docker(['rm','-f',name(member)]).catch(()=>{});
}
