import {readdir,stat,lstat,realpath,readFile,writeFile,mkdir,open} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
// Mirrors src-tauri/src/instructions.rs (agent instruction files), and the
// model_catalog / probe_http_readiness / kill_process commands of agents.rs,
// for a Linux workspace. Instruction paths are gated by the same spec table as
// desktop, but every hit must also resolve inside /workspace (project files) or
// the VM home (the global files of that table, and nothing else there).

const AGENTS_MD=['claude','codex','cursor-agent','copilot','gemini','amp','aider','opencode','goose','qwen','droid','omp'];
const SKILL_MD=['claude','codex','cursor-agent','copilot','gemini','opencode','goose','droid','qwen'];
const CLAUDE=['claude'],CODEX=['codex'],GEMINI=['gemini','agy'],CURSOR=['cursor-agent'],COPILOT=['copilot'],OPENCODE=['opencode'],GOOSE=['goose'],QWEN=['qwen'],DROID=['droid'],AMP=['amp'],AIDER=['aider'],WINDSURF=['windsurf'],JUNIE=['junie'],CLINE=['cline'],KIRO=['kiro'],ROO=['roo'],CONTINUE=['continue'],ZED=['zed'];
const MAX_NEST=4,MAX_BYTES=2*1024*1024;
const SKIP_DIRS=['node_modules','.git','dist','build','out','target','vendor','.venv','venv','__pycache__','.next','.cache','coverage'];
const file=rel=>({t:'file',rel}),dir=(rel,ext)=>({t:'dir',rel,ext}),pack=(rel,name)=>({t:'pack',rel,name}),nested=name=>({t:'nested',name});
const P=(loc,kind,agents)=>({loc,kind,agents,scope:'project'}),G=(loc,kind,agents)=>({loc,kind,agents,scope:'global'});
// Same rows, same order as instructions.rs `specs()`.
const SPECS=[
 P(nested('AGENTS.md'),'instructions',AGENTS_MD),P(file('AGENTS.override.md'),'instructions',CODEX),P(nested('CLAUDE.md'),'instructions',CLAUDE),P(file('CLAUDE.local.md'),'instructions',CLAUDE),
 P(file('GEMINI.md'),'instructions',GEMINI),P(file('AGENT.md'),'instructions',AMP),P(file('QWEN.md'),'instructions',QWEN),P(file('CONVENTIONS.md'),'instructions',AIDER),
 P(dir('.claude/rules','md'),'rule',CLAUDE),P(pack('.claude/skills','SKILL.md'),'skill',SKILL_MD),P(dir('.claude/agents','md'),'subagent',CLAUDE),P(dir('.claude/commands','md'),'command',CLAUDE),P(dir('.claude/output-styles','md'),'style',CLAUDE),
 P(dir('.cursor/rules','mdc'),'rule',CURSOR),P(file('.cursorrules'),'instructions',CURSOR),P(file('.github/copilot-instructions.md'),'instructions',COPILOT),P(dir('.github/instructions','md'),'rule',COPILOT),
 P(dir('.github/prompts','md'),'command',COPILOT),P(pack('.github/skills','SKILL.md'),'skill',SKILL_MD),P(file('.goosehints'),'instructions',GOOSE),P(file('.windsurfrules'),'instructions',WINDSURF),
 P(dir('.windsurf/rules','md'),'rule',WINDSURF),P(file('.junie/guidelines.md'),'instructions',JUNIE),P(dir('.clinerules','md'),'rule',CLINE),P(dir('.kiro/steering','md'),'rule',KIRO),
 P(dir('.roo/rules','md'),'rule',ROO),P(dir('.continue/rules','md'),'rule',CONTINUE),P(file('.rules'),'instructions',ZED),
 G(file('.claude/CLAUDE.md'),'instructions',CLAUDE),G(dir('.claude/rules','md'),'rule',CLAUDE),G(pack('.claude/skills','SKILL.md'),'skill',CLAUDE),G(dir('.claude/agents','md'),'subagent',CLAUDE),
 G(dir('.claude/commands','md'),'command',CLAUDE),G(dir('.claude/output-styles','md'),'style',CLAUDE),G(file('.codex/AGENTS.md'),'instructions',CODEX),G(file('.codex/AGENTS.override.md'),'instructions',CODEX),
 G(dir('.codex/rules','rules'),'rule',CODEX),G(dir('.codex/rules','md'),'rule',CODEX),G(pack('.codex/skills','SKILL.md'),'skill',CODEX),G(file('.gemini/GEMINI.md'),'instructions',GEMINI),
 G(pack('.gemini/skills','SKILL.md'),'skill',GEMINI),G(pack('.cursor/skills','SKILL.md'),'skill',CURSOR),G(file('.config/opencode/AGENTS.md'),'instructions',OPENCODE),G(pack('.config/opencode/skills','SKILL.md'),'skill',OPENCODE),
 G(file('.config/goose/.goosehints'),'instructions',GOOSE),G(pack('.config/goose/skills','SKILL.md'),'skill',GOOSE),G(file('.config/amp/AGENTS.md'),'instructions',AMP),G(file('.factory/AGENTS.md'),'instructions',DROID),
 G(pack('.factory/skills','SKILL.md'),'skill',DROID),G(file('.qwen/QWEN.md'),'instructions',QWEN),G(pack('.qwen/skills','SKILL.md'),'skill',QWEN),
];
const under=(p,root)=>p===root||p.startsWith(root+'/');
const real=p=>realpath(p).catch(()=>null);
const isDir=p=>stat(p).then(s=>s.isDirectory(),()=>false),isFile=p=>stat(p).then(s=>s.isFile(),()=>false);
const names=d=>readdir(d,{withFileTypes:true}).then(e=>e.sort((a,b)=>a.name<b.name?-1:1),()=>[]);
const strArray=(v,label)=>{if(!Array.isArray(v)||v.length>256||v.some(s=>typeof s!=='string'||s.includes('\0')))throw Error(`invalid ${label}`);return v;};

