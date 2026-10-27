// Speaking MCP to the servers mcp-servers.mjs discovered, so the Tools panel can
// show what they expose. The Linux counterpart of src-tauri/src/mcp_client.rs:
// same handshake (modern `server/discover` probe, legacy `initialize` fallback),
// same JSON-RPC framing (one object per line on stdio, POST + JSON/SSE on
// streamable HTTP), same pool and idle reaping, same timeouts, size bounds and
// error strings, because the panel shows those strings verbatim.
//
// Launch specs: the registry never retains env values (by design), so a key is
// resolved by rediscovering the row with the project folders the panel last
// listed, then re-reading that row's own sources for the values — the same
// first-source-wins / first-non-empty-env-wins fold mcp.rs's Collector applies.
// Only sources the registry itself produced are ever read.
//
// stdio servers are children of this host, spawned directly (not via ctx.run:
// they are long-lived) in their own process group so `npx` grandchildren die
// with them. cwd stays inside /workspace; HOME is the workspace account.
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {dedupeKey,tomlTablePath} from './mcp-servers.mjs';

const MODERN='2026-07-28',LEGACY='2025-06-18',CLIENT_NAME='Canopy';
const CONNECT_TIMEOUT=45_000,LIST_TIMEOUT=30_000,CALL_TIMEOUT=120_000,IDLE_TIMEOUT=300_000,REAP_EVERY=60_000;
const STDERR_KEEP=8*1024,MAX_REQUEST_BYTES=4*1024*1024,MAX_RESPONSE_BYTES=16*1024*1024;
const MAX_SCHEMA_BYTES=512*1024,MAX_SCHEMA_NODES=10_000,MAX_SCHEMA_DEPTH=64;
const NOT_IN_CONFIG='this server is no longer in any config — refresh the panel';
const clientVersion=(()=>{try{return JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;}catch{return '0.0.0';}})();

export const MCP_CLIENT_READ_ONLY=['mcp_connected'];

const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const secs=ms=>Math.floor(ms/1000);
const str=(v,k)=>typeof v?.[k]==='string'?v[k]:null;

class RpcFailure extends Error{
 constructor(method,code,message){super(code==null?`${method} failed: ${message}`:`${method} failed: ${message} (code ${code})`);this.method=method;this.code=code;}
}

