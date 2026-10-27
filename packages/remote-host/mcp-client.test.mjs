import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {McpRegistry} from './mcp-servers.mjs';
import {mcpClientCommands,MCP_CLIENT_READ_ONLY,parseHttpBody,schemaSafety,toolHeaderParams,tomlEndpoint} from './mcp-client.mjs';

// A minimal but honest stdio MCP server: a banner before the protocol, stderr
// chatter, a notification mid-stream, paginated tools/list. `modern` answers
// server/discover; otherwise it rejects it like a legacy server.
const SERVER=String.raw`
const mode=process.argv[2]||'legacy';
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
console.log('starting up');console.error('listening');
let buf='';
process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(line.trim())handle(JSON.parse(line));}});
function handle(req){
 const {method,id}=req,params=req.params||{};
 if(method==='server/discover'){
  if(mode==='refuse')return send({jsonrpc:'2.0',id,error:{code:-32022,message:'unsupported version'}});
  if(mode!=='modern')return send({jsonrpc:'2.0',id,error:{code:-32601,message:'no such method'}});
  return send({jsonrpc:'2.0',id,result:{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}},instructions:'modern',_meta:{'io.modelcontextprotocol/serverInfo':{name:'modern-fake',version:'1.0'}}}});
 }
 if(mode==='modern'&&params._meta?.['io.modelcontextprotocol/protocolVersion']!=='2026-07-28')return send({jsonrpc:'2.0',id,error:{code:-32022,message:'missing version'}});
 const done=r=>send({jsonrpc:'2.0',id,result:mode==='modern'?{resultType:'complete',...r}:r});
 if(method==='initialize')return send({jsonrpc:'2.0',id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{},prompts:{}},serverInfo:{name:'fake',version:'9.9'},instructions:'be brief'}});
 if(method==='notifications/initialized')return;
 if(method==='prompts/list')return done({prompts:[{name:'greet',description:'hi'}]});
 if(method==='tools/list'){
  send({jsonrpc:'2.0',method:'notifications/message',params:{}});
  if(params.cursor==='page2')return done({tools:[{name:'second'},{name:'unsafe',inputSchema:{$ref:'https://example.invalid/s'}}]});
  return done({tools:[{name:'echo',description:'says it back',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}],nextCursor:'page2'});
 }
 if(method==='tools/call'){
  const a=params.arguments||{};
  if(params.name==='env')return done({content:[{type:'text',text:process.env.FAKE_TOKEN+'|'+process.env.HOME+'|'+process.cwd()}]});
  if(params.name==='refuse')return done({content:[{type:'text',text:'no'}],isError:true});
  if(params.name==='slowtask')return send({jsonrpc:'2.0',id,result:{resultType:'task',task:{taskId:'t1',status:'working'}}});
  if(params.name==='die'){console.error('fatal: going away');process.exit(3);}
  return done({content:[{type:'text',text:a.text??''}],structuredContent:{pid:process.pid}});
 }
 if(method==='tasks/get')return done({taskId:params.taskId,status:'completed'});
 send({jsonrpc:'2.0',id,error:{code:-32601,message:'no such method'}});
}`;

async function fixture(){
 const base=await realpath(await mkdtemp(join(tmpdir(),'mcp-client-')));
 const home=join(base,'home'),workspace=join(base,'workspace'),project=join(workspace,'proj'),bin=join(base,'bin');
 for(const dir of [join(home,'.claude'),project,bin])await mkdir(dir,{recursive:true});
 const script=join(bin,'server.cjs');await writeFile(script,SERVER);
 const dying=join(bin,'dies.cjs');await writeFile(dying,"console.error('BROWSERBASE_API_KEY is required');process.exit(1);");
 const scoped=async p=>{const abs=resolve(workspace,String(p));if(abs!==workspace&&!abs.startsWith(workspace+'/'))throw Error('outside workspace');return abs;};
 const registry=new McpRegistry({home,workspace,scoped,profiles:{list:async()=>[{id:'default',root:home}]}});
 const ctx={mcpRegistry:registry,scoped,home,root:workspace};
 const cleanup=()=>rm(base,{recursive:true,force:true});
 return {base,home,workspace,project,script,dying,registry,ctx,cleanup};
}
const writeJson=(file,value)=>writeFile(file,JSON.stringify(value));
const keyOf=async(registry,name,dirs)=>(await registry.servers(dirs)).find(r=>r.name===name).key;

test('exports the read-only list and every command',()=>{
 assert.deepEqual(MCP_CLIENT_READ_ONLY,['mcp_connected']);
 assert.deepEqual(Object.keys(mcpClientCommands({})).sort(),['mcp_call_tool','mcp_connect','mcp_connected','mcp_disconnect','mcp_task_cancel','mcp_task_get','mcp_task_update']);
});

