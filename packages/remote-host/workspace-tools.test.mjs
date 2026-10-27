import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {resolveWorkspacePath} from './workspace-file-paths.mjs';
import {safeGitRead,GIT_READ_COMMANDS} from './git-read.mjs';
import {workspaceToolsCommands,WORKSPACE_TOOLS_READ_ONLY} from './workspace-tools.mjs';

const execute=promisify(execFile);
async function fixture(){
 const base=await realpath(await mkdtemp(join(tmpdir(),'ws-tools-'))),root=join(base,'workspace'),home=join(base,'home'),bin=join(base,'bin');
 await mkdir(root);await mkdir(home);await mkdir(bin);
 const calls=[];
 const run=async(cmd,argv,cwd=root,timeout=15000)=>{calls.push([cmd,...argv]);const options={allowedRoot:root,cwd:await resolveWorkspacePath(cwd,{workspace:root}),timeout,env:{...process.env,PATH:bin+':'+process.env.PATH,HOME:home}};try{return (await (cmd==='git'&&GIT_READ_COMMANDS.has(argv[0])?safeGitRead(execute,argv,options):execute(cmd,argv,options))).stdout;}catch(error){throw Error(String(error.stderr||'Workspace command failed'));}};
 const ctx={run,execute,home,root,scoped:(v,create=false)=>resolveWorkspacePath(v,{workspace:root,create})};
 const put=async(rel,body='x')=>{const p=join(base,rel);await mkdir(join(p,'..'),{recursive:true});await writeFile(p,body);return p;};
 return {base,root,home,bin,calls,ctx,put,tools:workspaceToolsCommands(ctx),done:()=>rm(base,{recursive:true,force:true})};
}

test('read-only list names only reading commands',()=>{
 assert.deepEqual(WORKSPACE_TOOLS_READ_ONLY.sort(),['instructions_read','instructions_scan','model_catalog','probe_http_readiness']);
});

test('instructions_scan lists project and home files with the desktop shape',async()=>{
 const f=await fixture();
 try{
  const proj=join(f.root,'app');
  await f.put('workspace/app/CLAUDE.md','# hi');
  await f.put('workspace/app/packages/api/AGENTS.md','nested');
  await f.put('workspace/app/node_modules/x/AGENTS.md','vendored');
  await f.put('workspace/app/.claude/skills/pdf/SKILL.md','---\nname: "PDF tools"\ndescription: reads pdfs\n---\nbody');
  await f.put('home/.claude/CLAUDE.md','global');
  await f.put('home/.ssh/id_rsa','secret');
  const rows=await f.tools.instructions_scan({roots:[proj]});
  const by=l=>rows.find(r=>r.label===l);
  assert.equal(by('AGENTS.md').exists,false);
  assert.equal(by('packages/api/AGENTS.md').exists,true);
  assert.ok(!rows.some(r=>r.path.includes('node_modules')));
  assert.deepEqual(Object.keys(by('CLAUDE.md')).sort(),['agents','bytes','description','exists','kind','label','modified','path','root','scope','title'].sort());
  assert.equal(by('CLAUDE.md').root,proj);assert.equal(by('CLAUDE.md').bytes,4);
  const skill=by('.claude/skills/pdf/SKILL.md');
  assert.equal(skill.title,'PDF tools');assert.equal(skill.description,'reads pdfs');assert.equal(skill.kind,'skill');
  const global=by('~/.claude/CLAUDE.md');
  assert.equal(global.scope,'global');assert.equal(global.root,'');assert.equal(global.exists,true);
  assert.ok(!rows.some(r=>r.path.includes('.ssh')));
  // A root outside the workspace is skipped, not scanned.
  const outside=await f.tools.instructions_scan({roots:[f.home]});
  assert.ok(outside.every(r=>r.scope==='global'));
 }finally{await f.done();}
});

test('symlinked skills merge into one row and links out of the workspace are dropped',async()=>{
 const f=await fixture();
 try{
  const proj=join(f.root,'app');
  await f.put('workspace/shared/caveman/SKILL.md','---\nname: caveman\n---');
  await mkdir(join(proj,'.claude/skills'),{recursive:true});await mkdir(join(proj,'.github/skills'),{recursive:true});
  await symlink(join(f.root,'shared/caveman'),join(proj,'.claude/skills/caveman'));
  await symlink(join(f.root,'shared/caveman'),join(proj,'.github/skills/caveman'));
  await f.put('outside/leak/SKILL.md','---\nname: leaked\n---');
  await symlink(join(f.base,'outside/leak'),join(proj,'.claude/skills/leak'));
  const rows=await f.tools.instructions_scan({roots:[proj]});
  const skills=rows.filter(r=>r.kind==='skill');
  assert.equal(skills.length,1);assert.equal(skills[0].title,'caveman');
  await assert.rejects(f.tools.instructions_read({path:join(proj,'.claude/skills/leak/SKILL.md'),roots:[proj]}),/not an agent instruction file/);
  assert.match(await f.tools.instructions_read({path:join(proj,'.github/skills/caveman/SKILL.md'),roots:[proj]}),/caveman/);
 }finally{await f.done();}
});