// Two scalar keys from a leading `---` block, in the first 41 lines; never an error.
async function frontmatter(p){
 let text='';try{const h=await open(p,'r');try{const b=Buffer.alloc(16384);const {bytesRead}=await h.read(b,0,b.length,0);text=b.subarray(0,bytesRead).toString('utf8');}finally{await h.close();}}catch{return [null,null];}
 const lines=text.split('\n').slice(0,41);if(lines.shift()?.trim()!=='---')return [null,null];
 const unq=v=>{const t=v.trim();return /^"(.*)"$/s.test(t)?t.slice(1,-1):/^'(.*)'$/s.test(t)?t.slice(1,-1):t;};
 let name=null,desc=null;for(const l of lines){const t=l.trim();if(t==='---')break;if(t.startsWith('name:'))name=unq(t.slice(5));else if(t.startsWith('description:'))desc=unq(t.slice(12));}
 return [name,desc];
}
async function walkNested(root,name,depth,out){
 if(await isFile(path.join(root,name)))out.push(path.join(root,name));
 if(depth>=MAX_NEST)return;
 // Symlinked dirs are not followed (a link to an ancestor would loop), dotdirs belong to their own specs.
 for(const e of await names(root))if(e.isDirectory()&&!e.name.startsWith('.')&&!SKIP_DIRS.includes(e.name))await walkNested(path.join(root,e.name),name,depth+1,out);
}
async function expand(loc,root){
 if(loc.t==='file')return [[path.join(root,loc.rel),loc.rel]];
 if(loc.t==='nested'){const found=[];await walkNested(root,loc.name,0,found);const top=path.join(root,loc.name);if(!found.includes(top))found.unshift(top);return found.map(p=>[p,path.relative(root,p)||loc.name]);}
 const out=[],base=path.join(root,loc.rel);
 for(const e of await names(base)){
  const p=path.join(base,e.name);
  if(loc.t==='dir'){if(path.extname(e.name)==='.'+loc.ext&&await isFile(p))out.push([p,`${loc.rel}/${e.name}`]);}
  // Pack dirs follow symlinks on purpose: one skill linked into several CLIs' skills/ is the normal setup.
  else if(await isDir(p)&&await isFile(path.join(p,loc.name)))out.push([path.join(p,loc.name),`${loc.rel}/${e.name}/${loc.name}`]);
 }
 return out;
}
// Deepest existing ancestor canonicalized, the rest re-appended: a file not yet created still resolves.
async function canonicalIsh(p){
 let existing=path.resolve(p),suffix=[];
 while(!(await lstat(existing).then(()=>true,()=>false))){if(existing==='/')throw Error('invalid path');suffix.unshift(path.basename(existing));existing=path.dirname(existing);}
 return path.join(await realpath(existing),...suffix);
}

