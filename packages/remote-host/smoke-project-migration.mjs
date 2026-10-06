import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {randomBytes} from 'node:crypto';
import {migrateProjectVolume} from './migrate-project-volume.mjs';import {projectMounts} from './project-mounts.mjs';
const exec=promisify(execFile),image=process.argv[2]??'canopy-workspace:validation';
const docker=args=>exec('docker',args,{timeout:30000,maxBuffer:65536});
const workspace={id:'migration-'+randomBytes(8).toString('hex')},project={id:'app',name:'Product',components:[{id:'app',label:'App',source:'repo',relativePath:'.'}]};
const source='canopy-project-'+workspace.id,destination=projectMounts({...workspace,projectMounts:[{id:'app',writable:true}]})[0][1];
try{
 await docker(['volume','create',source]);
 await docker(['run','--rm','--network','none','--user','0:0','--cap-drop','ALL','--cap-add','CHOWN','--mount',`type=volume,source=${source},target=/source`,image,'node','-e',"const fs=require('fs');fs.mkdirSync('/source/repo');fs.writeFileSync('/source/repo/data','original');fs.chownSync('/source',1000,1000);fs.chownSync('/source/repo',1000,1000);fs.chownSync('/source/repo/data',1000,1000);"]);
 const catalog=await migrateProjectVolume(workspace,project,{docker,image});
 if(catalog.components[0].relativePath!=='content')throw Error('Wrong migrated path');
 await docker(['run','--rm','--network','none','--user','1000:1000','--cap-drop','ALL','--mount',`type=volume,source=${source},target=/source,readonly`,'--mount',`type=volume,source=${destination},target=/destination,readonly`,image,'node','-e',"const fs=require('fs'),assert=require('assert/strict');assert.equal(fs.readFileSync('/source/repo/data','utf8'),'original');assert.equal(fs.readFileSync('/destination/content/data','utf8'),'original');assert.deepEqual(fs.readdirSync('/destination'),['content']);"]);
 console.log('PASS: real Docker migration publishes project content and preserves the read-only original.');
}finally{for(const volume of [destination,source])await docker(['volume','rm',volume]).catch(()=>{});}
