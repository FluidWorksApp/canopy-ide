import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {randomBytes} from 'node:crypto';import {checkpointOwner} from './owner-checkpoint.mjs';
const exec=promisify(execFile),base=process.argv[2]??'canopy-workspace:validation';
const docker=args=>exec('docker',args,{timeout:60000,maxBuffer:65536});
const workspace={id:'checkpoint-'+randomBytes(8).toString('hex')},name='canopy-ws-'+workspace.id;
let image;
try{
 await docker(['run','--name',name,'--label','canopy.workspace='+workspace.id,'--network','none','--user','1000:1000','--cap-drop','ALL','--entrypoint','node',base,'-e',"require('fs').writeFileSync('/tmp/owner-checkpoint-proof','preserved');"]);
 const checkpoint=await checkpointOwner(workspace,{docker});image=checkpoint.ownerImage;
 await docker(['run','--rm','--network','none','--user','1000:1000','--cap-drop','ALL','--entrypoint','node',image,'-e',"require('assert/strict').equal(require('fs').readFileSync('/tmp/owner-checkpoint-proof','utf8'),'preserved');"]);
 await docker(['run','--rm','--network','none','--user','1000:1000','--cap-drop','ALL','--entrypoint','node',base,'-e',"require('assert/strict').equal(require('fs').existsSync('/tmp/owner-checkpoint-proof'),false);"]);
 const original=JSON.parse((await docker(['inspect',name])).stdout)[0];if(original.Id!==checkpoint.originalContainerId)throw Error('Original changed');
 console.log('PASS: owner writable-layer data preserved, clean member image unchanged, original container retained.');
}finally{await docker(['rm','-f',name]).catch(()=>{});if(image)await docker(['image','rm',image]).catch(()=>{});}
