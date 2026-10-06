import {randomBytes} from 'node:crypto';
import {mkdir,open,rename,readdir,constants} from 'node:fs/promises';
import path from 'node:path';
import {validId} from './policy.mjs';
// Host-owned write-ahead records. An interrupted replacement is quarantined,
// never mistaken for a successful release or automatically resumed.
export function imageUpgradeJournal(directory,workspaceId){
 if(!directory||!validId(workspaceId))throw Error('Image upgrade requires trusted durable storage');
 return async record=>{
  await mkdir(directory,{recursive:true,mode:0o700});
  const target=path.join(directory,workspaceId+'.json'),temporary=target+'.'+randomBytes(8).toString('hex');
  const file=await open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify({version:1,workspaceId,...record}));await file.sync();}finally{await file.close();}
  await rename(temporary,target);const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
 };
}
export async function quarantineImageUpgrades(directory,host){
 let files;try{files=await readdir(directory);}catch(e){if(e.code==='ENOENT')return;throw e;}
 for(const filename of files.filter(f=>f.endsWith('.json'))){
  const id=filename.slice(0,-5);if(!validId(id))throw Error('Invalid image upgrade journal');
  const file=await open(path.join(directory,filename),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=await file.stat();if(!info.isFile()||info.size>16384)throw Error('Invalid image upgrade record');const record=JSON.parse(await file.readFile('utf8'));if(record.version!==1||record.workspaceId!==id)throw Error('Invalid image upgrade record');if(!['committed','rolled-back'].includes(record.phase))host.migrationCleanupRequired.add(id);}finally{await file.close();}
 }
}
export async function upgradeRuntimeImage(workspace,current,release,{docker,journal,launch,verify}){
 const name='canopy-ws-'+workspace.id;
 if(!validId(workspace.id)||current.Config?.Labels?.['canopy.workspace']!==workspace.id||current.State?.Running!==false||!/^([a-f0-9]{64})$/.test(current.Id??''))throw Error('Stop the owned workspace before updating its image');
 if(typeof journal!=='function'||typeof verify!=='function')throw Error('Image update requires durable journaling and readiness verification');
 const preserved='canopy-previous-'+workspace.id+'-'+randomBytes(6).toString('hex');
 const record={originalContainerId:current.Id,preservedContainer:preserved,image:release.reference};
 await journal({...record,phase:'prepared'});
 const fresh=JSON.parse((await docker(['inspect',name])).stdout)[0];
 if(fresh.Id!==current.Id||fresh.State?.Running!==false)throw Error('Workspace changed before image update');
 let renamed=false;
 try{
  await journal({...record,phase:'replacing'});
  await docker(['update','--restart','no',name]);
  await docker(['rename',name,preserved]);renamed=true;
  const runtime=await launch(release.reference);
  if(!await verify(runtime))throw Error('New workspace image failed readiness');
  await journal({...record,phase:'committed'});
  return runtime;
 }catch(error){
  if(renamed){
   let replacement;try{replacement=JSON.parse((await docker(['inspect',name])).stdout)[0];}catch(e){if(!e.missingResource)throw e;}
   if(replacement){
    if(replacement.Config?.Labels?.['canopy.workspace']!==workspace.id)throw Error('Image update recovery ownership differs');
    await docker(['update','--restart','no',name]);
    if(replacement.State?.Running)await docker(['stop','--timeout','30',name]);
    await docker(['rename',name,preserved+'-failed']);
   }
   await docker(['rename',preserved,name]);
  }
  await docker(['update','--restart','on-failure:3',name]);
  const restored=JSON.parse((await docker(['inspect',name])).stdout)[0];
  if(restored.Id!==current.Id||restored.State?.Running!==false)throw Error('Original stopped workspace could not be restored');
  await journal({...record,phase:'rolled-back'});
  error.imageUpgradeRolledBack=true;
  throw error;
 }
}

export async function readImageUpgrade(directory,workspaceId){
 if(!directory||!validId(workspaceId))throw Error('Invalid image upgrade journal');
 const file=await open(path.join(directory,workspaceId+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=await file.stat();
  if(!info.isFile()||info.size>16384||(info.mode&0o077)!==0)throw Error('Invalid image upgrade journal permissions');
  const record=JSON.parse(await file.readFile('utf8'));
  if(record.version!==1||record.workspaceId!==workspaceId||!['prepared','replacing','committed','rolled-back'].includes(record.phase)||
     !/^[a-f0-9]{64}$/.test(record.originalContainerId??'')||
     !new RegExp('^canopy-previous-'+workspaceId+'-[a-f0-9]{12}$').test(record.preservedContainer??''))throw Error('Invalid image upgrade record');
  return record;
 }finally{await file.close();}
}
/** Trusted offline recovery retains both containers and all volumes, never starts compute. */
export async function recoverImageUpgrade(record,{docker,journal}){
 if(typeof docker!=='function'||typeof journal!=='function')throw Error('Recovery requires trusted Docker access and durable journaling');
 const id=record.workspaceId,name='canopy-ws-'+id;
 if(!validId(id)||!['prepared','replacing','rolled-back'].includes(record.phase)||!/^([a-f0-9]{64})$/.test(record.originalContainerId??'')||
    !new RegExp('^canopy-previous-'+id+'-[a-f0-9]{12}$').test(record.preservedContainer??''))throw Error('No safe image rollback record');
 const inspect=async name=>{try{return JSON.parse((await docker(['inspect',name])).stdout)[0];}catch(e){if(e.missingResource)return null;throw e;}};
 const canonical=await inspect(name),preserved=await inspect(record.preservedContainer);
 const owned=value=>value?.Config?.Labels?.['canopy.workspace']===id;
 const original=canonical?.Id===record.originalContainerId?canonical:preserved?.Id===record.originalContainerId?preserved:null;
 if(!original||!owned(original)||original.State?.Running!==false||canonical&&!owned(canonical))throw Error('Original identity or stopped state cannot be established');
 if(preserved&&preserved.Id!==record.originalContainerId)throw Error('Preserved container identity differs');
 if(canonical?.Id!==record.originalContainerId){
  if(canonical){
   await docker(['update','--restart','no',name]);
   if(canonical.State?.Running)await docker(['stop','--timeout','30',name]);
   await docker(['rename',name,record.preservedContainer+'-recovery-'+randomBytes(6).toString('hex')]);
  }
  await docker(['rename',record.preservedContainer,name]);
 }
 await docker(['update','--restart','on-failure:3',name]);
 const restored=await inspect(name);
 if(restored?.Id!==record.originalContainerId||restored.State?.Running!==false)throw Error('Original stopped runtime was not restored');
 await journal({...record,phase:'rolled-back'});
 return {workspaceId:id,containerId:restored.Id,state:'stopped',phase:'rolled-back'};
}