test('a legacy stdio server is started, handshaken, listed and called with its config env',async t=>{
 const f=await fixture();t.after(f.cleanup);
 await writeJson(join(f.home,'.claude/.claude.json'),{mcpServers:{fake:{command:process.execPath,args:[f.script],env:{FAKE_TOKEN:'s3cret'}}}});
 const cmd=mcpClientCommands(f.ctx),key=await keyOf(f.registry,'fake');
 t.after(()=>cmd.mcp_disconnect({key}));
 const session=await cmd.mcp_connect({key,refresh:false});
 assert.equal(session.key,key);assert.equal(session.server_name,'fake');assert.equal(session.server_version,'9.9');
 assert.equal(session.protocol_version,'2025-06-18');assert.equal(session.instructions,'be brief');
 assert.deepEqual(session.capabilities,['tools','prompts']);
 // Both pages, in order; the schema with an external $ref is dropped.
 assert.deepEqual(session.tools.map(x=>x.name),['echo','second']);
 assert.equal(session.tools[0].input_schema.properties.text.type,'string');
 assert.deepEqual(session.tools[1],{name:'second',title:null,description:null,input_schema:{type:'object'},output_schema:null,annotations:null});
 assert.deepEqual(session.prompts,[{name:'greet',description:'hi',uri:null,mime_type:null}]);
 assert.equal(typeof session.elapsed_ms,'number');
 assert.deepEqual(await cmd.mcp_connected(),[key]);

 const echo=await cmd.mcp_call_tool({key,tool:'echo',arguments:{text:'hello'}});
 assert.deepEqual(echo.content,[{type:'text',text:'hello'}]);assert.equal(echo.is_error,false);assert.equal(echo.task,null);
 const env=await cmd.mcp_call_tool({key,tool:'env',arguments:{}});
 // Config env reaches the child, HOME is the workspace account, global servers run in /workspace.
 assert.equal(env.content[0].text,`s3cret|${f.home}|${f.workspace}`);
 const refused=await cmd.mcp_call_tool({key,tool:'refuse'});
 assert.equal(refused.is_error,true);
 // Tasks need the modern protocol.
 await assert.rejects(cmd.mcp_task_get({key,taskId:'t1'}),{message:'this MCP server does not support the Tasks extension'});
});

test('pooling reuses the process, refresh replaces it, disconnect kills it',async t=>{
 const f=await fixture();t.after(f.cleanup);
 await writeJson(join(f.home,'.claude/.claude.json'),{mcpServers:{fake:{command:process.execPath,args:[f.script]}}});
 const cmd=mcpClientCommands(f.ctx),key=await keyOf(f.registry,'fake');
 t.after(()=>cmd.mcp_disconnect({key}));
 const pid=async()=>(await cmd.mcp_call_tool({key,tool:'echo',arguments:{text:'x'}})).structured.pid;
 await cmd.mcp_connect({key});const first=await pid();
 const reused=await cmd.mcp_connect({key});
 // A reused connection reports the config name and re-lists.
 assert.equal(reused.server_name,'fake');assert.equal(reused.server_version,null);assert.deepEqual(reused.capabilities,['tools']);assert.deepEqual(reused.tools.map(x=>x.name),['echo','second']);
 assert.equal(await pid(),first);
 const refreshed=await cmd.mcp_connect({key,refresh:true});assert.equal(refreshed.server_version,'9.9');
 const second=await pid();assert.notEqual(second,first);
 assert.throws(()=>process.kill(first,0));
 await cmd.mcp_disconnect({key});
 assert.deepEqual(await cmd.mcp_connected(),[]);
 await new Promise(r=>setTimeout(r,100));
 assert.throws(()=>process.kill(second,0));
 // A call on a disconnected key opens a fresh connection on demand.
 assert.notEqual(await pid(),second);
});

