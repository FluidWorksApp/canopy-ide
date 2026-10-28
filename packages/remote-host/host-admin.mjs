import http from 'node:http';
import {chmod,rm} from 'node:fs/promises';
// A local management socket for the root recovery agent (update-host step b).
// It lives in the management state directory (canopy-host only, mode 0600):
// workspace containers and the network never reach it, and it is not behind
// Caddy. One request at a time.
export const HOST_ADMIN_SOCKET='host-admin.sock';
const DIGEST=/^[a-z0-9]+(?:[.-][a-z0-9]+)+(?::[0-9]{1,5})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;
export async function startHostAdmin({socketPath,updateOwnerImage,log=console.warn}){
 await rm(socketPath,{force:true});
 let busy=false;
 const server=http.createServer({requestTimeout:30000,headersTimeout:10000},async(request,response)=>{
  const reply=(status,value)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
  if(request.method!=='POST'||request.url!=='/v1/owner-image')return reply(404,{error:'Not found'});
  if(busy)return reply(409,{error:'An update is already running'});
  busy=true;
  try{
   let body='';for await(const chunk of request){body+=chunk;if(body.length>4096)return reply(413,{error:'Request too large'});}
   const image=JSON.parse(body||'{}').image;
   if(typeof image!=='string'||!DIGEST.test(image))return reply(400,{error:'An immutable release image is required'});
   reply(200,await updateOwnerImage(image));
  }catch(error){log(`Owner image update failed: ${error?.message??error}`);reply(500,{code:'failed',detail:String(error?.message??error)});}
  finally{busy=false;}
 });
 // Long image pulls outlive Node's default request timeout on the reply side.
 server.timeout=0;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.off('error',reject);resolve();});});
 await chmod(socketPath,0o600);
 return server;
}