// --- stdio ------------------------------------------------------------------
class StdioTransport{
 static async start(spec,{home,cwd}){
  if(!spec.command)throw Error('this server has no command to run');
  const child=spawn(spec.command,spec.args,{cwd,env:{...process.env,HOME:home,...spec.env},stdio:['pipe','pipe','pipe'],detached:true});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',e=>reject(Error(`could not start \`${spec.command}\`: ${e.message}`)));});
  return new StdioTransport(child);
 }
 constructor(child){
  this.child=child;this.stderr='';this.closed=false;this.waiter=null;this.chunks=[];this.size=0;this.oversized=false;
  child.on('error',()=>{});child.stdin.on('error',()=>{});
  // Drained whether or not anyone reads it: a full stderr pipe deadlocks a chatty server mid-handshake.
  let stderrEnded;const stderrEnd=new Promise(r=>{stderrEnded=r;});
  child.stderr.on('data',d=>{this.stderr+=d.toString('utf8');if(this.stderr.length>STDERR_KEEP)this.stderr=this.stderr.slice(-STDERR_KEEP);});
  child.stderr.on('end',stderrEnded);child.stderr.on('error',stderrEnded);
  child.stdout.on('data',chunk=>this.feed(chunk));
  // A dying server's reason is on stderr, which may land just after stdout closes.
  const eof=()=>{if(this.closed)return;this.closed=true;Promise.race([stderrEnd,new Promise(r=>setTimeout(r,250))]).then(()=>this.fail(Error('the server closed its output')));};
  child.stdout.on('end',eof);child.stdout.on('error',eof);
 }
 // Newline framing with the byte budget checked before buffering, like read_capped_line.
 feed(chunk){
  let start=0;
  while(start<chunk.length){
   const nl=chunk.indexOf(10,start),end=nl<0?chunk.length:nl+1,part=chunk.subarray(start,end);start=end;
   if(!this.oversized){const keep=Math.min(part.length,Math.max(0,MAX_RESPONSE_BYTES-this.size));this.chunks.push(part.subarray(0,keep));this.size+=keep;this.oversized=keep<part.length;}
   if(nl<0)break;
   const line=Buffer.concat(this.chunks),oversized=this.oversized;this.chunks=[];this.size=0;this.oversized=false;
   if(oversized){this.fail(Error(`MCP response line exceeded ${MAX_RESPONSE_BYTES} bytes`));continue;}
   // Banners, logs and notifications are skipped; only our reply matters.
   let message;try{message=JSON.parse(line.toString('utf8'));}catch{continue;}
   if(this.waiter&&Number.isInteger(message?.id)&&message.id===this.waiter.id){const w=this.waiter;this.waiter=null;w.resolve(message);}
  }
 }
 fail(error){if(this.waiter){const w=this.waiter;this.waiter=null;w.reject(error);}}
 async send(body){
  const line=JSON.stringify(body),bytes=Buffer.byteLength(line);
  if(bytes>MAX_REQUEST_BYTES)throw Error(`MCP request is ${bytes} bytes; maximum is ${MAX_REQUEST_BYTES}`);
  if(this.child.stdin.destroyed||!this.child.stdin.writable)throw Error('writing to the server failed: the pipe is closed');
  await new Promise((resolve,reject)=>this.child.stdin.write(line+'\n',e=>e?reject(Error(`writing to the server failed: ${e.message}`)):resolve()));
 }
 async roundTrip(id,body,timeout){
  await this.send(body);
  if(this.closed)throw Error('the server closed its output');
  let timer;
  try{return await new Promise((resolve,reject)=>{this.waiter={id,resolve,reject};timer=setTimeout(()=>{this.waiter=null;reject(Error(`the server did not answer within ${secs(timeout)}s`));},timeout);});}
  finally{clearTimeout(timer);}
 }
 notify(_method,body){return this.send(body);}
 tail(){return this.stderr.trim();}
 close(){this.closed=true;this.fail(Error('the server closed its output'));try{process.kill(-this.child.pid,'SIGKILL');}catch{try{this.child.kill('SIGKILL');}catch{}}}
}

// --- streamable HTTP ----------------------------------------------------------
function encodeName(name){return name&&/^[A-Za-z0-9._-]+$/.test(name)?name:`=?base64?${Buffer.from(name).toString('base64')}?=`;}
function encodeParameter(value){
 let raw;if(typeof value==='string')raw=value;else if(typeof value==='boolean'||typeof value==='number')raw=JSON.stringify(value);else throw Error('an x-mcp-header argument must be a primitive value');
 const plain=/^[\x00-\x7f]*$/.test(raw)&&raw.trim()===raw&&[...raw].every(c=>c==='\t'||(c>=' '&&c!=='\x7f'));
 return plain?raw:`=?base64?${Buffer.from(raw).toString('base64')}?=`;
}
function modernRequestName(method,body){
 const p=body.params??{};
 if(method==='tools/call'||method==='prompts/get')return typeof p.name==='string'?p.name:null;
 if(method==='resources/read')return typeof p.uri==='string'?p.uri:null;
 if(['tasks/get','tasks/update','tasks/cancel'].includes(method))return typeof p.taskId==='string'?p.taskId:null;
 return null;
}
// One JSON-RPC object, a batch holding ours, or an SSE stream whose data: lines carry them.
export function parseHttpBody(text,id){
 let value;try{value=JSON.parse(text.trim());}catch{value=undefined;}
 if(value!==undefined){
  if(Array.isArray(value)){const mine=value.find(m=>m?.id===id);if(!mine)throw Error('the server answered without our request in it');return mine;}
  return value;
 }
 for(const line of text.split(/\r?\n/)){if(!line.startsWith('data:'))continue;let message;try{message=JSON.parse(line.slice(5).trim());}catch{continue;}if(message?.id===id)return message;}
 throw Error("the server's answer could not be read as JSON-RPC");
}
const reachError=e=>Error(`the server could not be reached: ${e?.cause?.message??e?.message??e}`);