test('errors: JSON-RPC errors, a dying tool, a dying server and an unknown key',async t=>{
 const f=await fixture();t.after(f.cleanup);
 await writeJson(join(f.home,'.claude/.claude.json'),{mcpServers:{fake:{command:process.execPath,args:[f.script]},dies:{command:process.execPath,args:[f.dying]},missing:{command:join(f.base,'nope')}}});
 const cmd=mcpClientCommands(f.ctx),key=await keyOf(f.registry,'fake');
 t.after(()=>cmd.mcp_disconnect({key}));
 await cmd.mcp_connect({key});
 const err=await cmd.mcp_call_tool({key,tool:'die'}).catch(e=>e);
 assert.match(err.message,/^tools\/call failed: the server closed its output/);
 assert.match(err.message,/fatal: going away/);
 assert.deepEqual(await cmd.mcp_connected(),[]);
 await assert.rejects(cmd.mcp_connect({key:await keyOf(f.registry,'dies')}),e=>/closed its output/.test(e.message)&&/BROWSERBASE_API_KEY is required/.test(e.message));
 await assert.rejects(cmd.mcp_connect({key:await keyOf(f.registry,'missing')}),/could not start `.*nope`/);
 await assert.rejects(cmd.mcp_connect({key:'cmd:not configured'}),{message:'this server is no longer in any config — refresh the panel'});
 await assert.rejects(cmd.mcp_connect({key:''}),/Choose an MCP server/);
 assert.deepEqual(await cmd.mcp_connected(),[]);
});

test('a project server resolves from the folders the panel listed and runs in its checkout',async t=>{
 const f=await fixture();t.after(f.cleanup);
 await writeJson(join(f.project,'.mcp.json'),{mcpServers:{proj:{command:process.execPath,args:[f.script,'legacy'],env:{FAKE_TOKEN:'p'}}}});
 const cmd=mcpClientCommands(f.ctx);
 const key=await keyOf(f.registry,'proj',[f.project]);
 t.after(()=>cmd.mcp_disconnect({key}));
 await cmd.mcp_connect({key});
 assert.equal((await cmd.mcp_call_tool({key,tool:'env'})).content[0].text,`p|${f.home}|${f.project}`);
});

test('the idle reaper kills unused connections',async t=>{
 const f=await fixture();t.after(f.cleanup);
 await writeJson(join(f.home,'.claude/.claude.json'),{mcpServers:{fake:{command:process.execPath,args:[f.script]}}});
 const cmd=mcpClientCommands({...f.ctx,mcpIdleTimeout:50,mcpReapEvery:25}),key=await keyOf(f.registry,'fake');
 t.after(()=>cmd.mcp_disconnect({key}));
 await cmd.mcp_connect({key});
 const pid=(await cmd.mcp_call_tool({key,tool:'echo',arguments:{text:'x'}})).structured.pid;
 await new Promise(r=>setTimeout(r,250));
 assert.deepEqual(await cmd.mcp_connected(),[]);
 assert.throws(()=>process.kill(pid,0));
});

test('a modern stdio server: discovery metadata, tasks and the -32022 refusal',async t=>{
 const f=await fixture();t.after(f.cleanup);
 await writeJson(join(f.home,'.claude/.claude.json'),{mcpServers:{modern:{command:process.execPath,args:[f.script,'modern']}}});
 const cmd=mcpClientCommands(f.ctx),key=await keyOf(f.registry,'modern');
 t.after(()=>cmd.mcp_disconnect({key}));
 const session=await cmd.mcp_connect({key});
 assert.equal(session.protocol_version,'2026-07-28');assert.equal(session.server_name,'modern-fake');assert.equal(session.instructions,'modern');
 const task=await cmd.mcp_call_tool({key,tool:'slowtask'});
 assert.deepEqual(task.task,{resultType:'task',task:{taskId:'t1',status:'working'}});
 assert.deepEqual(await cmd.mcp_task_get({key,taskId:'t1'}),{resultType:'complete',taskId:'t1',status:'completed'});
 await assert.rejects(cmd.mcp_task_cancel({key,taskId:'t1'}),/tasks\/cancel failed: no such method \(code -32601\)/);
 await writeJson(join(f.home,'.claude/.claude.json'),{mcpServers:{refuse:{command:process.execPath,args:[f.script,'refuse']}}});
 // -32020..-32022 on discovery is a modern server refusing us, not a legacy one: no fallback.
 await assert.rejects(cmd.mcp_connect({key:await keyOf(f.registry,'refuse')}),e=>e.message.startsWith('server/discover failed: unsupported version (code -32022)'));
});

