// Shared by account APIs and tests. Never infer credential sharing from membership.
export const roles = ['owner', 'admin', 'member', 'viewer'];
const actions = {
 owner: ['view','connect','resume','stop','invite','revoke','delete','billing','resize'],
 admin: ['view','connect','resume','stop','invite','revoke','resize'],
 member: ['view','connect','resume'],
 viewer: ['view'],
};
export function permits(role, action) { return actions[role]?.includes(action) === true; }
export function sharingPolicy(input = {}) {
 if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid sharing permissions');
 const projectIds = input.projectIds ?? [];
 if (!Array.isArray(projectIds) || projectIds.length > 100 || projectIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw Error('Choose valid projects');
 const mode = (value, allowed, fallback) => { const result=value??fallback; if(!allowed.includes(result))throw Error('Invalid sharing permission');return result; };
 return {projects: mode(input.projects,['selected','all'],'selected'), projectIds:[...new Set(projectIds)].sort(),
  git:mode(input.git,['personal','shared'],'personal'), agents:mode(input.agents,['personal','shared'],'personal'),
  sessions:mode(input.sessions,['private','view','interact'],'private')};
}
export function invitationRole(actorRole, requestedRole) {
 if (!permits(actorRole,'invite') || !['admin','member','viewer'].includes(requestedRole) || (actorRole==='admin' && requestedRole==='admin')) throw Error('This role cannot be assigned');
 return requestedRole;
}
export function canRevoke(actorRole,targetRole) {
 return actorRole==='owner' && targetRole!=='owner' || actorRole==='admin' && ['member','viewer'].includes(targetRole);
}
