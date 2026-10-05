// Fresh test-only browser contexts and a disposable internal Docker network.
import {peerSmokeArguments} from './peer-smoke-inputs.mjs';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import path from 'node:path';import {randomBytes} from 'node:crypto';
const exec=promisify(execFile),image=process.env.CANOPY_WORKSPACE_IMAGE;if(!image||!/^[a-zA-Z0-9][\w./:@-]*$/.test(image))throw Error('CANOPY_WORKSPACE_IMAGE is required');
const name='canopy-peer-smoke-'+randomBytes(5).toString('hex'),network=name+'-net',root=path.resolve(import.meta.dirname,'../..');
try{
 await exec('docker',['network','create','--internal',network],{timeout:10000});
 const result=await exec('docker',peerSmokeArguments({root,image,name,network}),{timeout:90000,maxBuffer:131072});process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
}finally{await exec('docker',['rm','--force',name],{timeout:10000}).catch(()=>{});await exec('docker',['network','rm',network],{timeout:10000}).catch(()=>{});}