class HttpTransport{
 constructor(spec){if(!spec.url)throw Error('this server has no URL');this.url=spec.url;this.headers=spec.env;this.sessionId=null;}
 request(method,body,modern,version,paramHeaders,signal){
  const encoded=JSON.stringify(body),bytes=Buffer.byteLength(encoded);
  if(bytes>MAX_REQUEST_BYTES)throw Error(`MCP request is ${bytes} bytes; maximum is ${MAX_REQUEST_BYTES}`);
  // Streamable HTTP lets the server answer either way; accepting only one gets a 406 from half of them.
  const headers={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':version};
  if(modern){headers['mcp-method']=method;const name=modernRequestName(method,body);if(name!=null)headers['mcp-name']=encodeName(name);}
  for(const [k,v] of Object.entries(this.headers))headers[k.toLowerCase()]=v;
  for(const [k,v] of paramHeaders)headers[k.toLowerCase()]=v;
  if(!modern&&this.sessionId)headers['mcp-session-id']=this.sessionId;
  return fetch(this.url,{method:'POST',headers,body:encoded,signal});
 }
 async notify(method,body,modern,version){
  let res;try{res=await this.request(method,body,modern,version,[],AbortSignal.timeout(CALL_TIMEOUT));}catch(e){if(e.message?.startsWith('MCP request'))throw e;throw reachError(e);}
  await res.body?.cancel().catch(()=>{});
 }
 async roundTrip(id,method,body,timeout,modern,version,paramHeaders){
  // `timeout` bounds the answer arriving; the whole exchange is bounded by the call budget, like the reqwest client.
  const controller=new AbortController();let timedOut=false;
  const headerTimer=setTimeout(()=>{timedOut=true;controller.abort();},timeout),totalTimer=setTimeout(()=>controller.abort(),Math.max(timeout,CALL_TIMEOUT));
  try{
   let res;
   try{res=await this.request(method,body,modern,version,paramHeaders,controller.signal);}
   catch(e){if(e.message?.startsWith('MCP request'))throw e;if(timedOut)throw Error(`the server did not answer within ${secs(timeout)}s`);throw reachError(e);}
   clearTimeout(headerTimer);
   if(!modern){const session=res.headers.get('mcp-session-id');if(session)this.sessionId=session;}
   const length=Number(res.headers.get('content-length'));
   if(length>MAX_RESPONSE_BYTES){await res.body?.cancel().catch(()=>{});throw Error(`MCP response exceeded ${MAX_RESPONSE_BYTES} bytes`);}
   const parts=[];let size=0;
   if(res.body){
    const reader=res.body.getReader();
    for(;;){
     let step;try{step=await reader.read();}catch(e){throw Error(`reading the response failed: ${e?.message??e}`);}
     if(step.done)break;size+=step.value.length;
     if(size>MAX_RESPONSE_BYTES){await reader.cancel().catch(()=>{});throw Error(`MCP response exceeded ${MAX_RESPONSE_BYTES} bytes`);}
     parts.push(step.value);
    }
   }
   let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));}catch{throw Error('the MCP response was not UTF-8');}
   if(!res.ok){
    // Modern discovery tells a modern server from a legacy one by the JSON-RPC error code, even on a 4xx.
    try{const message=parseHttpBody(text,id);if(isObject(message)&&'error' in message)return message;}catch{}
    const detail=text.trim().slice(0,300);
    throw Error(`the server answered ${`${res.status} ${res.statusText??''}`.trim()}: ${detail}`);
   }
   return parseHttpBody(text,id);
  }finally{clearTimeout(headerTimer);clearTimeout(totalTimer);}
 }
 tail(){return '';}
 close(){}
}

