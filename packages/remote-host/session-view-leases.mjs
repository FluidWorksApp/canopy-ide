// HTTP authentication and fresh membership checks must run before observe().
// This remembers presented credentials only; it never mints or prolongs one.
export class SessionViewLeases{
 constructor({now=Date.now,maxEntries=512}={}){this.now=now;this.maxEntries=maxEntries;this.entries=new Map();}
 key(p){return JSON.stringify([p.workspaceId,p.memberId,p.accessVersion,p.scope]);}
 observe(principal,bearer){
  if(!principal?.memberId||!Number.isFinite(principal.expiresAt)||principal.expiresAt<=this.now())return;
  for(const [key,value] of this.entries)if(value.principal.expiresAt<=this.now())this.entries.delete(key);
  const key=this.key(principal),previous=this.entries.get(key);if(previous?.principal.expiresAt>=principal.expiresAt)return;
  if(!previous&&this.entries.size>=this.maxEntries)this.entries.delete(this.entries.keys().next().value);
  this.entries.set(key,{principal:{...principal},bearer});
 }
 renewedGrant(grant){
  if(!grant.memberPrincipal)return grant;const entry=this.entries.get(this.key(grant.memberPrincipal));
  if(!entry||entry.principal.expiresAt<=this.now()||entry.principal.expiresAt<=grant.expiresAt)return grant;
  return {...grant,memberPrincipal:entry.principal,expiresAt:entry.principal.expiresAt,bearer:entry.bearer};
 }
}
