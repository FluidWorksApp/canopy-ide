import {lstat,realpath,readdir,mkdir,cp,rename,rm,readFile,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

function relative(value){
 return typeof value==='string'&&value.length<=1024&&(value==='.'||value.length>0&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'))&&!/[\\\x00-\x1f]/.test(value);
}
export function validateMigrationComponents(components){
 if(!Array.isArray(components)||!components.length||components.length>64)throw Error('Invalid migration components');
 const ids=new Set(),targets=[];
 for(const component of components){
  if(!component||typeof component.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(component.id)||ids.has(component.id)||
     typeof component.label!=='string'||!component.label.trim()||component.label.length>200||/[\x00-\x1f]/.test(component.label)||
     !relative(component.source)||!relative(component.relativePath))throw Error('Invalid migration component');
  ids.add(component.id);
  const target=component.relativePath;
  if(targets.some(other=>target==='.'||other==='.'||target===other||target.startsWith(other+'/')||other.startsWith(target+'/')))throw Error('Overlapping migration destinations');
  targets.push(target);
 }
 return components;
}

const inside=(root,value)=>value===root||value.startsWith(root+path.sep);
const gitConfigEnvironment={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
async function configEntries(file){
 let output;try{output=(await execute('/usr/bin/git',['config','--no-includes','--null','--list','--file',file],{env:gitConfigEnvironment,timeout:5000,maxBuffer:1048576})).stdout;}catch{throw Error('Git configuration could not be safely parsed; original files are unchanged');}
 return output.split('\0').filter(Boolean).map(record=>{const split=record.indexOf('\n');return {key:split<0?record:record.slice(0,split),value:split<0?null:record.slice(split+1)};});
}
function canonicalRemote(value){
 if(typeof value!=='string'||!value||/[\x00-\x20]/.test(value))throw Error('Replace the unsafe Git remote with a canonical repository URL before sharing');
 try{const url=new URL(value);if(!['https:','http:','ssh:','git:'].includes(url.protocol)||url.pathname.includes('://')||url.pathname.includes('@'))throw Error();if(url.protocol!=='ssh:')url.username='';url.password='';url.search='';url.hash='';return url.href;}catch{}
 const scp=/^(?:([^@\s:]+)@)?([a-zA-Z0-9.-]+):([^\s:@]+)$/.exec(value);if(scp)return `${scp[1]?scp[1]+'@':''}${scp[2]}:${scp[3]}`;
 throw Error('Replace the unsafe Git remote with a canonical repository URL before sharing');
}
function safeConfigEntry(entry){
 const key=entry.key.toLowerCase();
 if(key.startsWith('credential.')||/^http\..*\.(?:extraheader|cookiefile|savecookies|sslcert|sslkey|proxy)$/.test(key)||/^http\.(?:extraheader|cookiefile|savecookies|sslcert|sslkey|proxy)$/.test(key)||key.startsWith('http.')&&key.includes('://')||/^url\..*\.(?:insteadof|pushinsteadof)$/.test(key)||['core.sshcommand','core.askpass','core.hookspath','core.fsmonitor','core.worktree','user.signingkey','gpg.program','gpg.ssh.program'].includes(key)||/^remote\..*\.(?:proxy|vcs|uploadpack|receivepack)$/.test(key)||key.startsWith('alias.')&&entry.value?.startsWith('!'))return null;
 if(/^remote\..*\.(?:url|pushurl)$/.test(key))return {...entry,value:canonicalRemote(entry.value)};
 if(/[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/i.test(entry.key)||entry.value&&/[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/i.test(entry.value))throw Error('Git configuration embeds an authentication reference; replace it before sharing');
 return entry;
}
function quoteConfig(value){if(/[\x00-\x07\x0b-\x1f]/.test(value))throw Error('Unsupported Git configuration control character');return '"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/\t/g,'\\t').replace(/\x08/g,'\\b')+'"';}
function serializedConfig(entries){return entries.map(({key,value})=>{const first=key.indexOf('.'),last=key.lastIndexOf('.');if(first<1||last<first)throw Error('Invalid Git configuration key');const section=key.slice(0,first),option=key.slice(last+1),subsection=first===last?null:key.slice(first+1,last);return `[${section}${subsection===null?'':' '+quoteConfig(subsection)}]\n\t${option}${value===null?'':' = '+quoteConfig(value)}\n`;}).join('\n');}
async function gitConfigPlan(root,source){
 const files=[],nodes=new Map(),privateFiles=new Set();let directories=0;
 const collectPrivateFile=entry=>{
  if(typeof entry.value!=='string')return;const key=entry.key.toLowerCase();let reference;
  if(/^credential\..*helper$/.test(key)||key==='credential.helper'){
   if(/(?:^|[\s/])(?:git-credential-)?store(?:\s|$)/.test(entry.value)){const match=/--file(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(entry.value);reference=match&&(match[1]??match[2]??match[3]);}
  }else if(/^http\..*(?:cookiefile|sslkey|sslcert)$/.test(key)||key==='user.signingkey')reference=entry.value;
  if(!reference||reference.startsWith('~')||reference.includes('$')||reference.includes('%('))return;
  const candidates=[path.resolve(path.dirname(root),reference),path.resolve(root,reference)];if(reference.startsWith('.git/'))candidates.push(path.join(root,reference.slice(5)));if(reference.startsWith('/workspace/'))candidates.push(path.join(source,reference.slice('/workspace/'.length)));
  for(const target of candidates)if(inside(root,target)&&target!==root){const relative=path.relative(root,target);if(['objects','refs'].includes(relative.split(path.sep)[0])||['HEAD','index','packed-refs','config','config.worktree','commondir','gitdir'].includes(path.basename(relative)))throw Error('Git credential storage overlaps repository history metadata');privateFiles.add(relative);}
 };
 const walk=async(directory,depth=0)=>{if(++directories>4096||depth>32)throw Error('Git metadata tree is too large');for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory()&&!['objects','logs','refs','hooks'].includes(entry.name))await walk(file,depth+1);else if(entry.isSymbolicLink()&&!['objects','logs','refs','hooks'].includes(entry.name)){const actual=await realpath(file);if(!inside(root,actual))throw Error('Git metadata symlink leaves its configuration directory; original files are unchanged');if((await lstat(actual)).isDirectory())throw Error('Resolve Git metadata directory symlinks before sharing');if(['config','config.worktree'].includes(entry.name))throw Error('Resolve Git configuration symlinks before sharing');}else if(entry.isFile()&&['config','config.worktree'].includes(entry.name))files.push(file);}};
 await walk(root);
 const visit=async(file,depth=0)=>{
  if(depth>16||nodes.size>=256)throw Error('Git configuration includes are too large');
  const actual=await realpath(file);if(!inside(root,actual)||!inside(source,actual)||(await lstat(file)).isSymbolicLink())throw Error('Git configuration includes must stay inside its metadata directory; original files are unchanged');
  if(nodes.has(actual))return;await boundedGitFile(actual,source);const node={source:actual,relative:path.relative(root,actual),entries:[]};nodes.set(actual,node);
  for(const original of await configEntries(actual)){
   collectPrivateFile(original);
   const entry=safeConfigEntry(original);if(!entry)continue;
   if(/^include(?:if\..*)?\.path$/i.test(entry.key)){
    if(typeof entry.value!=='string'||!entry.value||entry.value.startsWith('~')||entry.value.includes('%(')||entry.value.includes('$'))throw Error('External Git configuration includes cannot be shared; original files are unchanged');
    const target=path.resolve(path.dirname(actual),entry.value);if(!inside(root,target))throw Error('External Git configuration includes cannot be shared; original files are unchanged');await visit(target,depth+1);entry.value=path.relative(path.dirname(actual),await realpath(target));
   }
   node.entries.push(entry);
  }
 };
 for(const file of files)await visit(file);return {nodes:[...nodes.values()],privateFiles:[...privateFiles]};
}
async function applyGitConfigPlan(plan,destination){
 for(const node of plan.nodes)await replaceGitFile(path.join(destination,node.relative),serializedConfig(node.entries));
 for(const relative of plan.privateFiles){const file=path.join(destination,relative);let info;try{info=await lstat(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}if(info.isDirectory())throw Error('Git credential storage overlaps a metadata directory');await rm(file,{force:true});}
 const clean=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(['hooks','logs'].includes(entry.name)){await rm(file,{recursive:true,force:true});continue;}if(['objects','refs'].includes(entry.name))continue;if(entry.isDirectory())await clean(file);else if(['.git-credentials','credentials','credential-store','credentials.store'].includes(entry.name))await rm(file,{force:true});}};await clean(destination);
}
async function boundedGitFile(file,root,optional=false){
 let actual;try{actual=await realpath(file);}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}
 if(!inside(root,actual))throw Error('Git metadata leaves project storage; original files are unchanged');
 const info=await lstat(actual);if(!info.isFile()||info.size>1048576)throw Error('Invalid Git metadata file');
 return readFile(actual,'utf8');
}
async function repositoryFor(folder,source){
 for(let candidate=folder;inside(source,candidate);candidate=path.dirname(candidate)){
  const marker=path.join(candidate,'.git');let info;try{info=await lstat(marker);}catch(e){if(e.code!=='ENOENT')throw e;if(candidate===source)break;continue;}
  let gitDir;
  if(info.isFile()){
   const text=await boundedGitFile(marker,source),match=/^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(text);if(!match)throw Error('Invalid Git worktree metadata');const requested=path.resolve(candidate,match[1]);if(!inside(source,requested))throw Error('Git worktree metadata leaves project storage; original files are unchanged');gitDir=await realpath(requested);
  }else gitDir=await realpath(marker);
  if(!inside(source,gitDir))throw Error('Git worktree metadata leaves project storage; original files are unchanged');
  if(!(await lstat(gitDir)).isDirectory())throw Error('Invalid Git directory');
  const common=await boundedGitFile(path.join(gitDir,'commondir'),source,true),requestedCommon=common===null?gitDir:path.resolve(gitDir,common.trim());if(!inside(source,requestedCommon))throw Error('Git common metadata leaves project storage; original files are unchanged');const commonDir=await realpath(requestedCommon);
  if(!inside(source,commonDir))throw Error('Git common metadata leaves project storage; original files are unchanged');
  await boundedGitFile(path.join(commonDir,'config'),source,true);
  const alternates=await boundedGitFile(path.join(commonDir,'objects','info','alternates'),source,true);
  if(alternates?.trim())throw Error('Git object alternates need an independent repository copy before sharing; original files are unchanged');
  return {root:candidate,gitDir,commonDir,linked:info.isFile()||info.isSymbolicLink()};
 }
 return null;
}
async function appendGitConfig(file,content){
 try{if((await lstat(file)).isSymbolicLink())throw Error('Git config symlinks must be resolved before sharing');}catch(e){if(e.code!=='ENOENT')throw e;}
 const before=await readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});await writeFile(file,before+content);
}
async function replaceGitFile(file,content){try{if((await lstat(file)).isSymbolicLink())await unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}await writeFile(file,content);}

// Copies keep the folder's real name: the repository folder's basename,
// sanitized, with -2, -3… added only when two folders share a name.
export function copyName(folder,taken,fallback='repository'){
 const base=(path.basename(folder).replace(/\.git$/,'').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^[.-]+/,'').slice(0,64))||fallback;
 let name=base,n=1;while(taken.has(name.toLowerCase()))name=`${base}-${++n}`;
 taken.add(name.toLowerCase());return name;
}
// Called inside a disposable helper with only the old project volume mounted
// read-only and the new project volume mounted writable. Publication is one
// rename; originals are never removed, and failed copies remain unpublished.
export async function copyProjectComponents({sourceRoot,destinationRoot,components,runtimeRoot}){
 validateMigrationComponents(components);
 const source=await realpath(sourceRoot),destination=await realpath(destinationRoot);
 if(source===destination||destination.startsWith(source+path.sep)||source.startsWith(destination+path.sep))throw Error('Migration roots must be separate');
 if((await readdir(destination)).length)throw Error('Migration destination is not empty');
 const resolved=[],repositories=new Map(),metadata=new Map(),gitCopies=new Map(),configPlans=new Map(),repositoryNames=new Set(),metadataNames=new Set();
 for(const component of components){
  const from=await realpath(path.join(source,component.source));
  if(from!==source&&!from.startsWith(source+path.sep))throw Error('Component leaves source volume');
  if(!(await lstat(from)).isDirectory())throw Error('Component is not a directory');
  const repository=await repositoryFor(from,source);
  if(repository&&!repositories.has(repository.root))repositories.set(repository.root,{...repository,target:'.canopy-repositories/'+copyName(repository.root,repositoryNames)});
  resolved.push({...component,from,repository:repository?repositories.get(repository.root):null});
 }
 for(const repository of repositories.values())for(const gitRoot of [repository.commonDir,repository.gitDir])if(!configPlans.has(gitRoot))configPlans.set(gitRoot,await gitConfigPlan(gitRoot,source));
 const staging=path.join(destination,'.canopy-migration-'+randomUUID());
 await mkdir(staging,{mode:0o700});
 const content=path.join(staging,'content');
 try{
  await mkdir(content);
  for(const repository of repositories.values()){
   const to=path.join(content,repository.target);await cp(repository.root,to,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,errorOnExist:true,force:false});
   const worktree=path.join(runtimeRoot??path.join(destination,'content'),repository.target);
   if(!repository.linked){await applyGitConfigPlan(configPlans.get(repository.gitDir),path.join(to,'.git'));await appendGitConfig(path.join(to,'.git','config'),`\n[core]\n\tworktree = ${JSON.stringify(worktree)}\n`);continue;}
   if(!metadata.has(repository.commonDir)){
    const target='.canopy-git/'+copyName(path.basename(repository.commonDir)==='.git'?path.dirname(repository.commonDir):repository.commonDir,metadataNames);metadata.set(repository.commonDir,target);await cp(repository.commonDir,path.join(content,target),{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,errorOnExist:true,force:false});await applyGitConfigPlan(configPlans.get(repository.commonDir),path.join(content,target));
   }
   const commonTarget=path.join(content,metadata.get(repository.commonDir));let gitTarget;
   if(inside(repository.commonDir,repository.gitDir))gitTarget=path.join(commonTarget,path.relative(repository.commonDir,repository.gitDir));
   else{if(!gitCopies.has(repository.gitDir)){gitTarget=path.join(content,'.canopy-git/'+copyName(path.basename(repository.gitDir)+'-worktree',metadataNames,'worktree'));gitCopies.set(repository.gitDir,gitTarget);await cp(repository.gitDir,gitTarget,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,errorOnExist:true,force:false});await applyGitConfigPlan(configPlans.get(repository.gitDir),gitTarget);}else gitTarget=gitCopies.get(repository.gitDir);}
   await unlink(path.join(to,'.git'));await writeFile(path.join(to,'.git'),'gitdir: '+path.relative(to,gitTarget)+'\n');
   if(repository.commonDir!==repository.gitDir){await replaceGitFile(path.join(gitTarget,'commondir'),path.relative(gitTarget,commonTarget)+'\n');await replaceGitFile(path.join(gitTarget,'gitdir'),path.join(worktree,'.git')+'\n');await appendGitConfig(path.join(commonTarget,'config'),'\n[extensions]\n\tworktreeConfig = true\n');await appendGitConfig(path.join(gitTarget,'config.worktree'),`\n[core]\n\tworktree = ${JSON.stringify(worktree)}\n\tbare = false\n`);}
   else await appendGitConfig(path.join(commonTarget,'config'),`\n[core]\n\tworktree = ${JSON.stringify(worktree)}\n`);
  }
  for(const component of resolved){
   if(component.repository)continue;
   if(component.relativePath.startsWith('.canopy-repositories')||component.relativePath.startsWith('.canopy-git'))throw Error('Component destination uses a reserved Git migration folder');
   const to=component.relativePath==='.'?content:path.join(content,component.relativePath);
   await cp(component.from,to,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,errorOnExist:component.relativePath!=='.',force:false});
  }
  await rename(content,path.join(destination,'content'));
  await rm(staging,{recursive:true,force:true});
 }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
 return resolved.map(({id,label,relativePath,from,repository})=>({id,label,relativePath:repository?path.posix.join('content',repository.target,path.relative(repository.root,from)):relativePath==='.'?'content':'content/'+relativePath}));
}
