import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath,stat,chmod} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {McpRegistry,dedupeKey,redactArgs,redactUrl,parseCodexToml,codexTomlWithSource,mcpjsonStatus} from './mcp-servers.mjs';
import {WorkspaceProfiles} from './profiles.mjs';

// A temporary home and workspace standing in for /home/agent and /workspace,
// with the same containment check native.mjs applies to project roots.
async function fixture(){
 const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-mcp-servers-')));
 const home=base+'/home',workspace=base+'/workspace',outside=base+'/outside';
 for(const dir of [home,workspace,outside])await mkdir(dir,{recursive:true});
 const scoped=async value=>{const resolved=await realpath(path.resolve(workspace,value));if(resolved!==workspace&&!resolved.startsWith(workspace+'/'))throw Error('Path outside selected workspace');return resolved;};
 const profiles=new WorkspaceProfiles(home);
 const registry=new McpRegistry({home,workspace,scoped,profiles});
 const put=async(file,body)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,typeof body==='string'?body:JSON.stringify(body));};
 return {base,home,workspace,outside,registry,profiles,put,cleanup:()=>rm(base,{recursive:true,force:true})};
}
const stdio=(command,args)=>({transport:'stdio',command,args,url:null,envKeys:[],enabled:true});

test('MCP identity folds launch noise and keeps distinct packages and pins apart',()=>{
 assert.equal(dedupeKey(stdio('/usr/local/bin/canopy-hook',['--mcp'])),dedupeKey(stdio('canopy-hook',['--mcp'])));
 assert.equal(dedupeKey(stdio('npx',['-y','@mastra/mcp-docs-server'])),dedupeKey(stdio('npx',['@mastra/mcp-docs-server@latest'])));
 assert.notEqual(dedupeKey(stdio('npx',['@playwright/mcp'])),dedupeKey(stdio('npx',['@mastra/mcp-docs-server'])));
 assert.notEqual(dedupeKey(stdio('npx',['@playwright/mcp@1.2.3'])),dedupeKey(stdio('npx',['@playwright/mcp@latest'])));
 const url=q=>({...stdio(null,[]),command:null,url:`https://user:pw@Example.com/mcp/?token=${q}`});
 assert.equal(dedupeKey(url('aaa')),dedupeKey(url('bbb')));
 assert.equal(dedupeKey(url('aaa')),'url:https://example.com/mcp');
});

test('credentials in argv and URLs are redacted before a row is built',()=>{
 assert.deepEqual(redactArgs(['--api-key=bb_live_secretvalue','--token','hunter2','--headless']),['--api-key=***','--token','***','--headless']);
 const url=redactUrl('https://bot:hunter2@mcp.example.com/sse?api_key=hunter3&region=eu');
 assert.ok(!url.includes('hunter2')&&!url.includes('hunter3'),url);
 assert.ok(url.includes('region=eu')&&url.includes('mcp.example.com/sse'),url);
 assert.equal(redactUrl('not a url?token=hunter4'),'not a url');
});

test('Codex TOML tables parse without reading project paths or env values',()=>{
 const servers=parseCodexToml(`model = "gpt-5"\n[mcp_servers]\n[mcp_servers.MCP_DOCKER]\ncommand = 'docker'\nargs = ['mcp', 'gateway', 'run']\n\n[projects.'/workspace/app.v2']\ntrust_level = 'trusted'\n\n[mcp_servers.canopy]\ncommand = "/usr/local/bin/canopy-hook"\nargs = ["--mcp"]\n\n[mcp_servers.canopy.env]\nCANOPY_CTX_PORT = "1234"\n`);
 assert.deepEqual(servers.map(([name])=>name),['MCP_DOCKER','canopy']);
 assert.deepEqual(servers[0][1].args,['mcp','gateway','run']);
 assert.deepEqual(servers[1][1].envKeys,['CANOPY_CTX_PORT']);
 assert.ok(!JSON.stringify(servers).includes('1234'));
});

test('Codex removal drops one server and its child tables; enabling drops a retained flag',()=>{
 const raw='model = "gpt-5"\n\n[mcp_servers.linear]\nurl = "https://linear.test/mcp"\nenabled = false\n\n[mcp_servers.linear.env]\nLINEAR_KEY = "secret"\n\n[mcp_servers.docs]\ncommand = "docs"\n';
 const removed=codexTomlWithSource(raw,'linear',false);
 assert.ok(!removed.includes('linear')&&!removed.includes('secret'));
 assert.ok(removed.includes('[mcp_servers.docs]')&&removed.includes('model = "gpt-5"'));
 const enabled=codexTomlWithSource(raw,'linear',true);
 assert.ok(enabled.includes('[mcp_servers.linear]')&&!enabled.includes('enabled = false')&&enabled.includes('LINEAR_KEY = "secret"'));
 assert.equal(codexTomlWithSource('[mcp_servers.docs]\ncommand = "docs"\n','docs',true),null);
 assert.throws(()=>codexTomlWithSource(raw,'missing',false),/no longer contains/);
});

