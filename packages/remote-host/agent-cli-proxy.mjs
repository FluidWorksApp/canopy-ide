import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const routes={claude:{'POST /v1/messages':'agents:claude','POST /v1/messages/count_tokens':'agents:claude:count-tokens','GET /v1/models':'agents:claude:models'},codex:{'POST /responses':'agents:codex','POST /v1/responses':'agents:codex','GET /models':'agents:codex:models','GET /v1/models':'agents:codex:models'}};
// The host may mount this handler behind its HTTPS gateway. Only the random,
// session-scoped facade credential enters the development container.
export function agentCliHandler({agent,secret,execute}){
 if(!Object.hasOwn(routes,agent)||typeof secret!=='string'||secret.length<32||typeof execute!=='function')throw Error('Invalid shared CLI adapter');
 return async(req,res)=>{
  const auth=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):req.headers['x-api-key'];
  const expected=Buffer.from(secret),actual=Buffer.from(typeof auth==='string'?auth:'');
  const fail=(status,message)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:{message}}));};
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return fail(401,'Shared CLI authentication required');
  const url=new URL(req.url,'http://adapter'),operation=routes[agent][req.method+' '+url.pathname];
  if(url.search||!operation)return fail(404,'Unsupported shared CLI endpoint');
  const abort=new AbortController();const closed=()=>abort.abort();res.once('close',closed);
  try{
   const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>4*1024*1024)return fail(413,'Shared CLI request too large');chunks.push(chunk);}
   const response=await execute(operation,Buffer.concat(chunks),{signal:abort.signal,providerHeaders:agent==='claude'?Object.fromEntries(['anthropic-beta','anthropic-version'].filter(k=>typeof req.headers[k]==='string').map(k=>[k,req.headers[k]])):undefined});
   res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json','cache-control':'no-store'});
   if(response.body)await pipeline(Readable.fromWeb(response.body),res);else res.end();
  }catch{if(res.headersSent)res.destroy();else fail(502,'Shared CLI request failed');}finally{res.removeListener('close',closed);}
 };
}
// Bind this server to 127.0.0.1 when using it as a standalone local adapter.
export function createAgentCliProxy(options){return http.createServer(agentCliHandler(options));}