test('instructions_read/write go through the gate',async()=>{
 const f=await fixture();
 try{
  const proj=join(f.root,'app');await mkdir(proj);
  await f.put('workspace/app/README.md','not mine');
  // Create a missing root file and a new skill (its directory too).
  await f.tools.instructions_write({path:join(proj,'AGENTS.md'),roots:[proj],content:'agents'});
  assert.equal(await readFile(join(proj,'AGENTS.md'),'utf8'),'agents');
  await f.tools.instructions_write({path:join(proj,'.claude/skills/new/SKILL.md'),roots:[proj],content:'s'});
  await f.tools.instructions_write({path:join(proj,'packages/web/CLAUDE.md'),roots:[proj],content:'n'});
  assert.equal(await f.tools.instructions_read({path:join(proj,'.claude/skills/new/SKILL.md'),roots:[proj]}),'s');
  await assert.rejects(f.tools.instructions_read({path:join(proj,'README.md'),roots:[proj]}),/not an agent instruction file/);
  await assert.rejects(f.tools.instructions_write({path:join(proj,'node_modules/x/AGENTS.md'),roots:[proj],content:'v'}),/not an agent instruction file/);
  await assert.rejects(f.tools.instructions_read({path:join(proj,'../app/../../home/.ssh/id_rsa'),roots:[proj]}),/not an agent instruction file/);
  // Home: exactly the table's files.
  await f.tools.instructions_write({path:join(f.home,'.claude/CLAUDE.md'),roots:[],content:'g'});
  assert.equal(await f.tools.instructions_read({path:join(f.home,'.claude/CLAUDE.md'),roots:[]}),'g');
  await f.put('home/.claude/settings.json','{}');
  await assert.rejects(f.tools.instructions_read({path:join(f.home,'.claude/settings.json'),roots:[]}),/not an agent instruction file/);
  // A project CLAUDE.local.md linked out of the workspace is refused.
  await f.put('outside/secret.md','s');await symlink(join(f.base,'outside/secret.md'),join(proj,'CLAUDE.local.md'));
  await assert.rejects(f.tools.instructions_read({path:join(proj,'CLAUDE.local.md'),roots:[proj]}),/not an agent instruction file/);
  // A root outside the workspace grants nothing.
  await assert.rejects(f.tools.instructions_write({path:join(f.base,'outside/AGENTS.md'),roots:[join(f.base,'outside')],content:'x'}),/not an agent instruction file/);
  await assert.rejects(f.tools.instructions_write({path:join(proj,'AGENTS.md'),roots:'nope',content:'x'}),/invalid roots/);
 }finally{await f.done();}
});

test('model_catalog runs only the allowlisted omp argv',async()=>{
 const f=await fixture();
 try{
  await writeFile(join(f.bin,'omp'),'#!/bin/sh\necho "{\\"argv\\":\\"$*\\"}"\n');await chmod(join(f.bin,'omp'),0o755);
  assert.equal((await f.tools.model_catalog({donor:'omp',query:0})).trim(),'{"argv":"models --json"}');
  assert.equal(await f.tools.model_catalog({donor:'omp',query:1}),null);
  assert.equal(await f.tools.model_catalog({donor:'aider',query:0}),null);
  assert.equal(await f.tools.model_catalog({donor:'sh',query:0}),null);
  assert.deepEqual(f.calls,[['omp','models','--json']]);
  await writeFile(join(f.bin,'omp'),'#!/bin/sh\nexit 3\n');
  assert.equal(await f.tools.model_catalog({donor:'omp',query:0}),null);
 }finally{await f.done();}
});

test('probe_http_readiness accepts 2xx/3xx only and validates the path',async()=>{
 const f=await fixture();
 const server=http.createServer((req,res)=>{res.statusCode=req.url==='/ok'?200:req.url==='/moved'?302:503;if(res.statusCode===302)res.setHeader('location','http://example.com/');res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port;
 try{
  assert.equal(await f.tools.probe_http_readiness({port,path:'/ok'}),true);
  assert.equal(await f.tools.probe_http_readiness({port,path:'/moved'}),true);
  assert.equal(await f.tools.probe_http_readiness({port,path:'/down'}),false);
  server.close();
  assert.equal(await f.tools.probe_http_readiness({port,path:'/ok'}),false);
  for(const p of ['','ok','//evil.example/','/a\nb'])await assert.rejects(f.tools.probe_http_readiness({port,path:p}),/HTTP readiness path must be a local absolute path/);
  await assert.rejects(f.tools.probe_http_readiness({port:70000,path:'/'}),/invalid port/);
 }finally{server.close();await f.done();}
});

test('kill_process kills own-uid processes and refuses system pids',async()=>{
 const f=await fixture();
 try{
  const child=spawn('sleep',['30']);
  const exited=new Promise(r=>child.on('exit',(code,signal)=>r(signal)));
  assert.equal(await f.tools.kill_process({pid:child.pid}),null);
  assert.equal(await exited,'SIGKILL');
  for(const pid of [0,1,process.pid,process.ppid])await assert.rejects(f.tools.kill_process({pid}),/Refusing/);
  await assert.rejects(f.tools.kill_process({pid:-5}),/invalid pid/);
  await assert.rejects(f.tools.kill_process({pid:4194304+7}),/No such process/);
 }finally{await f.done();}
});
