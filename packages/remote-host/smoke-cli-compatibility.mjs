// Real installed CLIs, disposable synthetic HOME, no network or provider calls.
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import path from 'node:path';import {randomBytes} from 'node:crypto';
const exec=promisify(execFile),image=process.env.CANOPY_WORKSPACE_IMAGE;
if(!image||!/^[a-zA-Z0-9][\w./:@-]*$/.test(image))throw Error('CANOPY_WORKSPACE_IMAGE is required');
const name='canopy-cli-smoke-'+randomBytes(5).toString('hex');
const files=['smoke-cli-compatibility-fixture.mjs','agent-cli-proxy.mjs','credential-broker.mjs','provider-quota-headers.mjs','cli-smoke-process.mjs'];
try{
 const result=await exec('docker',['run','--rm','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','256','--memory','768m','--cpus','1','--user','1000:1000','--tmpfs','/tmp:rw,nosuid,nodev,size=256m,mode=1777','--tmpfs','/home/agent:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700',...files.flatMap(file=>['--mount','type=bind,source='+path.join(import.meta.dirname,file)+',target=/smoke/'+file+',readonly']),image,'node','/smoke/smoke-cli-compatibility-fixture.mjs'],{timeout:120000,maxBuffer:262144});
 process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
}finally{await exec('docker',['rm','--force',name],{timeout:10000}).catch(()=>{});}
