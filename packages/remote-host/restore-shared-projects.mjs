#!/usr/bin/env node
// Undo the old per-project sharing copy (for example a half-finished setup).
// The owner's /workspace volume still holds the original folders with their
// real names; the copies live in canopy-shared-project-* volumes mounted at
// /workspace/projects/<id>. Three steps, run by an operator on the host:
//   plan          read-only: maps every copied repository back to its original
//                 folder and reports work that exists only in a copy.
//   apply         gateway stopped and masked, --confirm <workspace>: recreates
//                 the owner container without the copy mounts (same home,
//                 project volume, capacity slice and installed tools) and
//                 points the owner's saved project list back at the originals.
//                 Copies and the previous container are kept.
//   delete-copies only after the owner confirmed the originals are complete,
//                 --confirm-delete <workspace>: removes the copy volumes and the
//                 preserved containers. Never touches the original volumes.
import {readFile,rename,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateConfig} from './policy.mjs';
import {projectMounts} from './project-mounts.mjs';

const credentialFree=url=>typeof url==='string'?url.replace(/\/\/[^/@]*@/,'//'):null;
/** Copies and originals as reported by the inspection helper. Matches on the
 * repository's root commit and origin; anything ambiguous stays unresolved. */
export function matchCopies(copies,originals){
 return copies.map(copy=>{
  const candidates=originals.filter(o=>o.root&&o.root===copy.root&&credentialFree(o.origin)===credentialFree(copy.origin));
  const original=candidates.length===1?candidates[0]:null;
  return {copy:copy.path,original:original?.path??null,candidates:candidates.map(c=>c.path),
   onlyInCopy:original?copy.head!==original.head&&!original.contains?.includes(copy.head):null,uncommitted:copy.dirty??0};
 });
}
/** The owner's saved project list with copy paths replaced by the originals.
 * Components whose original cannot be resolved are listed, not guessed. */
