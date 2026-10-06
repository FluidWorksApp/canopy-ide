import {sharingPolicy,permits} from './team-policy.mjs';

// Union access per project, never combine a broad viewer grant with a narrow
// writer grant into workspace-wide write access.
export function projectAccess(grants){
 let allRead=false,allWrite=false;const selected=new Map();
 for(const grant of grants){
  if(!permits(grant.role,'view'))continue;
  const policy=sharingPolicy(grant.permissions),writable=permits(grant.role,'connect');
  if(policy.projects==='all'){allRead=true;allWrite ||= writable;}
  else for(const id of policy.projectIds)selected.set(id,(selected.get(id)??false)||writable);
 }
 return {allRead,allWrite,selected:[...selected].sort(([a],[b])=>a.localeCompare(b)).map(([id,writable])=>({id,writable}))};
}
