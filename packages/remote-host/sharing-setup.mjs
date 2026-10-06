import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {migrateWorkspace} from './migrate-workspace.mjs';
import {createMigrationJournal,readMigrationJournal} from './migration-journal.mjs';
import {sharedProjectDefinitions} from './project-catalog.mjs';
import {validateMigrationComponents} from './project-migration.mjs';
import {waitForRuntimeReady} from './runtime-readiness.mjs';
import {privateRead} from './credential-vault.mjs';
const execute=promisify(execFile);
export class SharingSetup{
 constructor({config,host,directory,configPath,authorizeRuntime,instanceName=process.env.CANOPY_INSTANCE_NAME,networkReady=async()=>{await execute('systemctl',['is-active','--quiet','canopy-network'],{timeout:5000});},migrate=migrateWorkspace,now=Date.now}){Object.assign(this,{config,host,directory,configPath,authorizeRuntime,instanceName,networkReady,migrate,now});this.jobs=new Map();}
 active(id){return this.jobs.get(id)?.status==='running';}
 async status(workspace){
  const current=this.jobs.get(workspace.id);if(current)return {status:current.status,phase:current.phase,error:current.error??null};
  if(this.host.migrationCleanupRequired.has(workspace.id))return {status:'recovery-required',phase:'recovery',error:'Sharing setup was interrupted. Original files are retained; management recovery is required.'};
  if(workspace.projectMounts?.length)return {status:'ready',phase:'ready',error:null};
  try{const {records}=await readMigrationJournal(join(this.directory,workspace.id+'.migration.jsonl'));return {status:'recovery-required',phase:records.at(-1).phase,error:'Review the retained migration before retrying.'};}catch(e){if(e.code!=='ENOENT')throw e;}
  return {status:'not-enabled',phase:'choose-projects',error:null};
 }
 async start(workspace,{projects,confirmInterrupt}){
  if(confirmInterrupt!==true)throw Error('Confirm that running agents and terminals will stop before enabling sharing.');
  if(this.active(workspace.id))return this.status(workspace);
  if(workspace.projectMounts?.length)throw Error('Shared project storage is already configured. Activate its verified sharing readiness instead.');
  if(!Array.isArray(projects)||!projects.length||projects.length>128)throw Error('Choose projects to share.');
  for(const p of projects)validateMigrationComponents(p.components);
  sharedProjectDefinitions({...workspace,projectMounts:projects.map(p=>({...p,writable:true,components:p.components.map(({id,label,relativePath})=>({id,label,relativePath}))}))});
  if(typeof this.authorizeRuntime!=='function'||!await this.authorizeRuntime(workspace))throw Error('Workspace lifecycle authorization changed.');
  await this.host.verifyCapacity({...workspace,cgroupParent:workspace.cgroupParent??workspace.sharingCgroupParent});await this.networkReady();
  await mkdir(this.directory,{recursive:true,mode:0o700});const journal=await createMigrationJournal(this.directory,workspace.id);
  const job={status:'running',phase:'stopping'};this.jobs.set(workspace.id,job);
  // Persist explicit interruption intent before any process is stopped.
  try{await journal.append({phase:'stop-requested',generation:workspace.generation});}catch(error){this.jobs.delete(workspace.id);await journal.close();throw error;}
  job.promise=(async()=>{
   try{
    const current=await this.host.inspectRuntime(workspace);if(!current||current.Config?.Labels?.['canopy.workspace']!==workspace.id)throw Error('Owning workspace is unavailable.');
    await this.host.docker(['stop','--timeout','30','canopy-ws-'+workspace.id]);this.host.runtimes.delete(workspace.id);job.phase='copying-projects';
    await this.migrate({config:this.config,workspaceId:workspace.id,projects,host:this.host,journal,saveConfig:next=>this.saveConfig(next,workspace),verifyRuntime:async(runtime,next)=>{
     job.phase='checking-isolation';await this.host.verifyCapacity(next);await this.networkReady();if(!await this.authorizeRuntime(workspace)||!await waitForRuntimeReady(runtime))throw Error('Sharing readiness could not be verified.');
    }});job.status='ready';job.phase='ready';
   }catch(error){this.host.migrationCleanupRequired.add(workspace.id);job.status='recovery-required';job.phase='failed';job.error=String(error.message??error);}
   finally{await journal.close().catch(()=>{job.status='recovery-required';job.error='Migration journal could not be confirmed.';});}
  })();return {status:job.status,phase:job.phase,error:null};
 }
 async saveConfig(next,workspace){
  const before=JSON.parse(await privateRead(this.configPath,1024*1024));const current=before.workspaces.find(w=>w.id===workspace.id);
  if(!current||current.generation!==workspace.generation||['stopped','deleted'].includes(current.desiredState??current.desired_state)||!await this.authorizeRuntime(workspace))throw Error('Workspace generation or lifecycle changed during sharing setup.');
  const temporary=this.configPath+'.'+randomUUID()+'.sharing';let file;
  try{file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(next));await file.sync();await file.close();file=null;await rename(temporary,this.configPath);const directory=await open(dirname(this.configPath),'r');try{await directory.sync();}finally{await directory.close();}}finally{await file?.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 async attest(workspace,{nonce,generation,instanceName}){
  if(this.active(workspace.id)||this.host.migrationCleanupRequired.has(workspace.id)||!workspace.projectMounts?.length||typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce)||generation!==workspace.generation||instanceName!==this.instanceName||typeof this.instanceName!=='string'||!this.instanceName||typeof this.authorizeRuntime!=='function'||!await this.authorizeRuntime(workspace))throw Error('Sharing readiness cannot be confirmed.');
  await this.host.verifyCapacity(workspace);await this.networkReady();
  const runtime=await this.host.open(workspace);if(!await waitForRuntimeReady(runtime))throw Error('Workspace services are not ready.');
  if(!await this.authorizeRuntime(workspace))throw Error('Workspace lifecycle authorization changed.');
  const projects=sharedProjectDefinitions(workspace).map(p=>({id:p.id,name:p.name,components:p.components.map(c=>({id:c.id,name:c.label}))}));
  const catalogHash=createHash('sha256').update(JSON.stringify(workspace.projectMounts)).digest('hex');
  const claims={version:1,purpose:'sharing-ready',workspaceId:workspace.id,generation,instanceName,nonce,catalogHash,expiresAt:this.now()+30000};
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return {proof:payload+'.'+createHmac('sha256',this.config.managedSession.key).update(payload).digest('base64url'),projects};
 }
}
