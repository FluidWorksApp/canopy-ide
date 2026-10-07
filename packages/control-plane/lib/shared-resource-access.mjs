import {sharingPolicy} from './team-policy.mjs';
import {projectAccess} from './project-access.mjs';
// Each resource stays on the grant that explicitly shared it. A broad personal
// viewer cannot widen a narrow shared developer's credential execution scope.
export function sharedResourceAccess(grants){
 return Object.fromEntries(['git','agents'].map(resource=>[resource,projectAccess(grants.filter(grant=>sharingPolicy(grant.permissions)[resource]==='shared'))]));
}
