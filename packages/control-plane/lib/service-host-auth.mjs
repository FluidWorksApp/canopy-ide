import {createHmac,timingSafeEqual} from 'node:crypto';
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
export const SERVICE_HOST_KINDS=['workspace-access-snapshot','peer-host-registration','peer-relay'];
// Same token shape as the runtime-policy credential, keyed by the workspace
// secret the managed host already holds. `kind` binds a token to one purpose.
export function verifyServiceHostToken(token,keyForWorkspace,kind,now=Date.now()){
 if(!SERVICE_HOST_KINDS.includes(kind)||typeof token!=='string'||token.length>1024)fail(401,'Invalid host credential');
 const [payload,signature,extra]=token.split('.');if(!payload||!signature||extra)fail(401,'Invalid host credential');
 let claims;try{claims=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{fail(401,'Invalid host credential');}
 const seconds=Math.floor(now/1000);
 if(!claims||claims.version!==1||claims.kind!==kind||!/^ws-[a-f0-9-]{36}$/.test(claims.workspaceId??'')||!Number.isSafeInteger(claims.generation)||claims.generation<0||!Number.isSafeInteger(claims.expires)||claims.expires<=seconds||claims.expires>seconds+120)fail(401,'Invalid host credential');
 const expected=createHmac('sha256',keyForWorkspace(claims.workspaceId)).update(payload).digest(),actual=Buffer.from(signature,'base64url');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))fail(401,'Invalid host credential');
 return claims;
}
export function bearerHostClaims(authorization,keyForWorkspace,kind,now=Date.now()){
 if(typeof authorization!=='string'||!authorization.startsWith('Bearer '))fail(401,'Invalid host credential');
 return verifyServiceHostToken(authorization.slice(7),keyForWorkspace,kind,now);
}
// A replaced host carries an older generation and is fenced here.
export async function currentHostWorkspace(db,claims,{lock=false}={}){
 const w=(await db.query(`SELECT id,owner_id,generation,organization_id,team_delivery,access_revision FROM workspace WHERE id=$1 AND deleted_at IS NULL${lock?' FOR UPDATE':''}`,[claims.workspaceId])).rows[0];
 if(!w||String(w.generation)!==String(claims.generation))fail(403,'Host is not current for this workspace');
 return w;
}
