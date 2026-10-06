// Synthetic Docker volumes only. Verify kernel-enforced sharing, not UI labels.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {projectMounts} from './project-mounts.mjs';
import {prepareProjectVolumes} from './project-volumes.mjs';
const exec=promisify(execFile),image=process.argv[2]??'canopy-workspace:validation';
const docker=args=>exec('docker',args,{timeout:30000,maxBuffer:65536});
const workspace={id:'smoke-'+randomBytes(8).toString('hex'),projectMounts:[{id:'app',writable:true}]};
const [target,volume]=projectMounts(workspace)[0],prefix=workspace.id;
const names=[prefix+'-writer',prefix+'-reader'];
try{
 await prepareProjectVolumes(workspace,{docker,image});
 for(const [index,name] of names.entries())await docker(['run','-d','--name',name,'--network','none','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','256m','--memory-swap','448m','--pids-limit','128','--mount',`type=volume,source=${volume},target=${target}${index?',readonly':''}`,image,'node','-e','setInterval(()=>{},1000)']);
 await docker(['exec',names[0],'node','-e',`const fs=require('fs');fs.writeFileSync('${target}/shared.txt','shared source');fs.writeFileSync('/home/agent/private-token','synthetic private');`]);
 await docker(['exec',names[1],'node','-e',`const fs=require('fs'),assert=require('assert/strict');assert.equal(fs.readFileSync('${target}/shared.txt','utf8'),'shared source');assert.throws(()=>fs.writeFileSync('${target}/shared.txt','tampered'),{code:'EROFS'});assert.equal(fs.existsSync('/home/agent/private-token'),false);`]);
 console.log('PASS: shared source visible, reader writes rejected by Docker, writer private home absent.');
}finally{
 for(const name of names)await docker(['rm','-f',name]).catch(()=>{});
 await docker(['volume','rm',volume]).catch(()=>{});
}