test('an unanswered .mcp.json server is pending, not enabled',()=>{
 assert.equal(mcpjsonStatus({enabledMcpjsonServers:[],disabledMcpjsonServers:[]},'linear'),'pending');
 assert.equal(mcpjsonStatus(undefined,'linear'),'pending');
 assert.equal(mcpjsonStatus({enabledMcpjsonServers:['linear']},'linear'),'enabled');
 assert.equal(mcpjsonStatus({disabledMcpjsonServers:['linear']},'linear'),'disabled');
 assert.equal(mcpjsonStatus({enableAllProjectMcpServers:true},'linear'),'enabled');
});

test('discovery reads the workspace account and project, folds CLIs, and never returns env values',async()=>{
 const f=await fixture();try{
  const project=f.workspace+'/app';await mkdir(project);
  await f.put(f.home+'/.cursor/mcp.json',{mcpServers:{browserbase:{command:'npx',args:['@browserbasehq/mcp-server-browserbase'],env:{BROWSERBASE_API_KEY:'bb_live_synthetic_value'}}}});
  await f.put(f.home+'/.codeium/windsurf/mcp_config.json',{mcpServers:{bb:{command:'/usr/bin/npx',args:['-y','@browserbasehq/mcp-server-browserbase']},mastra:{command:'npx',args:['-y','@mastra/mcp-docs-server']}}});
  await f.put(f.home+'/.claude/.claude.json',{oauthAccount:{emailAddress:'synthetic@example.com'},mcpServers:{remote:{type:'sse',url:'https://mcp.example.com/sse?token=synthetic-url-token',headers:{Authorization:'Bearer synthetic-header'}}},projects:{[project]:{disabledMcpjsonServers:['linear'],mcpServers:{local:{command:'local-mcp'}}}}});
  await f.put(f.home+'/.codex/config.toml','[mcp_servers.docs]\ncommand = "docs"\nenabled = false\n[mcp_servers.docs.env]\nDOCS_TOKEN = "synthetic-toml-secret"\n');
  await f.put(f.home+'/.config/opencode/opencode.json',{mcp:{docs:{type:'local',command:['docs'],enabled:true}}});
  await f.put(project+'/.mcp.json',{mcpServers:{linear:{type:'http',url:'https://mcp.linear.app/mcp'},fresh:{command:'fresh-mcp'}}});
  await f.put(f.home+'/.gemini/settings.json','{ broken');
  const servers=await f.registry.servers(['app']);
  const rendered=JSON.stringify(servers);
  for(const secret of ['bb_live_synthetic_value','synthetic-url-token','synthetic-header','synthetic-toml-secret','synthetic@example.com'])assert.ok(!rendered.includes(secret),secret);
  const byName=Object.fromEntries(servers.map(s=>[s.name,s]));
  assert.deepEqual(servers.map(s=>s.name),['remote','docs','browserbase','mastra','local','linear','fresh']);
  assert.equal(byName.browserbase.sources.length,2);
  assert.deepEqual(byName.browserbase.env_keys,['BROWSERBASE_API_KEY']);
  assert.deepEqual(byName.remote.env_keys,['Authorization']);
  assert.equal(byName.remote.transport,'sse');
  // Off in Codex, on in OpenCode: live, and the sources say where.
  assert.deepEqual(byName.docs.sources.map(s=>[s.agent,s.status]),[['opencode','enabled'],['codex','disabled']]);
  assert.ok(byName.docs.enabled);
  assert.equal(byName.linear.sources[0].status,'disabled');
  assert.equal(byName.fresh.sources[0].status,'pending');
  assert.equal(byName.local.sources[0].project_dir,project);
  assert.equal(byName.local.sources[0].config_path,f.home+'/.claude/.claude.json');
  // No project roots: user scope only.
  assert.deepEqual((await f.registry.servers([])).map(s=>s.name),['remote','docs','browserbase','mastra']);
 }finally{await f.cleanup();}
});

test('account profiles contribute only the CLIs they isolate',async()=>{
 const f=await fixture();try{
  const {root}=await f.profiles.create('Work');
  await f.put(root+'/.claude/.claude.json',{mcpServers:{work:{command:'work-mcp'}}});
  await f.put(root+'/.cursor/mcp.json',{mcpServers:{ignored:{command:'ignored-mcp'}}});
  const servers=await f.registry.servers([]);
  assert.deepEqual(servers.map(s=>[s.name,s.sources[0].label]),[['work','Claude Code (global) · work']]);
 }finally{await f.cleanup();}
});

test('project roots and config symlinks cannot leave the workspace account',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.registry.servers(['../outside']),/outside/);
  await assert.rejects(f.registry.servers('/workspace'),/Choose project/);
  await f.put(f.outside+'/mcp.json',{mcpServers:{escaped:{command:'escaped-mcp'}}});
  await mkdir(f.workspace+'/app');await symlink(f.outside+'/mcp.json',f.workspace+'/app/.mcp.json');
  await mkdir(f.home+'/.cursor');await symlink(f.outside+'/mcp.json',f.home+'/.cursor/mcp.json');
  assert.deepEqual(await f.registry.servers(['app']),[]);
 }finally{await f.cleanup();}
});