// --- modern-protocol helpers --------------------------------------------------
function attachModernMeta(params,version){
 if(!isObject(params))params={};
 if(!('_meta' in params))params._meta={};
 if(!isObject(params._meta))return params;
 Object.assign(params._meta,{
  'io.modelcontextprotocol/protocolVersion':version,
  'io.modelcontextprotocol/clientCapabilities':{extensions:{'io.modelcontextprotocol/tasks':{}}},
  'io.modelcontextprotocol/clientInfo':{name:CLIENT_NAME,version:clientVersion},
 });
 return params;
}
function validateModernResult(result){
 const type=result?.resultType;
 if(type==='complete'||type==='input_required'||type==='task')return;
 throw Error(typeof type==='string'?`unknown MCP result type \`${type}\``:'the modern MCP result omitted resultType');
}

// Untrusted JSON Schema is bounded structurally before it reaches the webview.
export function schemaSafety(schema){
 const bytes=Buffer.byteLength(JSON.stringify(schema)??'');
 if(bytes>MAX_SCHEMA_BYTES)throw Error(`schema exceeded ${MAX_SCHEMA_BYTES} bytes`);
 if(!isObject(schema)&&typeof schema!=='boolean')throw Error('a JSON Schema must be an object or boolean');
 let nodes=0;
 const visit=(value,depth)=>{
  if(depth>MAX_SCHEMA_DEPTH)throw Error(`schema exceeded depth ${MAX_SCHEMA_DEPTH}`);
  if(++nodes>MAX_SCHEMA_NODES)throw Error(`schema exceeded ${MAX_SCHEMA_NODES} nodes`);
  if(Array.isArray(value)){for(const c of value)visit(c,depth+1);}
  else if(isObject(value)){if(typeof value.$ref==='string'&&!value.$ref.startsWith('#'))throw Error('external $ref is not allowed');for(const c of Object.values(value))visit(c,depth+1);}
 };
 visit(schema,0);
}
const containsHeader=v=>Array.isArray(v)?v.some(containsHeader):isObject(v)&&('x-mcp-header' in v||Object.values(v).some(containsHeader));
export function toolHeaderParams(schema){
 const out=[],seen=new Set(),properties=schema?.properties;
 if(!isObject(properties)){if(containsHeader(schema))throw Error('x-mcp-header must annotate a top-level property');return out;}
 for(const [argument,property] of Object.entries(properties)){
  if(!isObject(property))continue;
  if(Object.entries(property).some(([k,v])=>k!=='x-mcp-header'&&containsHeader(v)))throw Error('x-mcp-header must not annotate a nested property');
  if(!('x-mcp-header' in property))continue;
  const header=property['x-mcp-header'];
  if(typeof header!=='string')throw Error('x-mcp-header must be a string');
  if(!header||/[^\x21-\x7e]|:/.test(header))throw Error('x-mcp-header contains an invalid header name');
  const prim=['string','number','integer','boolean'],t=property.type;
  const primitive=typeof t==='string'?prim.includes(t):Array.isArray(t)&&t.every(k=>typeof k==='string'&&(prim.includes(k)||k==='null'));
  if(!primitive)throw Error('x-mcp-header must annotate a primitive property');
  if(seen.has(header.toLowerCase()))throw Error('x-mcp-header names must be unique ignoring case');
  seen.add(header.toLowerCase());out.push({argument,header});
 }
 return out;
}

