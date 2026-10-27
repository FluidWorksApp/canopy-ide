// What a refused branch switch means, read from git's (or gh's) own words.
// git.rs's switch classification ported once for the workspace host:
// gh_pr_checkout (github.mjs) and git_checkout_carry / git_checkout_detached
// (git-ops.mjs) answer with the same outcomes, so both use this module.
const lines=text=>text?String(text).split('\n').map(l=>l.replace(/\r$/,'')):[];
const unquote=text=>text.trim().replace(/^'+|'+$/g,'');
const quoted=line=>{const m=/'([^']*)'/.exec(line);return m?m[1]:null;};

/** `git worktree list --porcelain`, as git.rs reads it. */
export function parseWorktrees(out){
 const list=[];let cur=null;
 for(const line of lines(out)){
  if(!line.trim()){if(cur)list.push(cur);cur=null;continue;}
  const at=line.indexOf(' '),key=at<0?line:line.slice(0,at),value=at<0?'':line.slice(at+1);
  if(key==='worktree'){if(cur)list.push(cur);cur={path:value,name:value.split('/').at(-1),head:'',branch:null,detached:false,bare:false,locked:null,prunable:null,is_main:false,dirty:0};}
  else if(!cur)continue;
  else if(key==='HEAD')cur.head=[...value].slice(0,8).join('');
  else if(key==='branch')cur.branch=value.replace(/^(refs\/heads\/)+/,'');
  else if(key==='detached')cur.detached=true;
  else if(key==='bare')cur.bare=true;
  else if(key==='locked')cur.locked=value||'locked';
  else if(key==='prunable')cur.prunable=value||'prunable';
 }
 if(cur)list.push(cur);
 list.forEach((w,i)=>{w.is_main=i===0;});
 return list;
}

/** The two refusals git states first: the branch is checked out elsewhere, or
 *  the switch would overwrite local changes. */
export function classifyCheckout(err){
 const ls=lines(err);
 const held=ls.find(l=>l.includes('is already used by worktree at'));
 if(held)return {kind:'branch_in_worktree',path:unquote(held.slice(held.indexOf('worktree at ')+12))};
 for(let i=0;i<ls.length;i++){
  if(!ls[i].includes('would be overwritten by'))continue;
  const files=[];for(let j=i+1;j<ls.length&&/^\s/.test(ls[j])&&ls[j].trim();j++)files.push(ls[j].trim());
  return {kind:'local_changes',files,untracked:ls[i].includes('untracked')};
 }
 return {kind:'unknown'};
}

const MID=[['cannot switch branch while merging','merge'],['cannot switch branch while rebasing','rebase'],['cannot switch branch while cherry-picking','cherry-pick'],['cannot switch branch while reverting','revert'],['in the middle of an am session','am'],['you need to resolve your current index first','merge']];
const UNREACHABLE=["couldn't find remote ref pull/",'no git remotes found','Could not resolve to a PullRequest','remote unreachable, or it wants credentials','gh auth login'];

/** Every other refusal git.rs tells apart, or null. */
export function classifyExtra(err){
 for(const raw of lines(err)){
  const l=raw.trim();
  if(l.includes('refusing to fetch into branch ')&&l.includes(' checked out at '))return {kind:'branch_in_worktree',path:unquote(l.slice(l.indexOf(' checked out at ')+16))};
  const mid=MID.find(([text])=>l.includes(text));if(mid)return {kind:'mid_operation',op:mid[1]};
  if(l.includes('a branch named ')&&l.includes(' already exists')&&quoted(l)!=null)return {kind:'name_taken',branch:quoted(l)};
  if(l.includes("' already exists")&&!l.includes('a branch named ')&&quoted(l)!=null)return {kind:'path_in_use',path:quoted(l)};
  if(l.includes('pathspec ')&&l.includes(' did not match')&&quoted(l)!=null)return {kind:'nothing_called',name:quoted(l)};
  const invalid=l.indexOf('invalid reference: ');if(invalid>=0)return {kind:'nothing_called',name:unquote(l.slice(invalid+19))};
  if(l.includes('cannot remove a locked working tree')||l.includes('cannot move a locked working tree')){const at=l.indexOf('lock reason: ');return {kind:'locked_workspace',path:'',reason:at>=0&&l.slice(at+13).trim()||'locked'};}
  if(l.includes("Unable to create '")&&l.includes("index.lock': File exists"))return {kind:'another_command'};
  if(UNREACHABLE.some(t=>l.includes(t)))return {kind:'remote_unreachable',summary:l.replace(/^fatal: /,'')};
 }
 return null;
}

/** gh appends `failed to run git: exit status N` after git's own lines; it comes off the detail only. */
export function stripGhNoise(err){
 const ls=lines(err);
 while(ls.length){const t=ls.at(-1).trim();if(!t||/^failed to run git: exit status \s*[+-]?\d+\s*$/.test(t))ls.pop();else break;}
 return ls.join('\n').trim();
}

export function remoteUnreachableFor(err,pr=null){
 const detail=stripGhNoise(err),l=detail.toLowerCase();
 const summary=['gh auth login','not logged in','requires authentication','wants credentials','authentication failed'].some(t=>l.includes(t))?"Canopy couldn't reach GitHub with the sign-in it has."
  :l.includes('no git remotes found')||l.includes('does not appear to be a git repo')?'This project has no remote to fetch from.'
  :l.includes("couldn't find remote ref")||l.includes('could not resolve to a pullrequest')?`GitHub doesn't have a copy of ${pr!=null?`#${pr}'s changes`:'those changes'} to fetch. A private fork you can't read is the usual reason.`
  :"Canopy couldn't reach GitHub just now.";
 return {kind:'remote_unreachable',summary,detail};
}

export const repoBusy=op=>({kind:'repo_busy',operation:op,detail:`git ${op} --quit — the ${op} state is cleared; the working tree is untouched.`});

/** A refused switch to `target` as the outcome the IDE shows. The lookups that
 *  need the repository come from the caller: who holds a branch, whether a
 *  missing name could be created, and whether a path is a known worktree. */
export async function switchFailure(err,target,{holderAt,canCreateBranch,isKnownWorktree,pr=null}){
 const detail=stripGhNoise(err),first=classifyCheckout(err);
 if(first.kind==='branch_in_worktree')return {kind:'branch_in_worktree',holder:await holderAt(first.path)};
 if(first.kind==='local_changes')return {kind:'local_changes',files:first.files,untracked:first.untracked,detail};
 const extra=classifyExtra(err);
 switch(extra?.kind){
  case 'branch_in_worktree':return {kind:'branch_in_worktree',holder:await holderAt(extra.path)};
  case 'mid_operation':return repoBusy(extra.op);
  case 'another_command':return {kind:'repo_busy',operation:'another-command',detail};
  case 'name_taken':return {kind:'name_taken',branch:extra.branch,detail};
  case 'nothing_called':return {kind:'nothing_called',name:extra.name,can_create:await canCreateBranch(extra.name),detail};
  case 'path_in_use':return {kind:'path_in_use',path:extra.path,usable:await isKnownWorktree(extra.path),detail};
  case 'locked_workspace':{const holder=await holderAt(extra.path);holder.locked??=extra.reason;return {kind:'branch_in_worktree',holder};}
  case 'remote_unreachable':return remoteUnreachableFor(err,pr);
  default:return {kind:'failed',summary:`Git couldn't switch to ${target}.`,detail};
 }
}
