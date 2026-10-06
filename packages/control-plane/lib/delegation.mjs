import {sharingPolicy,permits} from './team-policy.mjs';

/** Resource delegation is bounded by administrative grants for the same project.
 * A broad viewer or developer grant cannot widen a narrow admin grant. */
export function canDelegateWorkspacePolicy(grants,requested){
 const target=sharingPolicy(requested);
 if(grants.some(g=>g.role==='owner'))return true;
 const admins=grants.filter(g=>g.role==='admin'&&permits(g.role,'invite')).map(g=>sharingPolicy(g.permissions));
 const resources=policy=>
  (target.git!=='shared'||policy.git==='shared')&&
  (target.agents!=='shared'||policy.agents==='shared')&&
  (target.sessions==='private'||policy.sessions==='interact'||target.sessions==='view'&&policy.sessions==='view');
 if(target.projects==='all')return admins.some(p=>p.projects==='all'&&resources(p));
 if(target.projectIds.length)return target.projectIds.every(id=>admins.some(p=>(p.projects==='all'||p.projectIds.includes(id))&&resources(p)));
 // Empty project grants cannot be used to smuggle account or session authority.
 return admins.some(resources);
}
