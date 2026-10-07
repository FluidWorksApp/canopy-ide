import {auth,pool,authOrigin} from './auth.mjs';
import {tokenHash} from './policy.mjs';
export function requestHeaders(req){const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);return headers;}
export async function principal(req){
 const bearer=String(req.headers.authorization??'').match(/^Bearer ([A-Za-z0-9_-]{64})$/)?.[1];
 if(bearer){
  const result=await pool.query('SELECT u.id,u.email,u.name FROM device_token d JOIN "user" u ON u.id=d.user_id WHERE d.token_hash=$1 AND d.expires_at>now() AND u."emailVerified"=true',[tokenHash(bearer)]);
  if(result.rows[0])return {...result.rows[0],source:'device'};
 }
 const session=await auth.api.getSession({headers:requestHeaders(req)});
 return session?.user?.emailVerified?{...session.user,source:'browser'}:null;
}
export function mayMutate(req,user){return user?.source==='device'||req.headers.origin===authOrigin();}
