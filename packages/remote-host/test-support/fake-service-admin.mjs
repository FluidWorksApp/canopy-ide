import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// A stand-in canopy-serviced admin socket (protocol §3) for gateway tests.
export async function fakeServiceAdmin(handler){
 const dir=await mkdtemp(join(tmpdir(),'cs-')),socketPath=join(dir,'admin.sock'),calls=[];
 const server=http.createServer(async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  const text=Buffer.concat(chunks).toString(),call={method:request.method,path:request.url,body:text?JSON.parse(text):undefined};calls.push(call);
  const reply=await handler(call,request,response);
  if(reply===undefined||response.headersSent)return;
  const [status,body]=Array.isArray(reply)?reply:[200,reply];
  response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(body));
 });
 await new Promise(resolve=>server.listen(socketPath,resolve));
 return {socketPath,calls,server,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}};
}
