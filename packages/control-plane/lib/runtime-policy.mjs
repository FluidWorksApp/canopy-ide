import {createHmac,timingSafeEqual} from 'node:crypto';
export function verifyRuntimePolicyToken(token,keyForWorkspace,now=Date.now()){
 if(typeof token!=='string'||token.length>1024)throw Error('Invalid runtime policy credential');
 const [payload,signature,extra]=token.split('.');if(!payload||!signature||extra)throw Error('Invalid runtime policy credential');
 const claims=JSON.parse(Buffer.from(payload,'base64url').toString());
 if(claims.version!==3||claims.kind!=='runtime-policy'||!/^ws-[a-f0-9-]{36}$/.test(claims.workspaceId??'')||!Number.isSafeInteger(claims.generation)||claims.generation<0||!Number.isSafeInteger(claims.expires)||claims.expires<=Math.floor(now/1000)||claims.expires>Math.floor(now/1000)+120)throw Error('Invalid runtime policy credential');
 const expected=createHmac('sha256',keyForWorkspace(claims.workspaceId)).update(payload).digest(),actual=Buffer.from(signature,'base64url');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('Invalid runtime policy credential');return claims;
}
export async function runtimeRecoveryAllowed(db,claims){
 const current=(await db.query('SELECT generation,desired_state,state FROM workspace WHERE id=$1 AND deleted_at IS NULL',[claims.workspaceId])).rows[0];
 return !!current&&String(current.generation)===String(claims.generation)&&current.desired_state==='running'&&['ready','starting'].includes(current.state);
}
