import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {projectMounts} from './project-mounts.mjs';
import {sharedProjectDefinitions} from './project-catalog.mjs';
import {prepareProjectVolumes} from './project-volumes.mjs';
import {validateMigrationComponents} from './project-migration.mjs';

// Must run under DockerWorkspaces' resource lock. The source volume remains
// intact and is mounted read-only; no home/account volume enters the helper.
export async function migrateProjectVolume(workspace,project,{docker,image}){
 if(workspace.memberId||workspace.parentWorkspaceId)throw Error('Only the owning workspace can migrate projects');
 validateMigrationComponents(project.components);
 const catalog={id:project.id,name:project.name,writable:true,components:project.components.map(({id,label,relativePath})=>({id,label,relativePath:relativePath==='.'?'content':'content/'+relativePath}))};
 const targetWorkspace={...workspace,projectMounts:[catalog]};
 sharedProjectDefinitions(targetWorkspace);
 const [,destination]=projectMounts(targetWorkspace)[0],source=`canopy-project-${workspace.id}`;
 const inspected=JSON.parse((await docker(['volume','inspect',source])).stdout)[0];
 if(inspected?.Name!==source||inspected.Driver!=='local'||Object.keys(inspected.Options??{}).length)throw Error('Invalid source project volume');
 for(const volume of [source,destination]){
  const running=await docker(['ps','--quiet','--filter',`volume=${volume}`]);
  if(running.stdout.trim())throw Error('Stop all workspace sessions before migrating projects');
 }
 await prepareProjectVolumes(targetWorkspace,{docker,image});
 const script=fileURLToPath(new URL('./project-migration.mjs',import.meta.url));
 if(script.includes(','))throw Error('Migration installation path is invalid');
 const helper='canopy-migrate-'+randomUUID();
 try{await docker(['run','--rm','--name',helper,'--label','canopy.migration=true','--label',`canopy.workspace=${workspace.id}`,'--network','none','--read-only','--user','1000:1000','--cap-drop','ALL',
  '--security-opt','no-new-privileges:true','--memory','256m','--memory-swap','256m','--cpus','1','--pids-limit','32',
  '--mount',`type=volume,source=${source},target=/source,readonly`,
  '--mount',`type=volume,source=${destination},target=/destination`,
  '--mount',`type=bind,source=${script},target=/migration.mjs,readonly`,
  '--entrypoint','node',image,'--input-type=module','-e',
  "import {copyProjectComponents} from '/migration.mjs'; await copyProjectComponents({sourceRoot:'/source',destinationRoot:'/destination',components:JSON.parse(process.argv[1])});",JSON.stringify(project.components)]);
 }catch(error){
  // A timed-out Docker CLI does not stop its container. Do not leave a copier
  // running after the host has released the migration lock.
  try{await docker(['rm','--force',helper]);}
  catch(cleanup){if(!cleanup.missingResource&&!/no such/i.test(String(cleanup.stderr)))throw Object.assign(Error('Migration failed and its helper could not be stopped'),{migrationCleanupRequired:true});}
  throw error;
 }
 return catalog;
}
