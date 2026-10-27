// GitHub CLI commands for the Linux workspace, with the same argv, JSON field
// selection and result shapes as the desktop's git.rs gh_* commands. gh runs in
// the VM under HOME=/home/agent, signed in by profile_import_git, so it rides
// the CLI's stored auth exactly as the desktop does; this module never holds a
// token. gh goes through ctx.execute rather than ctx.run because run_net's
// contract needs things run can't give: stdout+stderr on success, stdout kept
// on a failed `gh api graphql`, a request body on stdin, and 8 MiB streams.
import {access,constants,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {delimiter,isAbsolute,join} from 'node:path';
import {parseWorktrees,stripGhNoise,remoteUnreachableFor,repoBusy,switchFailure} from './checkout-errors.mjs';

const NET_TIMEOUT_SECS=120, STREAM_MAX=8*1024*1024, MAX_PATCH_FILES=400;
export const GITHUB_READ_ONLY=['gh_auth','gh_available','gh_issue_detail','gh_issue_list','gh_pr_body','gh_pr_conversation','gh_pr_diff','gh_pr_diff_since','gh_pr_failing_logs','gh_pr_links','gh_pr_list','gh_pr_reviewer_candidates','gh_pr_state'];

// ---------- parsing, shared with tests ----------
const s=v=>typeof v==='string'?v:'';
const u=v=>Number.isInteger(v)&&v>=0?v:0;
const b=v=>typeof v==='boolean'?v:false;
const nodes=(v,key)=>Array.isArray(v?.[key]?.nodes)?v[key].nodes:[];
const lines=text=>text?text.split('\n').map(l=>l.replace(/\r$/,'')):[];
const isFullSha=v=>(v.length===40||v.length===64)&&/^[0-9a-f]+$/.test(v);
const fullSha=v=>{const x=s(v).trim().toLowerCase();return isFullSha(x)?x:'';};
const rustDebug=v=>JSON.stringify(v);
const pick=(map,key)=>typeof key==='string'&&Object.hasOwn(map,key)?map[key]:undefined;
const METHODS={squash:'--squash',merge:'--merge',rebase:'--rebase'},VERBS={squash:'Squashed and merged',merge:'Merged',rebase:'Rebased and merged'};
const REVIEW_FLAGS={approve:'--approve',comment:'--comment','request-changes':'--request-changes'},REVIEW_EVENTS={approve:'APPROVE',comment:'COMMENT','request-changes':'REQUEST_CHANGES'};

/** gh's statusCheckRollup → [state, "passed/total checks passed"]; failure beats pending beats success. */
export function rollUpChecks(rollup){
 if(!Array.isArray(rollup)||!rollup.length)return ['',''];
 let passed=0,failed=0,pending=0;
 for(const it of rollup){
  if(typeof it?.state==='string'){if(it.state==='SUCCESS')passed++;else if(it.state==='PENDING'||it.state==='EXPECTED')pending++;else failed++;}
  else if(s(it?.status)!=='COMPLETED')pending++;
  else if(['SUCCESS','NEUTRAL','SKIPPED'].includes(s(it?.conclusion)))passed++;else failed++;
 }
 return [failed?'FAIL':pending?'PENDING':'PASS',`${passed}/${passed+failed+pending} checks passed`];
}
export const rollupState=state=>({SUCCESS:'PASS',FAILURE:'FAIL',ERROR:'FAIL',PENDING:'PENDING',EXPECTED:'PENDING'})[state]??'';
export const isDiffTooLarge=err=>{const e=err.toLowerCase();return e.includes('too_large')||e.includes('exceeded the maximum number of lines')||(e.includes('406')&&e.includes('diff'));};

/** GitHub's per-file entries (one JSON object per line) → the unified patch `gh pr diff` would have printed. */
export function assemblePatch(text){
 let out='',files=0,skipped=0;
 for(const line of lines(text).filter(l=>l.trim())){
  let f;try{f=JSON.parse(line);}catch{continue;}
  const path=s(f?.filename);if(!path)continue;
  if(files>=MAX_PATCH_FILES){skipped++;continue;}
  files++;
  const status=s(f.status),prev=s(f.previous_filename);
  const old=status==='added'?'/dev/null':status==='renamed'?`a/${prev}`:`a/${path}`;
  const neu=status==='removed'?'/dev/null':`b/${path}`;
  out+=`diff --git a/${status==='renamed'?prev:path} b/${path}\n`;
  if(typeof f.patch==='string')out+=`--- ${old}\n+++ ${neu}\n${f.patch.replace(/\n+$/,'')}\n`;
  else{const changes=u(f.changes);out+=`Binary files a/${path} and b/${path} differ\n`+(changes?`(GitHub didn't include this file's patch — ${changes} changed lines. Open it on GitHub.)\n`:'');}
 }
 if(skipped)out+=`diff --git a/… b/…\nBinary files a/… and b/… differ\n(${skipped} more file(s) not shown — this pull request touches more than ${MAX_PATCH_FILES}.)\n`;
 return out;
}

// GitHub can fail to map an outdated thread's line onto the current diff and
// report it as an error beside an otherwise complete answer; only that one is tolerated.
const reviewThreadLineError=e=>{const path=Array.isArray(e?.path)?e.path:[];return path.includes('reviewThreads')&&['line','startLine'].includes(path.at(-1))&&['Line could not be resolved','Start line could not be resolved'].includes(s(e?.message));};
export function graphqlData(out){
 let v;try{v=JSON.parse(out);}catch(e){throw Error(`gh returned unexpected output: ${e.message}`);}
 if(Array.isArray(v?.errors)){const fatal=v.errors.filter(e=>!reviewThreadLineError(e));if(fatal.length){const msg=fatal.map(e=>e?.message).filter(m=>typeof m==='string').join('; ');throw Error(msg||'GitHub rejected the request');}}
 return v?.data??null;
}

const comment=c=>({id:s(c?.id),author:s(c?.author?.login),body:s(c?.body),created:s(c?.createdAt),url:s(c?.url),mine:b(c?.viewerDidAuthor),association:s(c?.authorAssociation)});
export function parseConversation(data,number){
 const pr=data?.repository?.pullRequest;
 if(pr==null)throw Error(`#${number} not found on this repository`);
 const reviews=nodes(pr,'reviews').map(r=>({id:s(r?.id),author:s(r?.author?.login),body:s(r?.body),state:s(r?.state),submitted:s(r?.submittedAt),url:s(r?.url),mine:b(r?.viewerDidAuthor),association:s(r?.authorAssociation),commit:s(r?.commit?.oid)}));
 // Your latest *submitted* review anchors the delta view (ties: the later one, as Rust's max_by).
 const mine=reviews.filter(r=>r.mine&&r.state!=='PENDING'&&r.commit).reduce((best,r)=>!best||r.submitted>=best.submitted?r:best,null);
 const first=nodes(pr,'commits')[0];
 return {node_id:s(pr.id),body:s(pr.body),head_sha:s(pr.headRefOid),viewer:s(data?.viewer?.login),review_decision:s(pr.reviewDecision),mergeable:s(pr.mergeable),state:s(pr.state),
  checks:first?rollupState(s(first?.commit?.statusCheckRollup?.state)):'',auto_merge:pr.autoMergeRequest!=null,draft:b(pr.isDraft),
  comments:nodes(pr,'comments').map(comment),reviews,
  threads:nodes(pr,'reviewThreads').map(t=>({id:s(t?.id),path:s(t?.path),line:u(t?.line),start_line:u(t?.startLine),side:s(t?.diffSide),resolved:b(t?.isResolved),outdated:b(t?.isOutdated),comments:nodes(t,'comments').map(comment)})),
  files:nodes(pr,'files').map(f=>({path:s(f?.path),viewed:s(f?.viewerViewedState)==='VIEWED',additions:u(f?.additions),deletions:u(f?.deletions)})),
  my_last_review_sha:mine?.commit??''};
}
const link=(v,kind,thisRepo)=>{const repo=s(v?.repository?.nameWithOwner);return {kind,number:u(v?.number),title:s(v?.title),url:s(v?.url),state:s(v?.state),draft:b(v?.isDraft),repo:!repo||repo===thisRepo?'':repo,base:s(v?.baseRefName)};};
export function parseLinks(data,number,thisRepo){
 const repo=data?.repository,pr=repo?.pullRequest;
 const closes=nodes(pr,'closingIssuesReferences').map(n=>link(n,'issue',thisRepo)),children=nodes(repo,'children').map(n=>link(n,'pr',thisRepo)),parents=nodes(repo,'parents').map(n=>link(n,'pr',thisRepo));
 // A URL names one thing across every repo; it appears once, in its most specific group.
 const seen=new Set([...closes,...children,...parents].map(l=>l.url)),mentions=[];
 for(const n of nodes(pr,'timelineItems')){
  const kind={Issue:'issue',PullRequest:'pr'}[n?.source?.__typename];if(!kind)continue;
  const l=link(n.source,kind,thisRepo);if(!l.url)continue;
  if(l.kind==='pr'&&l.number===number&&!l.repo)continue;
  if(!seen.has(l.url)){seen.add(l.url);mentions.push(l);}
 }
 return {closes,children,parents,mentions};
}
export function parseAsyncMerge(out,number,verb){
 let v;try{v=JSON.parse(out);}catch(e){throw Error(`GitHub returned an unexpected merge response: ${e.message}`);}
 const message=typeof v?.details?.message==='string'?v.details.message:'GitHub did not explain the merge result',status=s(v?.status);
 if(status==='merged')return {message:`${verb} #${number}`,pending:false};
 if(status==='pending'||status==='enqueued')return {message:`Merge started for #${number} — GitHub is processing its PR stack`,pending:true};
 if(status==='failed')throw Error(message);
 throw Error(`GitHub returned an unknown asynchronous merge status ${rustDebug(status)}: ${message}`);
}

// ---------- checkout outcomes (git.rs CheckoutOutcome & friends) ----------
// gh_pr_checkout answers with the same outcomes as a plain branch switch;
// checkout-errors.mjs holds git.rs's switch classification for both.
export {parseWorktrees,stripGhNoise,remoteUnreachableFor};
const settled=(message,path,before)=>{
 if(!before.orphan_commits.length)return {kind:'switched',message,path};
 const first=before.orphan_commits[0].split(/\s+/)[0]??'';
 return {kind:'switched_with_leftovers',message,commits:before.orphan_commits,detail:`git branch saved-${first} ${first} — the commit gets a name, and stops being reachable only by luck.`};
};

// ---------- commands ----------
export function githubCommands(ctx){
 const env=extra=>({...process.env,HOME:ctx.home,GIT_TERMINAL_PROMPT:'0',...extra});
 // One child process with stdin always closed (an open pipe would leave gh
 // waiting for input that never comes) and the body written when there is one.
 const exec=(bin,argv,cwd,{input,timeout=NET_TIMEOUT_SECS*1000,extra={GH_PROMPT_DISABLED:'1'}}={})=>{
  const p=ctx.execute(bin,argv,{cwd,timeout,maxBuffer:STREAM_MAX,killSignal:'SIGKILL',env:env(extra)});
  const stdin=p.child?.stdin;if(stdin){stdin.on('error',()=>{});stdin.end(input??undefined);}else if(input!=null)throw Error('workspace cannot send a request body');
  return p;
 };
 // run_net: stdout+stderr trimmed on success; stderr (else stdout) on failure;
 // `keep` is run_graphql, which keeps a failed call's stdout for graphqlData.
 async function gh(argv,cwd,{input,keep=false}={}){
  try{const {stdout,stderr}=await exec('gh',argv,cwd,{input});return (String(stdout)+String(stderr)).trim();}
  catch(e){
   if(e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')throw Error(`network command output exceeded the ${STREAM_MAX/1024/1024} MiB per-stream limit`);
   if(e.killed||e.signal)throw Error(`timed out after ${NET_TIMEOUT_SECS}s — remote unreachable, or it wants credentials this app can't prompt for`);
   if(typeof e.code!=='number')throw Error(e.message);
   const out=String(e.stdout??''),err=String(e.stderr??'');
   if(keep&&out.trim())return out.trim();
   throw Error((err.trim()?err:out).trim());
  }
 }
 const parse=out=>{try{return JSON.parse(out);}catch(e){throw Error(`gh returned unexpected output: ${e.message}`);}};
 async function repoPath(repo){
  if(typeof repo!=='string'||!repo||repo.length>4096||/[\0\r\n]/.test(repo))throw Error('invalid repository path');
  const dir=await ctx.scoped(repo);
  return ctx.scoped((await ctx.run('git',['rev-parse','--show-toplevel'],dir)).trim());
 }
 async function nwo(top){
  const name=(await gh(['repo','view','--json','nameWithOwner','--jq','.nameWithOwner'],top)).trim(),at=name.indexOf('/');
  if(at<0)throw Error(`couldn't read owner/name from ${rustDebug(name)}`);
  return [name.slice(0,at),name.slice(at+1)];
 }
 // Deliberate deviation: string variables go as -f (raw), numbers as -F. The
 // desktop sends everything with -F, which reads `@path` values from disk and
 // retypes "42"/"true" — a reply starting with "@alice" would read a file.
 const graphql=async(top,query,vars)=>graphqlData(await gh(['api','graphql','-f',`query=${query}`,...vars.flatMap(([k,v])=>[typeof v==='number'?'-F':'-f',`${k}=${v}`])],top,{keep:true}));
 const graphqlJson=async(top,query,variables)=>graphqlData(await gh(['api','graphql','--input','-'],top,{input:JSON.stringify({query,variables}),keep:true}));
 const me=async top=>{try{return (await gh(['api','user','--jq','.login'],top)).trim();}catch{return '';}};

 const num=(v,max=0xffffffff)=>{if(!Number.isSafeInteger(v)||v<0||v>max)throw Error('invalid pull request or issue number');return v;};
 const text=(v,what,max=1<<20)=>{if(typeof v!=='string'||v.length>max||v.includes('\0'))throw Error(`invalid ${what}`);return v;};
 const opt=(v,what)=>v==null?'':text(v,what);
 const bool=(v,what)=>{if(typeof v!=='boolean')throw Error(`invalid ${what}`);return v;};
 const id=(v,what)=>{text(v,what,1024);if(!v||/[\s]/.test(v))throw Error(`invalid ${what}`);return v;};
 const method=m=>{const flag=pick(METHODS,m);if(!flag)throw Error(`unsupported merge method: ${m}`);return flag;};

 // --- checkout machinery, per git.rs ---
 const git=(argv,cwd)=>ctx.run('git',argv,cwd);
 // git.rs run(): a failure carries stdout and stderr joined, which the stash
 // outcomes show as their detail.
 const gitJoined=async(argv,cwd)=>{try{return String((await exec('git',argv,cwd,{timeout:60000,extra:{}})).stdout);}catch(e){if(typeof e.code!=='number')throw Error(e.message);throw Error([String(e.stdout??'').trim(),String(e.stderr??'').trim()].filter(Boolean).join('\n'));}};
 const sameDir=async(a,c)=>{if(a===c)return true;try{return (await realpath(a))===(await realpath(c));}catch{return false;}};
 async function scanWorktrees(top){
  const list=parseWorktrees(await git(['worktree','list','--porcelain'],top));
  for(const w of list)if(w.prunable==null&&w.locked!=null&&!w.is_main&&!existsSync(w.path))w.prunable='its folder is gone';
  return list;
 }
 const agentPath=p=>p.includes('/.claude/worktrees/')||p.includes('\\.claude\\worktrees\\');
 const holderOf=(branch,w,dirty)=>({branch,path:w.path,name:w.name,agent:agentPath(w.path),is_main:w.is_main,dirty,locked:w.locked,prunable:w.prunable,head:w.head});
 async function branchHolder(top,branch){
  let list;try{list=await scanWorktrees(top);}catch{return null;}
  let w=null;for(const x of list)if(x.branch===branch&&!(await sameDir(x.path,top))){w=x;break;}
  if(!w)return null;
  let dirty=0;if(w.prunable==null&&!w.bare){try{dirty=(await git(['status','--porcelain'],w.path)).split('\n').filter(l=>l.trim()).length;}catch{}}
  return holderOf(branch,w,dirty);
 }
 async function holderAt(top,branch,path){
  const h=await branchHolder(top,branch);if(h)return h;
  try{for(const w of await scanWorktrees(top))if(await sameDir(w.path,path))return holderOf(branch,w,0);}catch{}
  return {branch,path,name:path.replace(/[\/\\]+$/,'').split(/[\/\\]/).at(-1)??path,agent:agentPath(path),is_main:await sameDir(path,top),dirty:0,locked:null,prunable:null,head:''};
 }
 async function repoState(top){
  let dir;try{const d=(await git(['rev-parse','--git-dir'],top)).trim();dir=isAbsolute(d)?d:join(top,d);}catch{dir=join(top,'.git');}
  const has=p=>existsSync(join(dir,p));
  const mid=has('rebase-merge')?'rebase':has('rebase-apply')?(has('rebase-apply/applying')?'am':'rebase'):has('MERGE_HEAD')?'merge':has('CHERRY_PICK_HEAD')?'cherry-pick':has('REVERT_HEAD')?'revert':null;
  const ok=async argv=>{try{await git(argv,top);return true;}catch{return false;}};
  const unborn=!(await ok(['rev-parse','--verify','--quiet','HEAD'])),detached=!(await ok(['symbolic-ref','--quiet','HEAD']));
  let orphan_commits=[];
  if(detached&&!unborn){try{orphan_commits=(await git(['log','--max-count=20','--format=%h %s','HEAD','--not','--branches','--remotes'],top)).split('\n').map(l=>l.trim()).filter(Boolean);}catch{}}
  return {mid,unborn,orphan_commits};
 }
 const canCreateBranch=async(top,name)=>{
  if((await repoState(top)).unborn)return false;
  try{await gitJoined(['check-ref-format','--branch',name],top);}catch{return false;}
  try{await git(['rev-parse','--verify','--quiet',`refs/heads/${name}`],top);return false;}catch{return true;}
 };
 const isKnownWorktree=async(top,path)=>{try{for(const w of await scanWorktrees(top))if(await sameDir(w.path,path))return true;}catch{}return false;};
 // Refusals read as git.rs reads them (checkout-errors.mjs).
 async function switchFailed(top,target,err){
  return switchFailure(err,target,{holderAt:path=>holderAt(top,target,path),canCreateBranch:name=>canCreateBranch(top,name),isKnownWorktree:path=>isKnownWorktree(top,path)});
 }
 const stashTop=async top=>{try{return (await git(['rev-parse','-q','--verify','refs/stash'],top)).trim()||null;}catch{return null;}};
 // Set the working tree aside, do the thing, put it back; a failed pop leaves the stash, and says so.
 async function carrying(top,branch,f){
  const before=await stashTop(top);
  try{await gitJoined(['stash','push','--include-untracked','-m',`canopy: switching to ${branch}`],top);}
  catch(e){return {stopped:{kind:'failed',summary:"Your changes couldn't be set aside, so nothing was moved.",detail:stripGhNoise(e.message)}};}
  const after=await stashTop(top),stashed=after!=null&&after!==before;
  try{await f();}catch(e){if(stashed){try{await gitJoined(['stash','pop'],top);}catch{}}return {stopped:await switchFailed(top,branch,e.message)};}
  if(!stashed)return {changes:false};
  try{await gitJoined(['stash','pop'],top);return {changes:true};}
  catch(e){return {stopped:{kind:'changes_stashed',stash:after??'refs/stash',detail:e.message}};}
 }

 const prJson=async({repo,number},field)=>{const top=await repoPath(repo);return gh(['pr','view',String(num(number)),'--json',field,'--jq',`.${field}`],top);};
 return {
  async gh_available(){try{await exec('gh',['--version'],undefined,{timeout:15000,extra:{}});return true;}catch{return false;}},
  async gh_auth(){
   let installed=false;try{await exec('gh',['--version'],undefined,{timeout:15000,extra:{}});installed=true;}catch{}
   if(!installed)return {installed:false,path:'',authenticated:false,account:'',host:'',detail:''};
   // `gh api user` is the honest test: `gh auth status` reports a revoked token as signed in.
   let authenticated=false,account='',detail='';
   try{account=String((await exec('gh',['api','user','--jq','.login'],undefined)).stdout).trim();authenticated=true;}
   catch(e){detail=typeof e.code==='number'?(String(e.stderr??'').trim().split('\n')[0]??''):String(e.message);}
   let host='';
   try{const o=await exec('gh',['auth','status'],undefined,{timeout:30000,extra:{}});host=hostLine(String(o.stdout)+String(o.stderr));}catch(e){if(typeof e.code==='number')host=hostLine(String(e.stdout??'')+String(e.stderr??''));}
   return {installed:true,path:await whichGh(),authenticated,account,host,detail};
  },
  async gh_pr_list({repo}){
   const top=await repoPath(repo);
   const v=parse(await gh(['pr','list','--limit','50','--state','open','--json','number,title,author,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,state,url,createdAt,updatedAt,reviewDecision,additions,deletions,mergeable,statusCheckRollup'],top));
   const login=await me(top);
   return Array.isArray(v)?v.map(p=>{const author=s(p?.author?.login),[checks,checks_summary]=rollUpChecks(p?.statusCheckRollup);return {number:u(p?.number),title:s(p?.title),author,branch:s(p?.headRefName),base:s(p?.baseRefName),draft:b(p?.isDraft),state:s(p?.state),url:s(p?.url),created:s(p?.createdAt),updated:s(p?.updatedAt),review_decision:s(p?.reviewDecision),additions:u(p?.additions),deletions:u(p?.deletions),mine:!!login&&author===login,mergeable:typeof p?.mergeable==='string'?p.mergeable:'UNKNOWN',checks,checks_summary,head_sha:fullSha(p?.headRefOid),base_sha:fullSha(p?.baseRefOid)};}):[];
  },
  // GitHub refuses one combined diff past 20,000 lines; the per-file patches are still served.
  async gh_pr_diff({repo,number}){
   const top=await repoPath(repo),n=String(num(number));
   try{return await gh(['pr','diff',n],top);}
   catch(e){if(!isDiffTooLarge(e.message))throw e;const [owner,name]=await nwo(top);return assemblePatch(await gh(['api','--paginate','--jq','.[] | @json',`repos/${owner}/${name}/pulls/${n}/files?per_page=100`],top));}
  },
  gh_pr_body:args=>prJson(args,'body'),
  async gh_pr_state(args){return (await prJson(args,'state')).trim().toUpperCase();},
  async gh_pr_review({repo,number,action,body}){
   const top=await repoPath(repo),n=num(number);
   const flag=pick(REVIEW_FLAGS,action);
   if(!flag)throw Error(`unsupported review action: ${action}`);
   const text_=opt(body,'review body'),argv=['pr','review',String(n),flag];
   if(text_.trim())argv.push('--body',text_);else if(flag!=='--approve')throw Error('a comment is required for this review action');
   await gh(argv,top);
   return flag==='--approve'?`Approved #${n}`:flag==='--request-changes'?`Requested changes on #${n}`:`Commented on #${n}`;
  },
  async gh_pr_checkout({repo,number,carry}){
   const top=await repoPath(repo),n=num(number);bool(carry??false,'carry');
   let head;
   try{const v=JSON.parse(await gh(['pr','view',String(n),'--json','headRefName,isCrossRepository'],top));head=s(v?.headRefName);}
   catch(e){if(e instanceof SyntaxError)head='';else return remoteUnreachableFor(e.message,n);}
   if(!head.trim())return {kind:'remote_unreachable',summary:`GitHub didn't say which branch #${n} comes from.`,detail:'gh pr view --json headRefName returned no head branch.'};
   const holder=await branchHolder(top,head);if(holder)return {kind:'branch_in_worktree',holder};
   const before=await repoState(top);if(before.mid)return repoBusy(before.mid);
   const checkout=()=>gh(['pr','checkout',String(n)],top);
   const message=`Checked out #${n} — you're on ${head}`;
   if(carry){const r=await carrying(top,head,checkout);return r.stopped??settled(r.changes?`${message}, with your changes`:message,null,before);}
   try{await checkout();return settled(message,null,before);}catch(e){return switchFailed(top,head,e.message);}
  },
  async gh_pr_merge({repo,number,method:m}){
   const top=await repoPath(repo),n=num(number),flag=method(m),verb=VERBS[m];
   try{await gh(['pr','merge',String(n),flag],top);return {message:`${verb} #${n}`,pending:false};}
   catch(e){
    // Stacked PRs reject gh's GraphQL merge; GitHub's REST async merge is the one route for them.
    if(!(e.message.includes('part of a stack')&&e.message.includes('asynchronous merge REST API')))throw e;
    const [owner,name]=await nwo(top);
    return parseAsyncMerge(await gh(['api','--method','PUT',`repos/${owner}/${name}/pulls/${n}/merge-async`,'-f',`merge_method=${m}`,'-f','merge_action=default'],top),n,verb);
   }
  },
  async gh_pr_close({repo,number,deleteBranch}){
   const top=await repoPath(repo),n=num(number),del=bool(deleteBranch??false,'deleteBranch');
   await gh(['pr','close',String(n),...(del?['--delete-branch']:[])],top);
   return del?`Closed #${n} and deleted its branch`:`Closed #${n}`;
  },
  async gh_pr_ready({repo,number}){const top=await repoPath(repo),n=num(number);await gh(['pr','ready',String(n)],top);return `#${n} is ready for review`;},
  async gh_pr_conversation({repo,number}){
   const top=await repoPath(repo),n=num(number),[owner,name]=await nwo(top);
   return parseConversation(await graphql(top,PR_CONVERSATION_QUERY,[['owner',owner],['name',name],['number',n]]),n);
  },
  // Real JSON on stdin: a branch named "42" must reach String! as a string.
  async gh_pr_links({repo,number,head,base}){
   const top=await repoPath(repo),n=num(number),[owner,name]=await nwo(top);
   return parseLinks(await graphqlJson(top,PR_LINKS_QUERY,{owner,name,number:n,head:text(head,'head branch',1024),base:text(base,'base branch',1024)}),n,`${owner}/${name}`);
  },
  async gh_pr_thread_reply({repo,threadId,body}){
   const reply=text(body,'reply');if(!reply.trim())throw Error('a reply needs a body');
   const top=await repoPath(repo);
   await graphql(top,'mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}',[['t',id(threadId,'thread id')],['b',reply]]);
   return 'Replied';
  },
  async gh_pr_thread_resolved({repo,threadId,resolved}){
   const top=await repoPath(repo),on=bool(resolved,'resolved');
   await graphql(top,on?'mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}':'mutation($t:ID!){unresolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}',[['t',id(threadId,'thread id')]]);
   return on?'Resolved':'Reopened';
  },
  async gh_pr_file_viewed({repo,prId,path,viewed}){
   const top=await repoPath(repo),on=bool(viewed,'viewed');
   await graphql(top,on?'mutation($p:ID!,$f:String!){markFileAsViewed(input:{pullRequestId:$p,path:$f}){clientMutationId}}':'mutation($p:ID!,$f:String!){unmarkFileAsViewed(input:{pullRequestId:$p,path:$f}){clientMutationId}}',[['p',id(prId,'pull request id')],['f',text(path,'path',4096)]]);
   return null;
  },
  async gh_pr_review_batch({repo,prId,event,body,threads}){
   const ev=pick(REVIEW_EVENTS,event);
   if(!ev)throw Error(`unsupported review action: ${event}`);
   if(!Array.isArray(threads)||threads.length>1000)throw Error('invalid review threads');
   const drafts=threads.map(t=>{
    const line=num(t?.line),start=t?.start_line==null?null:num(t.start_line),side=text(t?.side,'diff side',16);
    const o={path:text(t?.path,'path',4096),line,side};if(start!=null&&start>0&&start<line){o.startLine=start;o.startSide=side;}o.body=text(t?.body,'comment');return o;
   });
   const review=opt(body,'review body');
   if(ev!=='APPROVE'&&!review.trim()&&!drafts.length)throw Error('a comment is required for this review action');
   const top=await repoPath(repo);
   await graphqlJson(top,'mutation($p:ID!,$e:PullRequestReviewEvent!,$b:String,$t:[DraftPullRequestReviewThread!]){addPullRequestReview(input:{pullRequestId:$p,event:$e,body:$b,threads:$t}){pullRequestReview{url}}}',{p:id(prId,'pull request id'),e:ev,b:review,t:drafts});
   const k=drafts.length,suffix=!k?'':k===1?' with 1 inline comment':` with ${k} inline comments`;
   return (ev==='APPROVE'?'Approved':ev==='REQUEST_CHANGES'?'Requested changes':'Review posted')+suffix;
  },
  async gh_pr_update_branch({repo,number}){const top=await repoPath(repo),n=num(number);await gh(['pr','update-branch',String(n)],top);return `#${n} updated from its base`;},
  async gh_pr_request_review({repo,number,reviewers}){
   if(!Array.isArray(reviewers))throw Error('invalid reviewers');
   if(!reviewers.length)throw Error('no reviewer to ask');
   for(const r of reviewers)if(typeof r!=='string'||!r||r.length>256||r.startsWith('-')||/[\s\0]/.test(r))throw Error('invalid reviewer');
   const top=await repoPath(repo),n=num(number);
   await gh(['pr','edit',String(n),...reviewers.flatMap(r=>['--add-reviewer',r])],top);
   return `Asked ${reviewers.join(', ')} to review #${n}`;
  },
  async gh_pr_retarget({repo,number,base}){
   const to=text(base,'base branch',1024).trim();
   if(!to||to.startsWith('-'))throw Error('choose a valid base branch');
   const top=await repoPath(repo),n=num(number);
   await gh(['pr','edit',String(n),'--base',to],top);
   return `Stacked #${n} on ${to}`;
  },
  // Listing collaborators needs push access; without it an empty list is the honest answer.
  async gh_pr_reviewer_candidates({repo}){
   const top=await repoPath(repo),[owner,name]=await nwo(top);
   let out='';try{out=await gh(['api','--paginate','--jq','.[].login',`repos/${owner}/${name}/collaborators?per_page=100`],top);}catch{}
   return lines(out).map(l=>l.trim()).filter(Boolean);
  },
  async gh_pr_auto_merge({repo,number,method:m,enable}){
   const top=await repoPath(repo),flag=method(m),n=num(number),on=bool(enable,'enable');
   await gh(on?['pr','merge',String(n),'--auto',flag]:['pr','merge',String(n),'--disable-auto'],top);
   return on?`#${n} will merge automatically once its checks and reviews pass`:`Auto-merge off for #${n}`;
  },
  // Only the end of a failed run's log says what broke: three checks, 120 lines each.
  async gh_pr_failing_logs({repo,number}){
   const top=await repoPath(repo),n=num(number);
   let v=null;try{v=JSON.parse(await gh(['pr','checks',String(n),'--json','name,state,link'],top));}catch(e){if(!(e instanceof SyntaxError))throw e;}
   const failed=Array.isArray(v)?v.filter(c=>['FAILURE','ERROR','TIMED_OUT','CANCELLED'].includes(s(c?.state))):[];
   let report='';
   for(const c of failed.slice(0,3)){
    const name=s(c.name),url=s(c.link);report+=`=== ${name} (${url})\n`;
    // Deviation: only an all-digit run id reaches gh, so a link can never smuggle an option.
    const run=url.includes('/runs/')?url.split('/runs/')[1].split('/')[0]:'';
    if(!/^\d+$/.test(run)){report+="(no run id in this check's link — open it on GitHub)\n\n";continue;}
    try{report+=lines(await gh(['run','view',run,'--log-failed'],top)).slice(-120).map(l=>l+'\n').join('');}
    catch(e){report+=`(couldn't read the log: ${e.message})\n`;}
    report+='\n';
   }
   return report;
  },
  async gh_pr_diff_since({repo,baseSha,headSha}){
   if(!baseSha||!headSha)throw Error('need two commits to compare');
   // Deviation: both ends become part of an API path, so they must look like a commit or ref.
   for(const r of [baseSha,headSha])if(typeof r!=='string'||r.length>255||!/^[A-Za-z0-9._\/-]+$/.test(r)||r.startsWith('-')||r.includes('..'))throw Error('invalid commit id');
   const top=await repoPath(repo),[owner,name]=await nwo(top);
   return gh(['api','-H','Accept: application/vnd.github.v3.diff',`repos/${owner}/${name}/compare/${baseSha}...${headSha}`],top);
  },
  async gh_issue_list({repo}){
   const top=await repoPath(repo);
   const v=parse(await gh(['issue','list','--state','all','--limit','80','--json','number,title,state,url,assignees,updatedAt,body,labels'],top));
   const login=await me(top);
   return Array.isArray(v)?v.map(i=>{
    const assignees=Array.isArray(i?.assignees)?i.assignees.map(a=>a?.login).filter(l=>typeof l==='string'):[],state=s(i?.state).toLowerCase();
    // GitHub has no priority field; a priority/P0-style label stands in for one.
    const label=Array.isArray(i?.labels)?i.labels.map(l=>s(l?.name)).find(n=>/^(p0|p1|priority)/.test(n.toLowerCase())):undefined;
    return {id:`#${u(i?.number)}`,title:s(i?.title),state,state_type:state,assignee:assignees[0]??null,mine:!!login&&assignees.includes(login),url:s(i?.url),branch:null,body:s(i?.body),priority:label??'',updated_at:s(i?.updatedAt)};
   }):[];
  },
  async gh_issue_detail({repo,number}){
   const top=await repoPath(repo),n=num(number,Number.MAX_SAFE_INTEGER);
   const v=parse(await gh(['issue','view',String(n),'--json','author,createdAt,updatedAt,state,comments'],top));
   const comments=Array.isArray(v?.comments)?v.comments.map(c=>({id:s(c?.id),author:typeof c?.author?.login==='string'?c.author.login:'ghost',body:s(c?.body),created_at:s(c?.createdAt),url:s(c?.url)})):[];
   return {internal_id:'',author:typeof v?.author?.login==='string'?v.author.login:'ghost',created_at:s(v?.createdAt),updated_at:s(v?.updatedAt),state:s(v?.state).toLowerCase(),state_id:'',states:[],comments};
  },
  async gh_issue_set_state({repo,number,open}){
   const top=await repoPath(repo),n=num(number,Number.MAX_SAFE_INTEGER);
   await gh(['issue',bool(open,'open')?'reopen':'close',String(n)],top);return null;
  },
  async gh_issue_comment({repo,number,body}){
   const note=text(body,'comment').trim();if(!note)throw Error('comment cannot be empty');
   const top=await repoPath(repo),n=num(number,Number.MAX_SAFE_INTEGER);
   await gh(['issue','comment',String(n),'--body',note],top);return null;
  },
 };
}

// `Logged in to <host> ...` from `gh auth status`; git.rs takes the fourth
// word of the first line that starts with it (after leading whitespace).
const hostLine=text=>{const l=lines(text).find(x=>x.trimStart().startsWith('Logged in to'));return l?.trim().split(/\s+/)[3]??'';};
// The desktop resolves gh through the login shell; here PATH is the whole story.
async function whichGh(){
 for(const dir of String(process.env.PATH??'').split(delimiter).filter(Boolean)){const p=join(dir,'gh');try{await access(p,constants.X_OK);return p;}catch{}}
 return 'gh';
}

const PR_CONVERSATION_QUERY=`
query($owner:String!,$name:String!,$number:Int!){
  viewer{ login }
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id body isDraft mergeable reviewDecision state
      headRefOid
      autoMergeRequest{ enabledAt }
      comments(first:100){nodes{ id author{login} body createdAt url viewerDidAuthor authorAssociation }}
      reviews(first:50){nodes{ id author{login} body state submittedAt url viewerDidAuthor authorAssociation commit{oid} }}
      reviewThreads(first:100){nodes{
        id isResolved isOutdated path line startLine diffSide
        comments(first:50){nodes{ id author{login} body createdAt url viewerDidAuthor authorAssociation }}
      }}
      files(first:100){nodes{ path viewerViewedState additions deletions }}
      commits(last:1){nodes{commit{ statusCheckRollup{ state } }}}
    }
  }
}`;
const PR_LINKS_QUERY=`
query($owner:String!,$name:String!,$number:Int!,$head:String!,$base:String!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      closingIssuesReferences(first:20){nodes{
        number title url state repository{nameWithOwner}
      }}
      timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{
        ... on CrossReferencedEvent{ source{
          __typename
          ... on Issue{ number title url state repository{nameWithOwner} }
          ... on PullRequest{ number title url state isDraft repository{nameWithOwner} }
        }}
      }}
    }
    children: pullRequests(baseRefName:$head,states:[OPEN],first:20){nodes{
      number title url state isDraft baseRefName
    }}
    parents: pullRequests(headRefName:$base,states:[OPEN],first:5){nodes{
      number title url state isDraft baseRefName
    }}
  }
}`;
