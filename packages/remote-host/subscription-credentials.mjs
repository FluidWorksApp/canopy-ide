// Management-only OAuth refresh. Public client IDs/routes are pinned to official
// CLI implementations; no caller-selectable refresh URL or client ID.
const providers={anthropic:{endpoint:'https://platform.claude.com/v1/oauth/token',clientId:'9d1c250a-e61b-44d9-88ed-5944d1962f5e'},openai:{endpoint:'https://auth.openai.com/oauth/token',clientId:'app_EMoamEEZ73f0CkXaXp7hrann'}};
function jwtClaims(token){try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());}catch{return {};}}
export function subscriptionCredentialLoader(vault,{fetchImpl=fetch,now=Date.now,timeoutMs=15000}={}){
 return async(account,context)=>vault.renew(context.workspaceId,account,async saved=>{
  if(saved.authType!=='oauth'||saved.expiresAt>now()+60000)return saved;
  const provider=providers[saved.provider];if(!provider)throw Error('Subscription sign-in required');
  const abort=new AbortController();let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error('Refresh timed out'));},timeoutMs);});
  try{return await Promise.race([timeout,(async()=>{
   const response=await fetchImpl(provider.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'refresh_token',refresh_token:saved.refreshToken,client_id:provider.clientId}),redirect:'error',signal:abort.signal});
   if(!response.ok)throw Error('Refresh rejected');
   // Bound even a fabricated response before parsing it.
   const reader=response.body.getReader(),chunks=[];let bytes=0;for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>32768){await reader.cancel();throw Error('Invalid refresh response');}chunks.push(Buffer.from(value));}
   const value=JSON.parse(Buffer.concat(chunks).toString());if(typeof value.access_token!=='string'||!value.access_token||value.access_token.length>8192||/[\r\n]/.test(value.access_token))throw Error('Invalid refreshed token');
   const claims=jwtClaims(value.access_token),identity=jwtClaims(value.id_token??''),accountId=claims['https://api.openai.com/auth']?.chatgpt_account_id??identity['https://api.openai.com/auth']?.chatgpt_account_id;
   if(saved.provider==='openai'&&accountId&&accountId!==saved.providerAccountId)throw Error('Subscription account changed');
   const expiresAt=Number.isFinite(value.expires_in)?now()+value.expires_in*1000:Number.isFinite(claims.exp)?claims.exp*1000:0;
   if(!Number.isSafeInteger(expiresAt)||expiresAt<=now()+60000||expiresAt>now()+31*86400000)throw Error('Invalid subscription expiry');
   const refreshToken=value.refresh_token??saved.refreshToken;if(typeof refreshToken!=='string'||!refreshToken||refreshToken.length>8192||/[\r\n]/.test(refreshToken))throw Error('Invalid refresh token');
   return {...saved,token:value.access_token,refreshToken,expiresAt};
  })()]);}catch{abort.abort();throw Error('Subscription sign-in required');}finally{clearTimeout(timer);}
 });
}