// --- a connection -------------------------------------------------------------
class Connection{
 constructor(transport,spec){Object.assign(this,{transport,spec,nextId:0,lastUsed:Date.now(),era:'probing',protocolVersion:MODERN,toolCache:null,toolHeaders:new Map(),queue:Promise.resolve(),busy:0,closing:false});}
 // Requests on one connection are serialized, like the Rust per-connection Mutex.
 exclusive(fn){
  const run=this.queue.then(async()=>{this.busy++;try{return await fn();}finally{this.busy--;if(this.closing&&!this.busy)this.transport.close();}});
  this.queue=run.catch(()=>{});return run;
 }
 close(){this.closing=true;if(!this.busy)this.transport.close();}
 async request(method,params,timeout){return this.requestRaw(method,params,timeout,false);}
 async requestRaw(method,params,timeout,probeModern){
  const id=++this.nextId,modern=probeModern||this.era==='modern';
  if(modern)params=attachModernMeta(params,this.protocolVersion);
  let paramHeaders=[];
  if(modern&&method==='tools/call'){try{paramHeaders=this.parameterHeaders(params);}catch(e){throw new RpcFailure(method,null,e.message);}}
  const body={jsonrpc:'2.0',id,method,params};this.lastUsed=Date.now();
  let response;
  try{response=this.transport instanceof HttpTransport?await this.transport.roundTrip(id,method,body,timeout,modern,this.protocolVersion,paramHeaders):await this.transport.roundTrip(id,body,timeout);}
  catch(e){throw new RpcFailure(method,null,e.message);}
  if(isObject(response)&&response.error!=null){
   const message=typeof response.error?.message==='string'?response.error.message:'unknown error';
   const code=Number.isInteger(response.error?.code)?response.error.code:0;
   throw new RpcFailure(method,code,message);
  }
  const result=isObject(response)&&'result' in response?response.result:null;
  if(modern){try{validateModernResult(result);}catch(e){throw new RpcFailure(method,null,e.message);}}
  return result;
 }
 async notify(method,params){
  const modern=this.era==='modern';if(modern)params=attachModernMeta(params,this.protocolVersion);
  const body={jsonrpc:'2.0',method,params};
  return this.transport instanceof HttpTransport?this.transport.notify(method,body,modern,this.protocolVersion):this.transport.notify(method,body);
 }
 parameterHeaders(params){
  const defs=typeof params?.name==='string'?this.toolHeaders.get(params.name):null;if(!defs)return [];
  const args=isObject(params.arguments)?params.arguments:null;if(!args)return [];
  return defs.filter(d=>d.argument in args&&args[d.argument]!==null).map(d=>[`mcp-param-${d.header}`,encodeParameter(args[d.argument])]);
 }
 withStderr(message){
  const tail=this.transport.tail();if(!tail)return message;
  return `${message}\n\n${tail.split('\n').slice(-6).join('\n')}`;
 }
}

async function listTools(conn){
 if(conn.toolCache&&conn.toolCache.expiresAt>Date.now())return structuredClone(conn.toolCache.tools);
 const tools=[],headers=new Map();let cursor=null,ttl=null;
 for(;;){
  const page=await conn.request('tools/list',cursor==null?{}:{cursor},LIST_TIMEOUT).catch(e=>{throw Error(e.message);});
  for(const item of Array.isArray(page?.tools)?page.tools:[]){
   if(typeof item?.name!=='string')continue;
   // An absent schema means "no arguments": an empty object for the form, not null.
   const inputSchema=item.inputSchema??{type:'object'};
   try{schemaSafety(inputSchema);if(item.outputSchema!==undefined)schemaSafety(item.outputSchema);}catch{continue;}
   let params;try{params=toolHeaderParams(inputSchema);}catch{continue;}
   headers.set(item.name,params);
   tools.push({name:item.name,title:str(item,'title'),description:str(item,'description'),input_schema:inputSchema,output_schema:item.outputSchema??null,annotations:item.annotations??null});
  }
  cursor=str(page,'nextCursor');
  if(conn.era==='modern'&&Number.isSafeInteger(page?.ttlMs)&&page.ttlMs>=0)ttl=ttl==null?page.ttlMs:Math.min(ttl,page.ttlMs);
  // A server that keeps handing back a cursor would loop forever.
  if(cursor==null||tools.length>2000)break;
 }
 conn.toolCache=ttl>0?{tools:structuredClone(tools),expiresAt:Date.now()+ttl}:null;
 conn.toolHeaders=headers;
 return tools;
}
// Prompts and resources are listed for completeness; failing them is not failing to connect.
async function listNamed(conn,method,field){
 let page;try{page=await conn.request(method,{},LIST_TIMEOUT);}catch{return [];}
 return (Array.isArray(page?.[field])?page[field]:[]).flatMap(item=>{
  const name=str(item,'name')??str(item,'uri');if(name==null)return [];
  return [{name,description:str(item,'description'),uri:str(item,'uri'),mime_type:str(item,'mimeType')}];
 });
}

