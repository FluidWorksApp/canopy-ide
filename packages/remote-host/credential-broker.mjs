import {providerQuotaHeaders} from './provider-quota-headers.mjs';
// Runs in the trusted management runtime. Callers never select credentials,
// upstream URLs, provider headers or another member's identity.
const operations=new Set(['git:fetch','git:push','agents:claude','agents:codex','agents:claude:count-tokens','agents:claude:models','agents:codex:models']);
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
export class CredentialBroker {
 constructor({authorize,loadCredential,fetchImpl=fetch,pollMs=2000,maxDurationMs=120000}){
  if(typeof authorize!=='function'||typeof loadCredential!=='function')throw Error('Credential broker requires trusted authority and vault');
  if(!Number.isInteger(pollMs)||pollMs<20||pollMs>2000||!Number.isInteger(maxDurationMs)||maxDurationMs<20||maxDurationMs>120000)throw Error('Invalid broker observation bounds');
  this.pollMs=pollMs;this.maxDurationMs=maxDurationMs;this.authorize=authorize;this.loadCredential=loadCredential;this.fetch=fetchImpl;
 }
 async execute(principal,request,{signal}={}){
  if(signal?.aborted)throw Error('Shared provider request cancelled');
  if(!principal||typeof principal.memberId!=='string'||!principal.memberId||typeof principal.workspaceId!=='string'||!id(request?.projectId)||!operations.has(request?.operation))throw Error('Forbidden');
  // Only project/operation and bounded payload enter from the developer runtime.
  if(request.advertise!==undefined&&typeof request.advertise!=='boolean')throw Error('Invalid advertisement mode');
  if(Object.keys(request).some(k=>!['projectId','operation','body','advertise','providerHeaders','clientVersion'].includes(k)))throw Error('Invalid credential operation');
  if(request.providerHeaders!==undefined&&(!request.providerHeaders||Object.keys(request.providerHeaders).some(k=>!['anthropic-beta','anthropic-version'].includes(k))||Object.values(request.providerHeaders).some(v=>typeof v!=='string'||v.length>2048||! /^[\x20-\x7e]*$/.test(v))))throw Error('Invalid provider capability headers');
  if(request.clientVersion!==undefined&&(request.operation!=='agents:codex:models'||typeof request.clientVersion!=='string'||! /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.test(request.clientVersion)))throw Error('Invalid model client version');
  const body=request.body??new Uint8Array();
  if(!(body instanceof Uint8Array)||body.byteLength>4*1024*1024)throw Error('Credential payload too large');
  const context={workspaceId:principal.workspaceId,memberId:principal.memberId,projectId:request.projectId,operation:request.operation};
  const grant=await this.authorize(principal,context);
  if(!grant||Object.keys(context).some(k=>grant[k]!==context[k])||!id(grant.accountId))throw Error('Forbidden');
  const credential=await this.loadCredential(grant.accountId,context);
  if(!credential||credential.workspaceId!==context.workspaceId||credential.accountId!==grant.accountId||typeof credential.token!=='string'||!credential.token||credential.token.length>8192||/[\r\n]/.test(credential.token))throw Error('Shared account is unavailable');
  let url,method='POST',headers={'content-type':'application/json'};
  if(request.operation.startsWith('git:')){
   if(credential.provider!=='github'||! /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[-\w.]{1,100}$/.test(credential.repository??'')||['.','..'].includes(credential.repository?.split('/')[1]))throw Error('Shared Git account is unavailable');
   const service=request.operation==='git:fetch'?'git-upload-pack':'git-receive-pack';
   if(request.advertise===true){if(body.byteLength)throw Error('Invalid Git advertisement');method='GET';url=`https://github.com/${credential.repository}.git/info/refs?service=${service}`;}
   else {url=`https://github.com/${credential.repository}.git/${service}`;headers['content-type']=`application/x-${service}-request`;}
   headers.authorization='Basic '+Buffer.from('x-access-token:'+credential.token).toString('base64');
  }else{
   if(request.advertise!==undefined)throw Error('Invalid agent operation');
   if(request.operation.startsWith('agents:claude')&&credential.provider==='anthropic'){
    url='https://api.anthropic.com/v1/'+(request.operation==='agents:claude:models'?'models':request.operation==='agents:claude:count-tokens'?'messages/count_tokens':'messages');if(request.operation.endsWith(':models'))method='GET';headers['x-api-key']=credential.token;headers['anthropic-version']=request.providerHeaders?.['anthropic-version']??'2023-06-01';if(request.providerHeaders?.['anthropic-beta'])headers['anthropic-beta']=request.providerHeaders['anthropic-beta'];if(credential.authType==='oauth'){delete headers['x-api-key'];headers.authorization='Bearer '+credential.token;headers['anthropic-beta']=[headers['anthropic-beta'],'oauth-2025-04-20'].filter(Boolean).join(',');}
   }else if(request.operation.startsWith('agents:codex')&&credential.provider==='openai'){
    url='https://api.openai.com/v1/'+(request.operation==='agents:codex:models'?'models':'responses');if(request.operation.endsWith(':models'))method='GET';headers.authorization='Bearer '+credential.token;if(request.operation==='agents:codex:models'){url='https://chatgpt.com/backend-api/codex/models';headers.originator='codex_cli_rs';}if(credential.authType==='oauth'){url='https://chatgpt.com/backend-api/codex/'+(request.operation==='agents:codex:models'?'models':'responses');headers['chatgpt-account-id']=credential.providerAccountId;headers.originator='codex_cli_rs';}
   }else throw Error('Shared agent account is unavailable');
  }
  if(request.operation==='agents:codex:models'&&request.clientVersion)url+='?client_version='+request.clientVersion;
  if(method==='GET'&&body.byteLength)throw Error('Unexpected model discovery body');
  // Check again after vault I/O, so a revoked grant cannot release a credential
  // merely because its first lookup was accepted before revocation.
  const current=await this.authorize(principal,context);
  if(!current||Object.keys(context).some(k=>current[k]!==context[k])||current.accountId!==grant.accountId)throw Error('Forbidden');
  const abort=new AbortController();let checking=false;
  const same=value=>value&&Object.keys(context).every(k=>value[k]===context[k])&&value.accountId===grant.accountId;
  const deadline=setTimeout(()=>abort.abort(),this.maxDurationMs);
  const poll=setInterval(async()=>{
   if(checking||abort.signal.aborted)return;checking=true;
   try{if(!same(await this.authorize(principal,context)))abort.abort();}catch{abort.abort();}finally{checking=false;}
  },this.pollMs);
  const cancelClient=()=>abort.abort();
  if(signal?.aborted)abort.abort();else signal?.addEventListener('abort',cancelClient,{once:true});
  const cleanup=()=>{clearInterval(poll);clearTimeout(deadline);signal?.removeEventListener('abort',cancelClient);};
  try{
   if(abort.signal.aborted)throw Error('Request cancelled');
   const response=await this.fetch(url,{method,headers,...(method==='POST'?{body}:{}),redirect:'error',signal:abort.signal});
   if(abort.signal.aborted||response.status>=300&&response.status<400)throw Error('Provider unavailable');
   if(!response.ok){response.body?.cancel().catch(()=>{});cleanup();return Response.json({error:{message:'Shared provider rejected the request'}},{status:response.status,headers:{'cache-control':'no-store',...(request.operation.startsWith('agents:codex')?providerQuotaHeaders(response.headers):{})}});}
   const safeHeaders={'content-type':response.headers.get('content-type')??'application/octet-stream','cache-control':'no-store',...(request.operation.startsWith('agents:codex')?providerQuotaHeaders(response.headers):{})};
   if(!response.body){cleanup();return new Response(null,{status:response.status,headers:safeHeaders});}
   const reader=response.body.getReader();let bytes=0;
   let rejectAbort;const cancelled=new Promise((_,reject)=>{rejectAbort=reject;});cancelled.catch(()=>{});
   const onAbort=()=>rejectAbort(Error('Shared access ended'));abort.signal.addEventListener('abort',onAbort,{once:true});
   const finish=()=>{cleanup();abort.signal.removeEventListener('abort',onAbort);};
   const stream=new ReadableStream({
    async pull(controller){
     try{
      const result=await Promise.race([reader.read(),cancelled]);
      if(abort.signal.aborted)throw Error('Shared access ended');
      if(result.done){finish();controller.close();return;}
      bytes+=result.value.byteLength;if(bytes>512*1024*1024)throw Error('Provider response too large');
      controller.enqueue(result.value);
     }catch{finish();abort.abort();reader.cancel().catch(()=>{});controller.error(Error('Shared provider stream failed'));}
    },
    cancel(){finish();abort.abort();reader.cancel().catch(()=>{});}
   });
   return new Response(stream,{status:response.status,headers:safeHeaders});
  }catch{cleanup();abort.abort();throw Error('Shared provider request failed');}
 }
}
