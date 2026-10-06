import {projectMounts} from './project-mounts.mjs';

// Run only in the trusted host under its workspace resource lock. Never use a
// container-supplied source path or inherit another workspace's volume options.
export async function prepareProjectVolumes(workspace,{docker,image}){
 const owner=workspace.parentWorkspaceId??workspace.id;
 for(const [target,volume] of projectMounts(workspace)){
  const project=target.split('/').at(-1);
  let existing;
  try{existing=JSON.parse((await docker(['volume','inspect',volume])).stdout)[0];}
  catch(error){if(!error.missingResource&&!/no such volume/i.test(String(error.stderr)))throw error;}
  if(!existing){
   await docker(['volume','create','--driver','local','--label',`canopy.workspace=${owner}`,'--label',`canopy.project=${project}`,volume]);
   existing=JSON.parse((await docker(['volume','inspect',volume])).stdout)[0];
  }
  if(existing?.Name!==volume||existing.Driver!=='local'||Object.keys(existing.Options??{}).length||
     existing.Labels?.['canopy.workspace']!==owner||existing.Labels?.['canopy.project']!==project)throw Error('Shared project volume ownership differs');
  // Only the mount root is initialized. Do not recursively change user files
  // or follow symlinks. This is safe to repeat after an interrupted startup.
  await docker(['run','--rm','--network','none','--read-only','--user','0:0',
   '--cap-drop','ALL','--cap-add','CHOWN','--security-opt','no-new-privileges:true',
   '--memory','64m','--memory-swap','64m','--cpus','0.25','--pids-limit','16',
   '--mount',`type=volume,source=${volume},target=/project`,
   '--entrypoint','/usr/bin/chown',image,'--no-dereference','1000:1000','/project']);
 }
}