async function startTransport(spec,env){return spec.transport==='stdio'?StdioTransport.start(spec,env):new HttpTransport(spec);}

// Connect and run the handshake, leaving a connection ready for requests.
export async function openConnection(spec,env){
 const started=Date.now();
 const conn=new Connection(await startTransport(spec,env),spec);
 let handshake;
 try{
  try{
   handshake=await conn.requestRaw('server/discover',{},CONNECT_TIMEOUT,true);
   conn.era='modern';
   const versions=Array.isArray(handshake?.supportedVersions)?handshake.supportedVersions:[];
   if(!versions.includes(MODERN))throw Error(`server/discover did not offer MCP ${MODERN}; no modern version is shared`);
   conn.protocolVersion=MODERN;
  }catch(error){
   if(!(error instanceof RpcFailure))throw error;
   if([-32020,-32021,-32022].includes(error.code))throw Error(conn.withStderr(error.message));
   // Many legacy stdio servers exit as soon as their first message is not
   // `initialize`: the probe ran on a disposable child, so start a fresh one.
   if(spec.transport==='stdio'){conn.transport.close();conn.transport=await startTransport(spec,env);conn.nextId=0;}
   conn.era='legacy';conn.protocolVersion=LEGACY;
   try{handshake=await conn.request('initialize',{protocolVersion:LEGACY,capabilities:{},clientInfo:{name:CLIENT_NAME,version:clientVersion}},CONNECT_TIMEOUT);}
   catch(e){throw Error(conn.withStderr(e.message));}
   await conn.notify('notifications/initialized',{});
  }
  const serverInfo=isObject(handshake?.serverInfo)?handshake.serverInfo:handshake?._meta?.['io.modelcontextprotocol/serverInfo'];
  const capabilities=isObject(handshake?.capabilities)?Object.keys(handshake.capabilities):[];
  // Only ask for what the server said it has.
  let tools=[];if(capabilities.includes('tools')){try{tools=await listTools(conn);}catch(e){throw Error(conn.withStderr(e.message));}}
  const prompts=capabilities.includes('prompts')?await listNamed(conn,'prompts/list','prompts'):[];
  const resources=capabilities.includes('resources')?await listNamed(conn,'resources/list','resources'):[];
  const session={key:spec.key,server_name:str(serverInfo,'name'),server_version:str(serverInfo,'version'),protocol_version:str(handshake,'protocolVersion')??conn.protocolVersion,instructions:str(handshake,'instructions'),tools,prompts,resources,capabilities,elapsed_ms:Date.now()-started};
  return {conn,session};
 }catch(error){conn.transport.close();throw error;}
}