test('streamable HTTP: legacy session ids, SSE replies, and modern headers',async t=>{
 const f=await fixture();t.after(f.cleanup);
 const seen=[];
 const server=createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{
  const msg=JSON.parse(body),modern=req.url==='/modern';seen.push({url:req.url,method:msg.method,headers:req.headers});
  const json=(status,value,extra={})=>{res.writeHead(status,{'content-type':'application/json',...extra});res.end(JSON.stringify(value));};
  if(msg.id==null){res.writeHead(202);return res.end();}
  if(msg.method==='server/discover'){
   if(!modern)return json(400,{jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Method not found'}});
   return json(200,{jsonrpc:'2.0',id:msg.id,result:{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'web-modern'}}}});
  }
  if(msg.method==='initialize')return json(200,{jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'web',version:'2'}}},{'mcp-session-id':'sess-1'});
  const done=r=>modern?{resultType:'complete',...r}:r;
  if(msg.method==='tools/list'){res.writeHead(200,{'content-type':'text/event-stream'});res.end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\ndata: ${JSON.stringify({jsonrpc:'2.0',id:msg.id,result:done({tools:[{name:'get',inputSchema:{type:'object',properties:{region:{type:'string','x-mcp-header':'Region'}}}}]})})}\n\n`);return;}
  if(msg.method==='tools/call'){if(msg.params.name==='bad')return json(401,{message:'token expired'});return json(200,{jsonrpc:'2.0',id:msg.id,result:done({content:[{type:'text',text:'ok'}]})});}
  json(200,{jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'nope'}});
 });});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`;
 await mkdir(join(f.home,'.cursor'),{recursive:true});
 await writeJson(join(f.home,'.cursor/mcp.json'),{mcpServers:{web:{url:base+'/legacy',headers:{Authorization:'Bearer abc'}},webm:{url:base+'/modern'}}});
 const cmd=mcpClientCommands(f.ctx),legacy=await keyOf(f.registry,'web'),modern=await keyOf(f.registry,'webm');
 t.after(()=>Promise.all([cmd.mcp_disconnect({key:legacy}),cmd.mcp_disconnect({key:modern})]));

 const session=await cmd.mcp_connect({key:legacy});
 assert.equal(session.server_name,'web');assert.deepEqual(session.tools.map(x=>x.name),['get']);
 assert.equal((await cmd.mcp_call_tool({key:legacy,tool:'get',arguments:{region:'eu'}})).content[0].text,'ok');
 const call=seen.findLast(s=>s.url==='/legacy'&&s.method==='tools/call');
 assert.equal(call.headers['mcp-session-id'],'sess-1');assert.equal(call.headers.authorization,'Bearer abc');
 assert.equal(call.headers['mcp-protocol-version'],'2025-06-18');assert.equal(call.headers['mcp-param-region'],undefined);
 await assert.rejects(cmd.mcp_call_tool({key:legacy,tool:'bad'}),/tools\/call failed: the server answered 401 Unauthorized: \{"message":"token expired"\}/);

 const m=await cmd.mcp_connect({key:modern});
 assert.equal(m.protocol_version,'2026-07-28');assert.equal(m.server_name,'web-modern');
 await cmd.mcp_call_tool({key:modern,tool:'get',arguments:{region:'日本'}});
 const mc=seen.findLast(s=>s.url==='/modern'&&s.method==='tools/call');
 assert.equal(mc.headers['mcp-method'],'tools/call');assert.equal(mc.headers['mcp-name'],'get');
 assert.equal(mc.headers['mcp-param-region'],`=?base64?${Buffer.from('日本').toString('base64')}?=`);
 assert.equal(mc.headers['mcp-session-id'],undefined);
});

test('pure helpers: HTTP body framing, schema bounds, header params, Codex TOML values',()=>{
 assert.deepEqual(parseHttpBody('{"jsonrpc":"2.0","id":7,"result":{}}',7).result,{});
 assert.equal(parseHttpBody('[{"id":1,"result":{}},{"id":7,"result":{"mine":true}}]',7).result.mine,true);
 assert.equal(parseHttpBody('data: {"id":4,"result":{}}\n\ndata: {"id":7,"result":{"mine":true}}\n',7).result.mine,true);
 assert.throws(()=>parseHttpBody('<html>gateway timeout</html>',7),/could not be read/);
 assert.throws(()=>schemaSafety({$ref:'https://x'}),/external \$ref/);
 let deep={};for(let i=0;i<70;i++)deep={a:deep};assert.throws(()=>schemaSafety(deep),/depth 64/);
 assert.deepEqual(toolHeaderParams({properties:{region:{type:'string','x-mcp-header':'Region'}}}),[{argument:'region',header:'Region'}]);
 assert.throws(()=>toolHeaderParams({properties:{o:{type:'object','x-mcp-header':'O'}}}),/primitive/);
 assert.deepEqual(tomlEndpoint('[mcp_servers.gh]\ncommand = "npx"\nargs = ["-y", "gh-mcp"]\n[mcp_servers.gh.env]\nGH_TOKEN = "ghp_x"\n','gh'),{transport:'stdio',command:'npx',args:['-y','gh-mcp'],url:null,env:{GH_TOKEN:'ghp_x'}});
});
