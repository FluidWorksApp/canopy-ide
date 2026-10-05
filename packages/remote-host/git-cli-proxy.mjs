import {timingSafeEqual} from 'node:crypto';import {Readable} from 'node:stream';import {pipeline} from 'node:stream/promises';
// Git smart HTTP only. Repository and upstream host come from the private vault,
// never from an arbitrary URL supplied by Git or a development container.
export function gitCliHandler({secret,execute}){
 return async(req,res)=>{
  const auth=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'',a=Buffer.from(auth),b=Buffer.from(secret);
  const fail=(status)=>{res.writeHead(status,{'content-type':'text/plain','cache-control':'no-store'});res.end('Shared Git access unavailable');};
  if(a.length!==b.length||!timingSafeEqual(a,b))return fail(401);
  const url=new URL(req.url,'http://git'),advertise=req.method==='GET'&&url.pathname==='/info/refs',service=advertise?url.searchParams.get('service'):url.pathname.slice(1);
  if(!['git-upload-pack','git-receive-pack'].includes(service)||(advertise?(url.search!==('?service='+service)):(req.method!=='POST'||url.search||!['/git-upload-pack','/git-receive-pack'].includes(url.pathname))))return fail(404);
  const abort=new AbortController(),closed=()=>abort.abort();res.once('close',closed);
  try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4*1024*1024)return fail(413);chunks.push(chunk);}if(advertise&&size)return fail(400);
   const response=await execute(service==='git-upload-pack'?'git:fetch':'git:push',Buffer.concat(chunks),{advertise,signal:abort.signal});
   res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/octet-stream','cache-control':'no-store'});
   if(response.body)await pipeline(Readable.fromWeb(response.body),res);else res.end();
  }catch{if(res.headersSent)res.destroy();else fail(403);}finally{res.removeListener('close',closed);}
 };
}