export const WORKSPACE_TOOLS_READ_ONLY=['instructions_scan','instructions_read','model_catalog','probe_http_readiness'];

export function workspaceToolsCommands(ctx){
 const homeReal=()=>real(ctx.home);
 // A project root, only when it is a directory inside /workspace.
 const projectRoot=async r=>{try{const p=await ctx.scoped(r);return await isDir(p)?p:null;}catch{return null;}};
 // Where reading may land: inside a project root, or the home for global rows.
 const reachable=async(p,scope,root)=>{const r=await real(p);if(!r)return false;if(scope==='global'&&under(r,root))return true;try{await ctx.scoped(r);return true;}catch{return false;}};

 async function scan(roots){
  const out=[],seen=new Map(),home=await homeReal();
  const add=async(p,label,spec,root)=>{
   const key=(await real(p))||p,i=seen.get(key);
   if(i!==undefined){for(const a of spec.agents)if(!out[i].agents.includes(a))out[i].agents.push(a);return;}
   const meta=await stat(p).catch(()=>null),exists=!!meta?.isFile();
   if(exists&&!(await reachable(p,spec.scope,root)))return;
   const [title,description]=exists&&['skill','subagent','command','rule','style'].includes(spec.kind)?await frontmatter(p):[null,null];
   seen.set(key,out.length);
   out.push({path:p,kind:spec.kind,scope:spec.scope,agents:[...spec.agents],label,root:spec.scope==='global'?'':root,exists,bytes:meta?meta.size:0,modified:meta?Math.floor(meta.mtimeMs/1000):null,title,description});
  };
  const resolved=[];for(const r of roots){const p=await projectRoot(r);if(p)resolved.push(p);}
  for(const spec of SPECS.filter(s=>s.scope==='project'))for(const root of resolved)for(const [p,label] of await expand(spec.loc,root))await add(p,label,spec,root);
  if(home)for(const spec of SPECS.filter(s=>s.scope==='global'))for(const [p,label] of await expand(spec.loc,home))await add(p,'~/'+label,spec,home);
  return out;
 }

 // instructions.rs `gate`: the path must be, by name and location, one of the table's files.
 async function gate(value,roots){
  if(typeof value!=='string'||!value||value.includes('\0'))throw Error('invalid path');
  strArray(roots,'roots');
  const target=await canonicalIsh(value),written=path.resolve(value);
  const newIn=async(loc,root)=>{
   const canon=async p=>(await real(p))||p;
   if(loc.t==='file')return await canon(path.join(root,loc.rel))===target;
   if(loc.t==='pack')return path.basename(target)===loc.name&&await canon(path.dirname(path.dirname(target)))===await canon(path.join(root,loc.rel));
   if(loc.t==='dir')return path.extname(target)==='.'+loc.ext&&await canon(path.dirname(target))===await canon(path.join(root,loc.rel));
   return false;
  };
  const matches=async(spec,root)=>{for(const [p] of await expand(spec.loc,root))if(((await real(p))||p)===target)return true;return newIn(spec.loc,root);};
  const workspace=await real(ctx.root),inWorkspace=async()=>!!workspace&&under(target,workspace);
  for(const spec of SPECS.filter(s=>s.scope==='project'))for(const raw of roots){
   const root=await projectRoot(raw);if(!root)continue;
   if(spec.loc.t==='nested'){
    const rel=under(target,root)?path.relative(root,target):under(written,root)?path.relative(root,written):null;
    // SKIP_DIRS judged relative to the root, never on the absolute path.
    if(path.basename(target)===spec.loc.name&&rel!==null&&!rel.split('/').some(c=>SKIP_DIRS.includes(c))&&under(target,root))return target;
   }else if(await matches(spec,root)&&await inWorkspace())return target;
  }
  const home=await homeReal();
  // A global row may be a link into the workspace (shared skills), never anywhere else.
  if(home&&(under(target,home)||await inWorkspace()))for(const spec of SPECS.filter(s=>s.scope==='global'))if(await matches(spec,home))return target;
  throw Error(`not an agent instruction file: ${target}`);
 }

 return {
  instructions_scan:async({roots}={})=>scan(strArray(roots,'roots')),
  instructions_read:async({path:p,roots}={})=>{const f=await gate(p,roots);const s=await stat(f);if(s.size>MAX_BYTES)throw Error('File exceeds editor limit');return readFile(f,'utf8');},
  instructions_write:async({path:p,roots,content}={})=>{
   if(typeof content!=='string'||Buffer.byteLength(content)>MAX_BYTES)throw Error('invalid content');
   const f=await gate(p,roots);await mkdir(path.dirname(f),{recursive:true});
   // Re-check after mkdir: a directory raced in as a symlink must not carry the write out.
   if(path.join(await realpath(path.dirname(f)),path.basename(f))!==f)throw Error(`not an agent instruction file: ${f}`);
   await writeFile(f,content);return null;
  },
  // agents.rs MODEL_DONORS: the frontend names a donor and an index, never an argv.
  // aider needs a tty, so it is declared and refused exactly as on desktop.
  model_catalog:async({donor,query}={})=>{
   if(donor!=='omp'||query!==0)return null;
   try{return await ctx.run('omp',['models','--json'],ctx.root,10000);}catch{return null;}
  },
  probe_http_readiness:async({port,path:p}={})=>{
   if(!Number.isInteger(port)||port<0||port>65535)throw Error('invalid port');
   if(typeof p!=='string'||!p||!p.startsWith('/')||p.startsWith('//')||p.length>2048||/[\r\n]/.test(p))throw Error('HTTP readiness path must be a local absolute path');
   return new Promise(resolve=>{
    let done=false;const finish=v=>{if(!done){done=true;clearTimeout(total);request.destroy();resolve(v);}};
    const request=http.get({host:'127.0.0.1',port,path:p,agent:false,timeout:750},response=>{response.resume();finish(response.statusCode>=200&&response.statusCode<400);});
    const total=setTimeout(()=>finish(false),1500);
    request.on('timeout',()=>finish(false));request.on('error',()=>finish(false));
   });
  },
  // agents.rs kill_process is a bare SIGKILL; in a shared VM it is also confined
  // to this host's own uid and never aimed at init, the host or its supervisor.
  kill_process:async({pid}={})=>{
   if(!Number.isInteger(pid)||pid<0||pid>4294967295)throw Error('invalid pid');
   if(pid<=1||pid===process.pid||pid===process.ppid)throw Error('Refusing to kill a workspace system process');
   let status;try{status=await readFile(`/proc/${pid}/status`,'utf8');}catch{throw Error('No such process (os error 3)');}
   const uid=Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
   if(uid!==process.getuid())throw Error('Operation not permitted (os error 1)');
   try{process.kill(pid,'SIGKILL');}catch(error){throw Error(error.code==='ESRCH'?'No such process (os error 3)':'Operation not permitted (os error 1)');}
   return null;
  },
 };
}