export function restoredStore(store,{workspaceId,mapping}){
 const unresolved=[];
 const projects=(store?.projects??[]).map(project=>{
  if(project?.sharedWorkspaceId!==workspaceId)return project;
  const {sharedWorkspaceId,readOnly,...rest}=project;
  return {...rest,components:(project.components??[]).map(component=>{
   const match=mapping.find(m=>m.original&&(component.path===m.copy||component.path.startsWith(m.copy+'/')));
   if(!match){unresolved.push({project:project.name,component:component.label,path:component.path});return component;}
   return {...component,path:match.original+component.path.slice(match.copy.length)};
  })};
 });
 return {store:{...store,projects},unresolved};
}
// Runs inside a throwaway workspace-image container: originals at /source and
// each copy volume at /copies/<project>, all read-only, no network.
export const INSPECT_SCRIPT=`
import {execFileSync} from 'node:child_process';import {readdirSync,statSync,existsSync} from 'node:fs';import {join} from 'node:path';
const git=(dir,...a)=>{try{return execFileSync('git',['-c','safe.directory=*','-C',dir,...a],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}};
const describe=(dir,shown)=>({path:shown,root:(git(dir,'rev-list','--max-parents=0','HEAD')??'').split('\\n').pop()||null,origin:git(dir,'config','--get','remote.origin.url'),head:git(dir,'rev-parse','HEAD'),dirty:(git(dir,'status','--porcelain')??'').split('\\n').filter(Boolean).length});
const originals=[];const walk=(dir,shown,depth)=>{if(depth>4)return;let names;try{names=readdirSync(dir);}catch{return;}if(names.includes('.git')){const d=describe(dir,shown);d.contains=(git(dir,'rev-list','--all','--max-count=100000')??'').split('\\n');originals.push(d);return;}for(const n of names){if(n.startsWith('.')||n==='node_modules'||n==='projects'&&depth===0)continue;const p=join(dir,n);try{if(statSync(p).isDirectory())walk(p,shown+'/'+n,depth+1);}catch{}}};
walk('/source','/workspace',0);
const copies=[];for(const project of readdirSync('/copies')){const base=join('/copies',project,'content','.canopy-repositories');if(!existsSync(base))continue;for(const name of readdirSync(base))copies.push(describe(join(base,name),'/workspace/projects/'+project+'/content/.canopy-repositories/'+name));}
console.log(JSON.stringify({originals,copies}));`;
export async function inspectCopies({workspace,docker,image}){
 const mounts=projectMounts(workspace);
 const args=['run','--rm','--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--pids-limit','64',
  '--mount',`type=volume,source=canopy-project-${workspace.id},target=/source,readonly`,
  ...mounts.flatMap(([target,volume])=>['--mount',`type=volume,source=${volume},target=/copies/${target.split('/').at(-1)},readonly`]),
  '--entrypoint','node',image,'--input-type=module','-e',INSPECT_SCRIPT];
 const {stdout}=await docker(args);const {originals,copies}=JSON.parse(stdout.trim().split('\n').at(-1));
 return {mapping:matchCopies(copies,originals),volumes:mounts.map(([,volume])=>volume)};
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const [command,configPath,stateDirectory,...flags]=process.argv.slice(2);
 const flag=name=>{const i=flags.indexOf(name);return i<0?null:flags[i+1];};
 const run=promisify(execFile),docker=async args=>run('docker',args,{encoding:'utf8',maxBuffer:16*1024*1024,timeout:600000});
 try{
  if(!['plan','apply','delete-copies'].includes(command)||!configPath||!stateDirectory)throw Object.assign(Error('Usage: node restore-shared-projects.mjs plan|apply|delete-copies HOST_CONFIG HOST_STATE [--confirm WORKSPACE] [--confirm-delete WORKSPACE]'),{usage:true});
  if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Run on the trusted Linux host as root');
  const config=validateConfig(JSON.parse(await readFile(configPath,'utf8')));
  const workspace=config.workspaces.find(w=>w.id===config.managedSession?.workspaceId);
  if(!workspace)throw Error('Managed workspace missing from host configuration');
  const image=process.env.CANOPY_WORKSPACE_IMAGE;
  if(command==='plan'){
   if(!workspace.projectMounts?.length){console.log(JSON.stringify({workspaceId:workspace.id,copies:0,message:'No copied projects are mounted.'},null,1));}
   else console.log(JSON.stringify({workspaceId:workspace.id,...await inspectCopies({workspace,docker,image})},null,1));
  }else if(command==='apply'){
   if(flag('--confirm')!==workspace.id)throw Error('Pass --confirm '+workspace.id+' after reviewing the plan with the owner');
   const {requireOfflineGateway}=await import('./recover-migration.mjs');await requireOfflineGateway(run);
   const {mapping}=await inspectCopies({workspace,docker,image});
   const {DockerWorkspaces}=await import('./docker.mjs');const {restoreOriginalMounts}=await import('./migrate-workspace.mjs');const {createMigrationJournal,readMigrationJournal}=await import('./migration-journal.mjs');
   const directory=join(stateDirectory,'migrations');await mkdir(directory,{recursive:true,mode:0o700});
   // The earlier copy migration's journal is complete; archive it so a new
   // journal can track this replacement.
   const previous=join(directory,`${workspace.id}.migration.jsonl`);
   try{const {records}=await readMigrationJournal(previous);if(records.at(-1).phase!=='committed')throw Error('The earlier migration is not committed; use recover-migration.mjs first');await rename(previous,join(directory,`${workspace.id}.copy-${Date.now()}.done`));}catch(error){if(error.code!=='ENOENT')throw error;}
   const host=new DockerWorkspaces({secret:'offline-restore',image,registry:config.workspaces});
   const journal=await createMigrationJournal(directory,workspace.id);
   const {writeFile:write,open:openFile}=await import('node:fs/promises');
   const result=await restoreOriginalMounts({config,workspaceId:workspace.id,host,journal,verifyRuntime:async()=>{},saveConfig:async next=>{const temp=configPath+'.restore';const f=await openFile(temp,'wx',0o600);await f.writeFile(JSON.stringify(next));await f.sync();await f.close();await rename(temp,configPath);}});
   await journal.close();
   // Point the saved project list at the originals (backup kept beside it).
   const storeScript=`import {readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';const restoredStore=${restoredStore.toString()};const file='/home/agent/.canopy/ide-projects.json';if(existsSync(file)){copyFileSync(file,file+'.before-restore');const result=restoredStore(JSON.parse(readFileSync(file,'utf8')),JSON.parse(process.argv[1]));writeFileSync(file,JSON.stringify(result.store));console.log(JSON.stringify(result.unresolved));}else console.log('[]');`;
   const {stdout}=await docker(['run','--rm','--network','none','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',`type=volume,source=canopy-home-${workspace.id},target=/home/agent`,'--entrypoint','node',image,'--input-type=module','-e',storeScript,JSON.stringify({workspaceId:workspace.id,mapping})]);
   await write(join(stateDirectory,`restore-${workspace.id}.json`),JSON.stringify({at:new Date().toISOString(),mapping,preservedContainer:result.preservedContainer,unresolved:JSON.parse(stdout.trim()||'[]')}),{mode:0o600});
   console.log(JSON.stringify({restored:true,preservedContainer:result.preservedContainer,unresolved:JSON.parse(stdout.trim()||'[]')},null,1));
  }else{
   if(flag('--confirm-delete')!==workspace.id)throw Error('Pass --confirm-delete '+workspace.id+' only after the owner confirmed the originals are complete');
   if(workspace.projectMounts?.length)throw Error('Copies are still mounted; run apply first');
   // Archive the replacement journal first: a restart must not expect the
   // preserved containers removed below.
   const journal=join(stateDirectory,'migrations',`${workspace.id}.migration.jsonl`);
   await rename(journal,journal.replace(/\.migration\.jsonl$/,`.restore-${Date.now()}.done`)).catch(error=>{if(error.code!=='ENOENT')throw error;});
   const {stdout:volumes}=await docker(['volume','ls','--quiet','--filter',`label=canopy.workspace=${workspace.id}`]);
   for(const volume of volumes.split('\n').filter(v=>/^canopy-shared-project-[a-f0-9]{64}$/.test(v))){
    const {stdout:users}=await docker(['ps','--all','--quiet','--filter',`volume=${volume}`]);
    for(const id of users.split('\n').filter(Boolean)){const name=(await docker(['inspect','--format','{{.Name}}',id])).stdout.trim().replace(/^\//,'');if(!name.startsWith(`canopy-preserved-${workspace.id}-`))throw Error(`${volume} is used by ${name}`);await docker(['rm',id]);}
    await docker(['volume','rm',volume]);console.log('Removed '+volume);
   }
   const {stdout:preserved}=await docker(['ps','--all','--format','{{.Names}}','--filter',`name=canopy-preserved-${workspace.id}-`]);
   for(const name of preserved.split('\n').filter(Boolean))await docker(['rm',name]).then(()=>console.log('Removed '+name));
  }
 }catch(error){console.error(error.message);process.exitCode=error.usage?2:1;}
}