// --- launch specs from the registry's own sources ------------------------------
const envMap=v=>isObject(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,typeof x==='string'?x:JSON.stringify(x)])):{};
const strings=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'):[];
function fullEndpoint(entry,opencode){
 if(!isObject(entry))return null;
 if(typeof entry.url==='string')return {transport:!opencode&&entry.type==='sse'?'sse':'http',command:null,args:[],url:entry.url,env:envMap(entry.headers)};
 if(opencode){const [command,...args]=strings(entry.command);return command===undefined?null:{transport:'stdio',command,args,url:null,env:envMap(entry.environment)};}
 return typeof entry.command==='string'?{transport:'stdio',command:entry.command,args:strings(entry.args),url:null,env:envMap(entry.env)}:null;
}
const unquote=v=>v.replace(/^["']+|["']+$/g,'');
const tomlValue=raw=>{raw=raw.trim();if(raw.startsWith('[')&&raw.endsWith(']'))return raw.slice(1,-1).split(',').map(i=>unquote(i.trim())).filter(Boolean);const v=unquote(raw);return v?[v]:[];};
// The Codex/Grok table for one server, values included (parseCodexToml keeps only names).
export function tomlEndpoint(raw,name){
 let table=[],found=null;
 for(const line of raw.split(/\r?\n/)){
  const header=tomlTablePath(line);if(header){table=header;continue;}
  const t=line.trim();if(!t||t.startsWith('#')||table.length<2||table[0]!=='mcp_servers'||table[1]!==name)continue;
  const at=t.indexOf('=');if(at<0)continue;
  const key=unquote(t.slice(0,at).trim()),value=t.slice(at+1);
  found??={transport:'stdio',command:null,args:[],url:null,env:{}};
  if(table.length===3&&table[2]==='env'){found.env[key]=tomlValue(value).join(' ');continue;}
  if(table.length!==2)continue;
  if(key==='command')found.command=tomlValue(value)[0]??null;
  else if(key==='args')found.args=tomlValue(value);
  else if(key==='url'){found.url=tomlValue(value)[0]??null;found.transport='http';}
 }
 return found&&(found.command!=null||found.url!=null)?found:null;
}
async function sourceEndpoint(registry,source){
 if(source.agent==='codex'||source.agent==='grok'){const raw=await registry.text(source.config_path);return raw==null?null:tomlEndpoint(raw,source.name);}
 const config=await registry.json(source.config_path);
 const entries=source.agent==='claude'&&source.scope==='project'&&path.basename(source.config_path)==='.claude.json'
  ?config?.projects?.[source.project_dir]?.mcpServers
  :config?.[{opencode:'mcp',amp:'amp.mcpServers',vscode:'servers'}[source.agent]??'mcpServers'];
 return isObject(entries)&&Object.hasOwn(entries,source.name)?fullEndpoint(entries[source.name],source.agent==='opencode'):null;
}
// mcp.rs Collector: the first source fixes command/url/cwd, env values union with the first non-empty value winning.
export async function launchSpec(registry,row){
 let spec=null;
 for(const source of row.sources??[]){
  let endpoint;try{endpoint=await sourceEndpoint(registry,source);}catch{continue;}
  if(!endpoint||dedupeKey(endpoint)!==row.key)continue;
  spec??={key:row.key,name:row.name,transport:endpoint.transport,command:endpoint.command,args:endpoint.args,url:endpoint.url,env:{},cwd:source.scope==='project'?source.project_dir??null:null};
  for(const [k,v] of Object.entries(endpoint.env))if(v!==''&&!Object.hasOwn(spec.env,k))spec.env[k]=v;
 }
 return spec;
}

// The panel's last-listed project folders, per registry, so a key resolves the
// way Rust's remembered spec map does without the renderer naming a file.
const remembered=new WeakMap();
function tapRegistry(registry){
 if(remembered.has(registry))return remembered.get(registry);
 const state={dirs:new Set(),discover:registry.discover.bind(registry)};remembered.set(registry,state);
 registry.discover=async dirs=>{const rows=await state.discover(dirs);if(Array.isArray(dirs))for(const d of dirs)if(typeof d==='string'&&state.dirs.size<256)state.dirs.add(d);return rows;};
 return state;
}

export function mcpClientCommands(ctx){
 const registry=ctx.mcpRegistry,idleTimeout=ctx.mcpIdleTimeout??IDLE_TIMEOUT,reapEvery=ctx.mcpReapEvery??REAP_EVERY;
 const tap=registry?tapRegistry(registry):null;
 const pool=new Map(),opening=new Map();let reaper=null;

 async function resolveSpec(key){
  if(!tap)return null;
  const all=[...tap.dirs],attempts=[all,...(all.length>1?all.map(d=>[d]):[]),...(all.length?[[]]:[])];
  for(const dirs of attempts){
   let rows;try{rows=await tap.discover(dirs);}catch{continue;}
   const row=rows.find(r=>r.key===key);if(row)return launchSpec(registry,row);
  }
  return null;
 }
 async function spawnEnv(spec){
  let cwd=ctx.root;
  if(spec.cwd){try{const dir=await ctx.scoped(spec.cwd);if((await stat(dir)).isDirectory())cwd=dir;}catch{}}
  return {home:ctx.home,cwd};
 }
 function drop(key,conn){if(pool.get(key)===conn)pool.delete(key);conn.close();}
 function ensureReaper(){
  if(reaper)return;
  reaper=setInterval(()=>{for(const [key,conn] of pool)if(!conn.busy&&Date.now()-conn.lastUsed>=idleTimeout)drop(key,conn);if(!pool.size&&!opening.size){clearInterval(reaper);reaper=null;}},reapEvery);
  reaper.unref?.();
 }
 // The pooled connection, opening one if there isn't; the session only when this call opened it.
 async function acquire(key){
  const existing=pool.get(key);if(existing)return {conn:existing,session:null};
  if(opening.has(key))return opening.get(key);
  const work=(async()=>{
   const spec=await resolveSpec(key);if(!spec)throw Error(NOT_IN_CONFIG);
   ensureReaper();
   const {conn,session}=await openConnection(spec,await spawnEnv(spec));
   pool.get(key)?.close();pool.set(key,conn);
   return {conn,session};
  })();
  opening.set(key,work);
  // A concurrent caller shares the handshake; only the opener reports the session.
  try{return await work;}finally{opening.delete(key);}
 }
 const checkKey=key=>{if(typeof key!=='string'||!key||key.length>16384||key.includes('\0'))throw Error('Choose an MCP server');return key;};

 async function taskRequest(args,method,params){
  const key=checkKey(args?.key);
  if(typeof args?.taskId!=='string'||!args.taskId||args.taskId.length>4096)throw Error('Choose an MCP task');
  const {conn}=await acquire(key);
  return conn.exclusive(async()=>{
   if(conn.era!=='modern')throw Error('this MCP server does not support the Tasks extension');
   return conn.request(method,params,CALL_TIMEOUT).catch(e=>{throw Error(e.message);});
  });
 }

 return {
  // `refresh` throws away the pooled connection first: the user just edited the server.
  mcp_connect:async({key,refresh}={})=>{
   checkKey(key);
   if(refresh===true){const old=pool.get(key);if(old)drop(key,old);}
   const {conn,session}=await acquire(key);if(session)return session;
   // Reused: re-list rather than trust a stale set; a dead pooled connection is dropped.
   const spec=await resolveSpec(key);if(!spec)throw Error('this server is no longer in any config');
   const started=Date.now();
   let tools;try{tools=await conn.exclusive(()=>listTools(conn));}catch(e){drop(key,conn);throw Error(e.message);}
   return {key,server_name:spec.name,server_version:null,protocol_version:null,instructions:null,tools,prompts:[],resources:[],capabilities:['tools'],elapsed_ms:Date.now()-started};
  },
  mcp_call_tool:async(args={})=>{
   const key=checkKey(args.key);
   if(typeof args.tool!=='string'||!args.tool)throw Error('Choose an MCP tool');
   const {conn}=await acquire(key);
   return conn.exclusive(async()=>{
    const started=Date.now();let result;
    try{result=await conn.request('tools/call',{name:args.tool,arguments:args.arguments??{}},CALL_TIMEOUT);}
    catch(e){
     // A transport-level failure makes the connection suspect: it serves no further call.
     const message=conn.withStderr(e.message);if(pool.get(key)===conn)pool.delete(key);conn.closing=true;throw Error(message);
    }
    const type=result?.resultType;
    return {content:result?.content??[],is_error:result?.isError===true,structured:result?.structuredContent??null,task:type==='task'||type==='input_required'?result:null,elapsed_ms:Date.now()-started};
   });
  },
  mcp_task_get:args=>taskRequest(args,'tasks/get',{taskId:args?.taskId}),
  mcp_task_update:args=>taskRequest(args,'tasks/update',{taskId:args?.taskId,inputResponses:args?.inputResponses??null}),
  mcp_task_cancel:args=>taskRequest(args,'tasks/cancel',{taskId:args?.taskId}),
  mcp_disconnect:async({key}={})=>{checkKey(key);const conn=pool.get(key);if(conn)drop(key,conn);return null;},
  mcp_connected:async()=>[...pool.keys()],
 };
}