test('updates rediscover their target, preserve unrelated settings, and keep file modes',async()=>{
 const f=await fixture();try{
  const cursor=f.home+'/.cursor/mcp.json';
  await f.put(cursor,{mcpServers:{linear:{url:'https://linear.test/mcp'},docs:{command:'docs'}},theme:'dark'});await chmod(cursor,0o600);
  const codex=f.home+'/.codex/config.toml';
  await f.put(codex,'# keep me\nmodel = "gpt-5"\n\n[mcp_servers.linear]\nurl = "https://linear.test/mcp"\n\n[mcp_servers.docs]\ncommand = "docs"\nenabled = false\n');
  const opencode=f.home+'/.config/opencode/opencode.json';
  await f.put(opencode,{mcp:{docs:{type:'local',command:['docs'],enabled:false}}});
  const change=(agent,name,configPath,enabled)=>({agent,name,configPath,scope:'global',enabled});
  const servers=await f.registry.update([],[change('cursor','linear',cursor,false),change('codex','docs',codex,true),change('opencode','docs',opencode,true),change('codex','linear',codex,true)]);
  const config=JSON.parse(await readFile(cursor,'utf8'));
  assert.equal(config.mcpServers.linear,undefined);assert.equal(config.mcpServers.docs.command,'docs');assert.equal(config.theme,'dark');
  assert.equal((await stat(cursor)).mode&0o777,0o600);
  const toml=await readFile(codex,'utf8');assert.ok(toml.startsWith('# keep me\n')&&!toml.includes('enabled = false')&&toml.includes('[mcp_servers.linear]'));
  assert.equal(JSON.parse(await readFile(opencode,'utf8')).mcp.docs.enabled,undefined);
  const linear=servers.find(s=>s.name==='linear');assert.deepEqual(linear.sources.map(s=>s.agent),['codex']);
 }finally{await f.cleanup();}
});

test('updates refuse invented paths, pending approvals, the managed bridge, and symlinked configs',async()=>{
 const f=await fixture();try{
  const project=f.workspace+'/app';
  await f.put(project+'/.mcp.json',{mcpServers:{fresh:{command:'fresh-mcp'}}});
  await f.put(f.home+'/.claude/.claude.json',{mcpServers:{canopy:{type:'stdio',command:'/usr/local/bin/canopy-hook',args:['--mcp']}}});
  const other=f.workspace+'/other.json';await f.put(other,{mcpServers:{x:{command:'x'}}});
  await assert.rejects(f.registry.update(['app'],[{agent:'cursor',name:'x',configPath:other,scope:'global',enabled:false}]),/no longer configures/);
  assert.ok((await readFile(other,'utf8')).includes('"x"'));
  await assert.rejects(f.registry.update(['app'],[{agent:'claude',name:'fresh',configPath:project+'/.mcp.json',scope:'project',projectDir:project,enabled:false}]),/waiting for approval/);
  await assert.rejects(f.registry.update([],[{agent:'claude',name:'canopy',configPath:f.home+'/.claude/.claude.json',scope:'global',enabled:false}]),/managed from Settings/);
  await assert.rejects(f.registry.update([],[{agent:'claude',name:'canopy',configPath:7,scope:'global',enabled:false}]),/Invalid MCP changes/);
  const real=f.home+'/real-windsurf.json';await f.put(real,{mcpServers:{w:{command:'w'}}});
  await mkdir(f.home+'/.codeium/windsurf',{recursive:true});const link=f.home+'/.codeium/windsurf/mcp_config.json';await symlink(real,link);
  await assert.rejects(f.registry.update([],[{agent:'windsurf',name:'w',configPath:link,scope:'global',enabled:false}]),/symlink/);
  assert.ok((await readFile(real,'utf8')).includes('"w"'));
 }finally{await f.cleanup();}
});

test('Claude per-project servers are removed from the nested state map only',async()=>{
 const f=await fixture();try{
  const project=f.workspace+'/app';await mkdir(project);
  const state=f.home+'/.claude/.claude.json';
  await f.put(state,{oauthAccount:{emailAddress:'synthetic@example.com'},projects:{[project]:{mcpServers:{local:{command:'local-mcp'},keep:{command:'keep-mcp'}},allowedTools:['Read']}}});
  await f.registry.update(['app'],[{agent:'claude',name:'local',configPath:state,scope:'project',projectDir:project,enabled:false}]);
  const saved=JSON.parse(await readFile(state,'utf8'));
  assert.deepEqual(Object.keys(saved.projects[project].mcpServers),['keep']);
  assert.deepEqual(saved.projects[project].allowedTools,['Read']);
  assert.equal(saved.oauthAccount.emailAddress,'synthetic@example.com');
 }finally{await f.cleanup();}
});
