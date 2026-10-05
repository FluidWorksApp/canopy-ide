import {BrowserStreams} from './browser-streams.mjs';
import {safeGitRead,GIT_READ_COMMANDS} from './git-read.mjs';
import {gitIdentityEnvironment} from './git-identity.mjs';
// Native IDE command boundary for a Linux workspace. Files and subprocesses
// never escape the selected container; no host Docker/cloud credential API.
import {readFile,writeFile,open,readdir,stat,realpath,mkdir,rename,cp,unlink,rm,lstat} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import http from 'node:http';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {body,json} from './http.mjs';
import {WebSocketServer} from 'ws';
import {terminalScreens} from './terminal-screen.mjs';
import {WorkspaceProfiles} from './profiles.mjs';
import {AgentIntegrations} from './agent-integrations.mjs';
import {readAgentEvents} from './agent-events.mjs';
import {sessionDigestReader} from './session-digests.mjs';
import {prepareSession} from './session-transfer.mjs';
import {importAgentAccounts,importAccountProfiles} from './agent-accounts.mjs';
import {CloneJobs} from './git-clone.mjs';
import {repositorySource} from './git-source.mjs';
import {agentUsageReader} from './agent-usage.mjs';
import {metricsReader} from './workspace-metrics.mjs';
import {writeWorkspaceFile} from './file-write.mjs';
import {WorkspaceUploads} from './file-upload.mjs';
import {listWorkspaceFiles,searchWorkspaceFiles} from './file-search.mjs';
import {agentWorkspaceAt} from './agent-workspace.mjs';
import {workspaceActivity} from './activity.mjs';
import {sessionProcessReader} from './session-processes.mjs';
const sessionProcesses=sessionProcessReader();
const workspaceMetrics=metricsReader();
const execute=promisify(execFile);
const ROOT='/workspace', HOME='/home/agent', STORE=HOME+'/.canopy/ide-projects.json';
const browsers=new BrowserStreams({home:HOME});
const profiles=new WorkspaceProfiles(HOME);
const integrations=new AgentIntegrations(HOME);
const sessionDigests=sessionDigestReader(HOME);
const uploads=new WorkspaceUploads(ROOT);
const agentUsage=agentUsageReader(HOME);
export async function scoped(value,create=false){
  if(typeof value!=='string'||value.includes('\0'))throw Error('Invalid workspace path');
  const candidate=path.resolve(ROOT,value);
  if(candidate!==ROOT&&!candidate.startsWith(ROOT+'/'))throw Error('Path outside selected workspace');
  let resolved;
  try{resolved=await realpath(candidate);}catch(error){if(!create||error.code!=='ENOENT')throw error;resolved=path.join(await realpath(path.dirname(candidate)),path.basename(candidate));}
  if(resolved!==ROOT&&!resolved.startsWith(ROOT+'/'))throw Error('Symlink outside selected workspace');
  return resolved;
}
const cloneJobs=new CloneJobs({scoped});
let children=0;
let metadataWrites=Promise.resolve();
let desktopStarted;
let changeCursor=0;const changes=[];
async function run(bin,argv,cwd=ROOT,timeout=15000,environment={}){
  if(children>=4)throw Error('Workspace process limit reached');
  children++;
  try{const options={allowedRoot:ROOT,cwd:await scoped(cwd),timeout,maxBuffer:1024*1024,env:{...process.env,HOME,CODEX_HOME:HOME+'/.codex',CLAUDE_CONFIG_DIR:HOME+'/.claude',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',...environment}};return (await (bin==='git'&&GIT_READ_COMMANDS.has(argv[0])?safeGitRead(execute,argv,options):execute(bin,argv,options))).stdout;}
  catch(error){throw Error(String(error.stderr||'Workspace command failed').slice(0,4096));}
  finally{children--;}
}
async function boundedRead(file,limit=1048576){const handle=await open(file,'r');try{const bytes=Buffer.alloc(limit+1);let length=0;while(length<=limit){const result=await handle.read(bytes,length,bytes.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}if(length>limit)throw Error('File exceeds editor limit');return bytes.subarray(0,length);}finally{await handle.close();}}
async function metadata(file,fallback){try{return JSON.parse((await boundedRead(HOME+'/.canopy/'+file)).toString('utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
async function saveMetadata(file,value){await mkdir(HOME+'/.canopy',{recursive:true,mode:0o700});const target=HOME+'/.canopy/'+file;const temporary=target+'.'+randomUUID()+'.next';const data=JSON.stringify(value);if(Buffer.byteLength(data)>1048576)throw Error('Workspace metadata limit reached');await writeFile(temporary,data,{mode:0o600,flag:'wx'});await rename(temporary,target);changeCursor++;changes.push({sequence:changeCursor,change:{store:file,scope:ROOT,id:''}});if(changes.length>1024)changes.shift();}
const CLIS=['claude','codex','amp','aider','agy','opencode','omp','cursor-agent','grok'];
export async function nativeInvoke(command,args={}){
  if(command.startsWith('fs_upload_'))return uploads.invoke(command,args);
  if(command==='session_process_stats'){
    if(!Array.isArray(args.sessions)||args.sessions.length>32)throw Error('Invalid session inventory');
    return sessionProcesses(args.sessions);
  }
  if(command==='agent_workspace_at')return agentWorkspaceAt(args,{run,scoped});
  if(command==='workspace_activity')return workspaceActivity();
  if(command==='workspace_metrics')return workspaceMetrics();
  if(command==='workspace_browser_request'){
    const directory=HOME+'/.canopy/browser-requests';
    let files;try{files=await readdir(directory);}catch(e){if(e.code==='ENOENT')return null;throw e;}
    for(const file of files.filter(f=>/^[a-f0-9-]+\.json$/.test(f)).slice(0,32)){const target=directory+'/'+file;const request=JSON.parse((await boundedRead(target,16384)).toString());await unlink(target);if(Date.now()-request.createdAt<600000)return request.url;}return null;
  }
  if(command==='profile_import_git'){
    if(typeof args.token!=='string'||!args.token.length||args.token.length>16384||/[\r\n]/.test(args.token))throw Error('Invalid GitHub account');
    const identity=args.identity??{};for(const [key,value] of Object.entries(identity)){if(!['user.name','user.email'].includes(key)||typeof value!=='string'||value.length>1024||/[\r\n\0]/.test(value))throw Error('Invalid Git author identity');}
    await new Promise((resolve,reject)=>{const child=spawn('gh',['auth','login','--hostname','github.com','--git-protocol','https','--with-token'],{env:{...process.env,HOME},stdio:['pipe','ignore','ignore']});const timer=setTimeout(()=>{child.kill();reject(Error('GitHub setup timed out'));},20000);child.once('error',()=>{clearTimeout(timer);reject(Error('GitHub CLI unavailable'));});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('GitHub setup failed'));});child.stdin.on('error',()=>{});child.stdin.end(args.token+'\n');});
    await run('gh',['auth','setup-git','--hostname','github.com']);for(const [key,value] of Object.entries(identity))await run('git',['config','--global',key,value]);
    return {imported:['github','git identity']};
  }
  if(command==='profile_import_credentials'){const copied=args.profiles?.length?await importAccountProfiles(args.profiles,HOME,profiles):{imported:[]};const defaults=Object.keys(args.accounts??{}).length?await importAgentAccounts(args.accounts,HOME):{imported:[]};return {imported:[...defaults.imported,...copied.imported],existingProfiles:copied.skipped??[]};}
  if(command==='oauth_callback'){
    const port=Number(args.port), callback=new URL(String(args.path),'http://127.0.0.1');
    if(!Number.isInteger(port)||port<=1024||port>65535||[8080,8081,8787].includes(port)||callback.origin!=='http://127.0.0.1'||!['/callback','/auth/callback','/oauth/callback'].includes(callback.pathname)||!callback.searchParams.get('state')||String(args.path).length>8192)throw Error('Invalid sign-in callback');
    const response=await fetch(`http://127.0.0.1:${port}${callback.pathname}${callback.search}`,{redirect:'manual',signal:AbortSignal.timeout(10000)});
    await response.body?.cancel();
    if(response.status<200||response.status>=400)throw Error('Remote CLI rejected sign-in callback');
    return {accepted:true};
  }
  const target=args.repo??args.path??args.root??ROOT;
  if(command==='store_changes')return {cursor:changeCursor,changes:args.after==null?[]:changes.filter(c=>c.sequence>args.after)};
  if(command==='cli_take_pending_open'||command==='cli_take_pending_link'||command==='agent_health_report')return null;
  if(command==='instance_id')return 'remote-'+(process.env.CANOPY_WORKSPACE_ID??'workspace');
  if(command==='relay_status')return {role:'off',code:null,port:null,ips:[],addr:null,self_id:null,name:null,visibility:null,public_ip:null,members:[]};
  if(['notes_list','notes_due','research_list','task_list_history'].includes(command))return metadata(command+'.json',[]);
  if(['context_tools','context_publish','set_context_scopes','pr_watch_set'].includes(command)){await saveMetadata(command+'.json',args);return;}
  if(command==='terminal_governor_status'){
    const limit=Number(await readFile('/sys/fs/cgroup/memory.max','utf8'));
    const used=Number(await readFile('/sys/fs/cgroup/memory.current','utf8'));
    if(!Number.isFinite(limit)||!Number.isFinite(used))throw Error('Workspace memory measurement unavailable');
    return {capability:{platform:'linux',enforcement:'monitor_only',measurement:'workspace cgroup memory.current',hard_limit:true,pause:false,soft_limit:false,dynamic_raise:false,mechanism:'Docker cgroup memory.max',detail:'The hard limit covers this entire workspace, including agents and its desktop. Per-agent budgets are unavailable.'},host_total_bytes:limit,host_available_bytes:Math.max(0,limit-used),protected_reserve_bytes:0,aggregate_terminal_bytes:used,grantable_headroom_bytes:0,fallback_policy:'notify_natively_and_refuse_automatic_grant_pause_or_stop',sessions:[]};
  }

  if(command==='workspace_browser_open'||command==='workspace_preview_open'){
    const raw=String(args.url??'');if(raw.length>8192)throw Error('Sign-in URL too long');
    const url=new URL(raw);
    const preview=command==='workspace_preview_open';
    const loopback=['localhost','127.0.0.1','0.0.0.0','[::1]'].includes(url.hostname)||url.hostname.endsWith('.localhost');
    if(url.username||url.password||(preview?(!loopback||!['http:','https:'].includes(url.protocol)):url.protocol!=='https:'))throw Error(preview?'Use a workspace localhost HTTP or HTTPS URL':'Use an HTTPS sign-in URL');
    try{await stat('/tmp/.X11-unix/X99');}catch{throw Error('Start the remote desktop before opening its browser');}
    await nativeInvoke('desktop_session');
    const child=spawn('chromium',['--no-sandbox','--disable-dev-shm-usage','--no-first-run','--user-data-dir='+HOME+'/.cache/canopy-browser',url.href],{env:{...process.env,HOME,DISPLAY:':99',XDG_RUNTIME_DIR:HOME+'/.cache/runtime'},stdio:'ignore'});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('Remote browser unavailable')));});child.unref();return;
  }

  if(command==='desktop_session'){
    if(!desktopStarted)desktopStarted=(async()=>{
      try{await run('pgrep',['-u','1000','-x','xfce4-session']);return;}catch{}
      await mkdir(HOME+'/.cache/runtime',{recursive:true,mode:0o700});
      const env={...process.env,HOME,DISPLAY:':99',XDG_RUNTIME_DIR:HOME+'/.cache/runtime'};
      const wm=spawn('xfwm4',['--replace'],{env,stdio:'ignore'});wm.on('error',()=>{});wm.unref();
      const session=spawn('dbus-run-session',['--','xfce4-session'],{env,stdio:'ignore'});
      await new Promise((resolve,reject)=>{session.once('spawn',resolve);session.once('error',reject);});
      session.unref();
    })().catch(error=>{desktopStarted=null;throw error;});
    await desktopStarted;return;
  }

  if(command==='store_load'){
    try{return (await boundedRead(STORE)).toString('utf8');}catch(error){if(error.code!=='ENOENT')throw error;const id='remote-'+(process.env.CANOPY_WORKSPACE_ID??'workspace');return JSON.stringify({projects:[{id,name:'Workspace',components:[{id:id+'-root',label:'Workspace',path:ROOT}]}],openIds:[id],activeId:id});}
  }
  if(command==='store_save'){const parsed=JSON.parse(args.data);if(!Array.isArray(parsed.projects))throw Error('Invalid projects');for(const project of parsed.projects)for(const component of project.components??[])await scoped(component.path);await saveMetadata('ide-projects.json',parsed);return;}
  if(command==='fs_read_dir'){const directory=await scoped(target);const entries=await readdir(directory,{withFileTypes:true});if(entries.length>4096)throw Error('Directory too large');return entries.map(e=>({name:e.name,path:path.join(directory,e.name),is_dir:e.isDirectory(),is_symlink:e.isSymbolicLink()}));}
  if(command==='fs_read_file'){const bytes=await boundedRead(await scoped(target),Math.min(args.maxBytes??1048576,1048576));return {b64:bytes.toString('base64')};}
  if(command==='fs_write_file'||command==='fs_create_file'){const text=command==='fs_create_file'?'':args.content;if(typeof text!=='string'||Buffer.byteLength(text)>1048576)throw Error('Invalid file content');const destination=await scoped(target,true);if(command==='fs_create_file')await writeFile(destination,text,{flag:'wx',mode:0o600});else await writeWorkspaceFile(destination,text);return target;}
  if(command==='fs_create_dir'){await mkdir(await scoped(target,true));return target;}
  if(command==='fs_trash'){
    const source=await scoped(args.path);
    if((await lstat(path.resolve(ROOT,args.path))).isSymbolicLink())throw Error('Trash the symlink from a shell instead of its target');
    if(source===ROOT)throw Error('Cannot trash the workspace root');
    const trash=HOME+'/.local/share/Trash';await mkdir(trash+'/files',{recursive:true,mode:0o700});await mkdir(trash+'/info',{recursive:true,mode:0o700});
    const name=path.basename(source)+'-'+randomUUID();
    const info=trash+'/info/'+name+'.trashinfo';
    await writeFile(info,'[Trash Info]\nPath='+encodeURI(source)+'\nDeletionDate='+new Date().toISOString().slice(0,19)+'\n',{mode:0o600,flag:'wx'});
    try{try{await rename(source,trash+'/files/'+name);}catch(error){if(error.code!=='EXDEV')throw error;await cp(source,trash+'/files/'+name,{recursive:true,dereference:false,errorOnExist:true,force:false});await rm(source,{recursive:true});}}catch(error){await unlink(info);throw error;}
    return;
  }
  if(command==='fs_rename'){await rename(await scoped(args.from??args.oldPath),await scoped(args.to??args.newPath,true));return args.to??args.newPath;}
  if(command==='fs_duplicate'){const destination=args.destination??args.path+'.copy';await cp(await scoped(args.path),await scoped(destination,true),{recursive:true,dereference:false,errorOnExist:true,force:false});return destination;}
  if(command==='fs_stat'||command==='fs_stat_many'){const inspect=async p=>{const x=await stat(await scoped(p));return {path:p,is_dir:x.isDirectory(),size:x.size,modified_ms:x.mtimeMs};};return command==='fs_stat'?inspect(target):Promise.all((args.paths??[]).slice(0,512).map(inspect));}
  if(command==='fs_list_files'||command==='fs_search'){
    if(!Array.isArray(args.roots)||args.roots.length>64)throw Error('Choose project component folders');
    const roots=[...new Set(await Promise.all(args.roots.map(root=>scoped(root))))];
    return command==='fs_list_files'?listWorkspaceFiles(roots,args.limit??20000):searchWorkspaceFiles(roots,args.query,args.limit??300);
  }
  if(command==='cli_versions'){const result={};for(const query of (args.queries??[]).slice(0,32)){if(!CLIS.includes(query.bin))continue;let installed=null;try{installed=(await run(query.bin,['--version'])).trim().slice(0,256);}catch{}result[query.bin]={installed,latest:null,managedBy:'docker',update:null};}return result;}
  if(command==='which_check'){
    const commands=(args.commands??[]).slice(0,64);
    for(const bin of commands)if(typeof bin!=='string'||!/^[-a-zA-Z0-9_.]+$/.test(bin))throw Error('Invalid executable');
    // Probe in one process. Admission failure means unavailable, not uninstalled.
    const present=(await run('/bin/sh',['-c','for bin do if command -v "$bin" >/dev/null 2>&1; then printf "%s\\n" "$bin"; fi; done','check',...commands])).trim().split('\n');
    return Object.fromEntries(commands.map(bin=>[bin,present.includes(bin)]));
  }
  if(command==='profiles_list')return [...await profiles.list(),...(process.env.CANOPY_ACCOUNTS??'').split(',').filter(Boolean).map(id=>({id:'pool-'+id,label:'Shared account · '+id,root:'/accounts/'+id,removable:false}))];
  if(command==='profile_create')return profiles.create(args.label);
  if(command==='profile_delete')return profiles.remove(args.id);
  if(command==='profile_env'){if(!String(args.id).startsWith('pool-'))return profiles.env(args.agent,args.id);const id=String(args.id).replace(/^pool-/, '');if(!/^[a-z][a-z0-9-]{0,47}$/.test(id)||!(process.env.CANOPY_ACCOUNTS??'').split(',').filter(Boolean).includes(id))throw Error('Account is not available to this workspace');return [['CANOPY_ACCOUNT_POOL',id]];}
  if(command==='profile_activate'){if(String(args.id).startsWith('pool-')){await nativeInvoke('profile_env',args);return;}return profiles.activate(args.id);}
  if(command==='profile_accounts'){if(String(args.id).startsWith('pool-')){await nativeInvoke('profile_env',args);return CLIS.map(agent=>({agent,state:'unknown',account:null}));}return profiles.accounts(args.id);}
  if(command==='git_head_content'){const file=await scoped(args.path);const directory=path.dirname(file);try{const repo=(await run('git',['rev-parse','--show-toplevel'],directory)).trim();return await run('git',['show','HEAD:'+path.relative(repo,file)],repo);}catch{return null;}}
  if(command==='git_log'){const limit=Math.max(1,Math.min(200,Number(args.limit)||40));return (await run('git',['log',`-${limit}`,'--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%D'],target)).trimEnd().split('\n').filter(Boolean).map(row=>{const [hash,short,author,date,subject,refs]=row.split('\x1f');return {hash,short,author,date,subject,refs};});}
  if(command==='git_checkout'){try{await run('git',['check-ref-format','--branch',String(args.branch)],target);const message=await run('git',['checkout',...(args.create?['-b']:[]),String(args.branch)],target);return {kind:'switched',message,path:null};}catch(error){return {kind:'failed',summary:'Could not switch branch',detail:error.message};}}
  if(command==='git_clone_start')return cloneJobs.start(args.parent,args.url);
  if(command==='git_clone_status')return cloneJobs.status(args.id);
  if(command==='git_clone_cancel')return cloneJobs.cancel(args.id);
  if(command==='git_clone'){
    const {url,name}=repositorySource(args.url);const parent=await scoped(args.parent);
    const destination=await scoped(path.join(parent,name),true);
    try{await stat(destination);throw Error('A folder with this repository name already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
    await run('git',['clone','--',url,destination],parent,300000);return {path:destination,name};
  }
  if(['git_stage','git_unstage'].includes(command)){const files=args.paths;if(!Array.isArray(files)||!files.length||files.length>512)throw Error('Choose files');const repo=await scoped(args.repo);for(const file of files){const candidate=path.resolve(repo,file);if(candidate!==repo&&!candidate.startsWith(repo+'/'))throw Error('File outside repository');await scoped(candidate,true);}await run('git',[command==='git_stage'?'add':'reset',...(command==='git_unstage'?['HEAD']:[]),'--',...files],repo);return;}
  if(command==='git_commit')return run('git',['commit',...(args.amend?['--amend']:[]),'-m',String(args.message)],args.repo,15000,args.gitIdentity?gitIdentityEnvironment(args.gitIdentity):{});
  if(command==='git_fetch')return run('git',['fetch','--prune'],args.repo,300000);
  if(command==='git_pull')return run('git',['pull','--ff-only'],args.repo,300000);
  if(command==='git_push')return run('git',['push',...(args.setUpstream?['--set-upstream','origin',(await run('git',['branch','--show-current'],args.repo)).trim()]:[])],args.repo,300000);
  if(command==='git_repos'){const repos=[];for(const component of args.components??[]){try{const directory=typeof component==='string'?component:Array.isArray(component)?component[1]:component.path;const repo=(await run('git',['rev-parse','--show-toplevel'],directory)).trim();if(!repos.some(r=>r.path===repo))repos.push({path:repo,name:path.basename(repo),components:[directory],branch:(await run('git',['branch','--show-current'],repo)).trim()||null,detached:false});}catch{/* Non-repository components remain editable. */}}return repos;}
  if(command==='git_status'){try{const lines=(await run('git',['status','--porcelain=v1','--untracked-files=normal'],target)).trimEnd().split('\n').filter(Boolean);return {is_repo:true,branch:(await run('git',['branch','--show-current'],target)).trim()||null,entries:lines.map(line=>({path:path.join(target,line.slice(3)),status:line.slice(0,2)}))};}catch{return {is_repo:false,branch:null,entries:[]};}}
  if(command==='git_repo_status'){const branch=(await run('git',['branch','--show-current'],target)).trim();const result={path:target,branch:branch||null,upstream:null,ahead:0,behind:0,detached:!branch,staged:[],unstaged:[],untracked:[],conflicted:[]};for(const line of (await run('git',['status','--porcelain=v1'],target)).trimEnd().split('\n').filter(Boolean)){const status=line.slice(0,2),file=line.slice(3),value={status,path:file,abs:path.join(target,file),staged:status[0]!==' '&&status!=='??',untracked:status==='??',conflicted:status.includes('U')};result[value.untracked?'untracked':value.conflicted?'conflicted':value.staged?'staged':'unstaged'].push(value);}return result;}
  if(command==='git_branches')return (await run('git',['for-each-ref','--format=%(refname:short)\t%(HEAD)\t%(subject)','refs/heads'],target)).trim().split('\n').filter(Boolean).map(line=>{const [name,current,subject]=line.split('\t');return {name,current:current==='*',subject,remote_only:false,synced:false,protected:['main','master'].includes(name)};});
  if(command==='git_worktrees'){const output=await run('git',['worktree','list','--porcelain'],target);return output.trim().split('\n\n').map((block,index)=>{const rows=Object.fromEntries(block.split('\n').map(line=>{const at=line.indexOf(' ');return [at<0?line:line.slice(0,at),at<0?'':line.slice(at+1)];}));return {path:rows.worktree,branch:rows.branch?.replace('refs/heads/','')??null,head:rows.HEAD,is_main:index===0,locked:'locked'in rows,detached:'detached'in rows,prunable:'prunable'in rows};});}
  if(command==='git_diff')return run('git',['diff','--no-ext-diff','--no-textconv',...(args.staged?['--cached']:[]),'--',args.path??args.file??'.'],target);
  if(command==='git_remote_url'){try{return (await run('git',['remote','get-url','origin'],target)).trim();}catch{return null;}}
  if(command==='git_branch_current')return (await run('git',['branch','--show-current'],target)).trim();
  if(command==='opencode_session_stats')return agentUsage.opencodeSessionStats(args.sessionId??args.session_id);
  if(command==='claude_session_stats')return agentUsage.sessionStats(args.transcriptPath);
  if(command==='agent_usage')return agentUsage.usage();
  if(command==='plan_usage'){await agentUsage.usage();return agentUsage.plans(args.sessionId??null);}
  if(command==='profile_prepare_session')return prepareSession(HOME,args);
  if(command==='session_digests')return sessionDigests();
  if(command==='workspace_chrome_stream_open')return browsers.open(args);
  if(command==='workspace_chrome_stream_close'){await browsers.close(args.id);return;}
  if(command==='agent_integration_health')return Promise.all(['claude','codex'].map(agent=>integrations.health(agent)));
  if(command==='agent_session_summaries'||command==='session_history'||command==='pr_watch_list')return [];
  if(command==='agent_events_poll')return readAgentEvents(HOME+'/.canopy/agent-events.jsonl',args.cursor);
  if(command==='hook_bridge_path')return HOME+'/.canopy/agent-events.jsonl';
  if(command==='agent_hooks_installed')return integrations.installed(args.agent);
  if(command==='setup_agent_hooks')return integrations.setup(args.agent);
  if(command==='workspace_add')return scoped(target);
  if(command==='workspace_list')return [ROOT];
  if(command==='workspace_remove')return;
  if(command==='workspace_register'||command==='workspace_unregister'||command==='fs_register_roots'||command==='fs_unregister_roots')return;
  if(command==='pty_metadata_get')return metadata('ide-terminals.json',{});
  if(command==='pty_metadata_set'){const next=metadataWrites.catch(()=>{}).then(async()=>{const all=await metadata('ide-terminals.json',{});all[String(args.id)]=args.value;await saveMetadata('ide-terminals.json',all);});metadataWrites=next;await next;return;}
  throw Error(`The Linux workspace does not support ${command} yet`);
}
export function startNativeServer(){
  const secret=process.env.CANOPY_RUNNER_TOKEN;if(!secret)throw Error('Workspace authentication required');
  const expected=Buffer.from('Bearer '+secret);
  const screens=terminalScreens(secret);
  const authorized=request=>{const auth=Buffer.from(request.headers.authorization??'');return auth.length===expected.length&&timingSafeEqual(auth,expected);};
  const server=http.createServer(async(request,response)=>{if(!authorized(request))return json(response,401,{error:'Unauthorized'});try{const input=await body(request);const resize=request.url.match(/^\/sessions\/(\d+)\/resize$/);if(resize)return json(response,200,await screens.resize(Number(resize[1]),input.cols,input.rows));if(request.url!=='/native')throw Error('Unknown workspace operation');return json(response,200,{result:(await nativeInvoke(input.command,input.args))??null});}catch(error){return json(response,400,{error:error.message});}});
  const wss=new WebSocketServer({noServer:true,maxPayload:256000,perMessageDeflate:false});
  server.on('upgrade',(request,socket,head)=>{const match=request.url.match(/^\/sessions\/(\d+)\/stream$/),browser=request.url.match(/^\/browsers\/([a-f0-9-]{36})\/stream$/);if(!authorized(request)||(!match&&!browser))return socket.destroy();wss.handleUpgrade(request,socket,head,client=>{client.on('error',()=>{});if(browser){try{browsers.attach(browser[1],client);}catch{client.close(1008,'Unknown browser');}return;}void screens.attach(Number(match[1]),client).catch(()=>client.close(1011,'Terminal unavailable'));});});
  server.on('close',()=>{screens.dispose();browsers.dispose();});
  server.maxConnections=32;server.requestTimeout=30000;server.headersTimeout=10000;server.listen(8081,'0.0.0.0');
}

if(process.argv[1]===new URL(import.meta.url).pathname)startNativeServer();
