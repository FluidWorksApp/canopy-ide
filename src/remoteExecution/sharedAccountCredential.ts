export type AgentCredential={provider:'anthropic'|'openai';token:string;authType?:'oauth';refreshToken?:string;expiresAt?:number;providerAccountId?:string};
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Paste a supported account export.');return value as Record<string,unknown>;};
function token(value:unknown){if(typeof value!=='string'||!value.trim()||value.length>8192||/[\r\n]/.test(value))throw Error('The account export is missing a valid sign-in token.');return value;}
function claims(value:unknown):Record<string,unknown>{
 if(typeof value!=='string')return {};
 try{const part=value.split('.')[1];if(!part||part.length>16000)return {};const bytes=Uint8Array.from(atob(part.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));return record(JSON.parse(new TextDecoder().decode(bytes)));}catch{return {};}
}
/** Extract only the fixed provider credential fields. JWT claims are metadata,
 * never an authorization decision; the provider authenticates each use. */
export function subscriptionCredential(provider:'anthropic'|'openai',json:string):AgentCredential {
 if(json.length>32768)throw Error('The account export is too large.');
 let data:Record<string,unknown>;try{data=record(JSON.parse(json));}catch{throw Error('Paste valid JSON from this provider’s sign-in export.');}
 let access:unknown,refresh:unknown,expires:unknown,account:unknown;
 if(data.authType==='oauth'){
  if(data.provider!==provider)throw Error('This sign-in belongs to a different provider.');
  access=data.token;refresh=data.refreshToken;expires=data.expiresAt;account=data.providerAccountId;
 }else if(provider==='anthropic'){
  const oauth=record(data.claudeAiOauth);access=oauth.accessToken;refresh=oauth.refreshToken;expires=oauth.expiresAt;
 }else{
  const oauth=record(data.tokens);access=oauth.access_token;refresh=oauth.refresh_token;
  const accessClaims=claims(access),identityClaims=claims(oauth.id_token);
  expires=typeof accessClaims.exp==='number'?accessClaims.exp*1000:undefined;
  const accountClaim=(source:Record<string,unknown>)=>{const auth=source['https://api.openai.com/auth'];return auth&&typeof auth==='object'?(auth as Record<string,unknown>).chatgpt_account_id:undefined;};
  account=oauth.account_id??accountClaim(accessClaims)??accountClaim(identityClaims);
 }
 const credential:AgentCredential={provider,authType:'oauth',token:token(access),refreshToken:token(refresh)};
 if(!Number.isSafeInteger(expires)||Number(expires)<=0)throw Error('The sign-in export is missing its expiry time.');
 credential.expiresAt=Number(expires);
 if(provider==='openai'){
  if(typeof account!=='string'||!/^[-\w]{1,128}$/.test(account))throw Error('The Codex sign-in export is missing its account identity.');
  credential.providerAccountId=account;
 }
 return credential;
}
