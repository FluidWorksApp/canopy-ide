import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
import {safeDockerError} from './docker.mjs';import {rollbackMigration} from './migration-recovery.mjs';import {createMigrationJournal} from './migration-journal.mjs';
const exec=promisify(execFile);const image=process.argv[2]??'canopy-workspace:integration-validation';
const id='recovery-'+randomBytes(6).toString('hex'),name='canopy-ws-'+id,preserved='canopy-preserved-'+id+'-original';
const directory=await mkdtemp(join(tmpdir(),'canopy-recovery-smoke-'));let originalId,replacementId,journal;
const docker=async args=>{try{return await exec('docker',args,{timeout:60000,maxBuffer:65536});}catch(error){throw safeDockerError(error,args[0]);}};
try{
 await docker(['run','--name',preserved,'--label','canopy.workspace='+id,'--network','none','--user','1000:1000','--cap-drop','ALL','--memory','128m','--entrypoint','node',image,'-e',"require('fs').writeFileSync('/tmp/recovery-proof','original file')"]);
 originalId=JSON.parse((await docker(['inspect',preserved])).stdout)[0].Id;
 replacementId=(await docker(['run','-d','--name',name,'--label','canopy.workspace='+id,'--network','none','--user','1000:1000','--cap-drop','ALL','--memory','128m','--entrypoint','node',image,'-e','setInterval(()=>{},1000)'])).stdout.trim();
 const originalWorkspace={id};const records=[{workspaceId:id,sequence:1,phase:'prepared',originalWorkspace,originalContainerId:originalId,preservedContainer:preserved,restorePolicy:'no',next:{id,ownerImage:'checkpoint',projectMounts:[{id:'app'}]}}];
 journal=await createMigrationJournal(directory,id);
 const host={docker,runtimes:new Map(),migrationCleanupRequired:new Set(),withResourceLock:fn=>fn()};
 const result=await rollbackMigration({records,readConfig:async()=>({workspaces:[originalWorkspace]}),host,journal});
 assert.equal(result.state,'original-restored');
 const original=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(original.Id,originalId);assert.equal(original.State.Running,false);
 const failed=JSON.parse((await docker(['inspect',preserved+'-failed'])).stdout)[0];assert.equal(failed.Id,replacementId);assert.equal(failed.State.Running,false);
 await docker(['cp',originalId+':/tmp/recovery-proof',join(directory,'proof')]);assert.equal(await readFile(join(directory,'proof'),'utf8'),'original file');
 console.log('PASS: actual Docker rollback preserved original files and both container identities, left both stopped.');
}finally{
 if(journal)await journal.close();
 for(const container of [replacementId,originalId].filter(Boolean))await docker(['rm','-f',container]).catch(()=>{});
 await rm(directory,{recursive:true,force:true});
}
