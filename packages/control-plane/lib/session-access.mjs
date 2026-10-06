import {sharingPolicy} from './team-policy.mjs';
import {projectAccess} from './project-access.mjs';
// Keep session rights on the grant that supplied them. Personal develop rights
// cannot turn a separate read-only session grant into interaction permission.
export function sessionAccess(grants){
 return {view:projectAccess(grants.filter(g=>['view','interact'].includes(sharingPolicy(g.permissions).sessions))),interact:projectAccess(grants.filter(g=>sharingPolicy(g.permissions).sessions==='interact'))};
}
