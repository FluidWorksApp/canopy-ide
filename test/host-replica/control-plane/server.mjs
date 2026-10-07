// Local control plane: canopy-website's real Vercel functions (api/*.ts, run
// unmodified through Node's type stripping) behind a small Vercel-compatible
// adapter, served over HTTPS as canopyide.dev with the replica CA. The same
// listener answers the presigned S3 runtime URL, and a timer plays Vercel's
// one-minute cron (/api/reconcile). Started with --import ./register.mjs, so
// the AWS clients are the local stand-ins (hooks.mjs).
import {createServer} from 'node:https';
import {request} from 'node:https';
import {createReadStream,existsSync,readFileSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const env=process.env;
const API='/website/api';
const S3_HOST=`${env.CANOPY_RUNTIME_BUCKET}.s3.${env.CANOPY_RUNTIME_REGION??'ap-southeast-1'}.amazonaws.com`;
const tls={key:readFileSync('/replica-ca/leaf.key'),cert:readFileSync('/replica-ca/leaf.crt'),ca:readFileSync('/replica-ca/ca.crt')};
const handlers=new Map();
async function handlerFor(name){
 if(!/^[a-z0-9-]+$/.test(name)||!existsSync(`${API}/${name}.ts`))return null;
 if(!handlers.has(name))handlers.set(name,(await import(pathToFileURL(`${API}/${name}.ts`).href)).default);
 return handlers.get(name);
}
const readBody=req=>new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',c=>{size+=c.length;if(size>4*1024*1024){reject(Error('Body too large'));req.destroy();}else chunks.push(c);});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);});
// The subset of @vercel/node's request/response helpers the handlers use.
async function vercel(handler,req,res,url){
 req.query=Object.fromEntries(url.searchParams);
 req.cookies=Object.fromEntries(String(req.headers.cookie??'').split(';').map(p=>p.trim().split('=')).filter(([k])=>k).map(([k,...v])=>[k,decodeURIComponent(v.join('='))]));
 const raw=await readBody(req),type=String(req.headers['content-type']??'');
 let body;
 if(raw.length){
  if(type.includes('application/json')){try{body=JSON.parse(raw.toString('utf8'));}catch{res.statusCode=400;return res.end('Invalid JSON');}}
  else if(type.startsWith('text/'))body=raw.toString('utf8');
  else if(type.includes('application/x-www-form-urlencoded'))body=Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  else body=raw;
 }
 req.body=body;
 res.status=code=>{res.statusCode=code;return res;};
 res.json=value=>{if(!res.getHeader('content-type'))res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));return res;};
 res.send=value=>{if(value!==null&&typeof value==='object'&&!Buffer.isBuffer(value))return res.json(value);res.end(value);return res;};
 res.redirect=(a,b)=>{const [code,location]=typeof a==='number'?[a,b]:[307,a];res.statusCode=code;res.setHeader('Location',location);res.end();return res;};
 await handler(req,res);
}
function serveRuntime(req,res,url){
 if(req.method!=='GET'||url.pathname!==`/${env.CANOPY_RUNTIME_KEY}`||!url.searchParams.get('X-Amz-Signature')){res.statusCode=403;return res.end('<Error><Code>AccessDenied</Code></Error>');}
 res.setHeader('Content-Type','application/gzip');res.setHeader('Content-Length',statSync(env.REPLICA_RUNTIME_FILE).size);
 createReadStream(env.REPLICA_RUNTIME_FILE).pipe(res);
 console.log('[s3] GET',url.pathname,'from',req.socket.remoteAddress);
}
// Replica only (--pending-upgrade): a flat apt repository with one package.
function serveApt(req,res,url){
 const name=decodeURIComponent(url.pathname.slice('/__apt/'.length)).replace(/^(\.\/)+/,'');
 if(req.method!=='GET'&&req.method!=='HEAD'||!/^[A-Za-z0-9._+~-]*$/.test(name)||!name||!existsSync(`/replica-apt/${name}`)){res.statusCode=404;return res.end();}
 res.setHeader('Content-Length',statSync(`/replica-apt/${name}`).size);
 if(req.method==='HEAD')return res.end();
 createReadStream(`/replica-apt/${name}`).pipe(res);
 console.log('[apt] GET',name,'from',req.socket.remoteAddress);
}
async function replicaRoute(req,res,url){
 const lightsail=await import('./local-lightsail.mjs');
 res.setHeader('Content-Type','application/json');
 if(url.pathname==='/__replica/events')return res.end(JSON.stringify(lightsail.replicaEvents()));
 if(url.pathname==='/__replica/collect'&&req.method==='POST'){await lightsail.collectAll(url.searchParams.get('label')??'collect');return res.end('{"ok":true}');}
 res.statusCode=404;res.end('{}');
}
const server=createServer(tls,async(req,res)=>{
 const host=String(req.headers.host??'').split(':')[0];
 const url=new URL(req.url,`https://${host||'canopyide.dev'}`);
 const started=Date.now();
 try{
  if(host===S3_HOST)return serveRuntime(req,res,url);
  if(url.pathname.startsWith('/__apt/'))return serveApt(req,res,url);
  if(url.pathname.startsWith('/__replica/')&&req.headers['x-replica-token']===env.REPLICA_ADMIN_TOKEN)return await replicaRoute(req,res,url);
  const match=url.pathname.match(/^\/api\/([a-z0-9-]+)$/);
  const handler=match&&await handlerFor(match[1]);
  if(!handler){res.statusCode=404;return res.end('Not found');}
  await vercel(handler,req,res,url);
 }catch(error){
  console.error('[api] unhandled',url.pathname,error);
  if(!res.headersSent){res.statusCode=500;res.end('Internal error');}
 }finally{
  if(!url.pathname.startsWith('/__replica/'))res.on('finish',()=>console.log('[http]',req.method,host,url.pathname,res.statusCode,`${Date.now()-started}ms`,req.socket.remoteAddress));
 }
});
server.listen(443,()=>console.log('[replica] control plane listening on :443 as canopyide.dev and',S3_HOST));
// Vercel cron: * * * * * GET /api/reconcile with the cron secret.
const cron=()=>{const r=request({host:'127.0.0.1',port:443,path:'/api/reconcile',method:'GET',servername:'canopyide.dev',ca:tls.ca,headers:{host:'canopyide.dev',authorization:`Bearer ${env.CRON_SECRET}`}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>console.log('[cron] reconcile',res.statusCode,body.slice(0,400)));});r.on('error',e=>console.error('[cron]',e.message));r.end();};
if(env.REPLICA_CRON_SECONDS!=='0')setInterval(cron,Number(env.REPLICA_CRON_SECONDS??60)*1000);
