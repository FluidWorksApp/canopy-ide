// Git-derived workspace information; hookless sessions have no invented agent state.
export async function agentWorkspaceAt(args,{run,scoped}){
 const repo=await scoped(args.repo),cwd=await scoped(args.cwd??args.repo);
 const git=(argv,dir=cwd)=>run('git',argv,dir);
 const optional=async(argv,dir=cwd)=>{try{return (await git(argv,dir)).trim();}catch{return null;}};
 const common=async dir=>await git(['rev-parse','--path-format=absolute','--git-common-dir'],dir);
 if((await common(repo)).trim()!==(await common(cwd)).trim())throw Error('The agent directory belongs to another repository');
 const top=await scoped((await git(['rev-parse','--show-toplevel'])).trim());
 const branch=await optional(['symbolic-ref','--short','HEAD']);
 let base=await optional(['symbolic-ref','--short','refs/remotes/origin/HEAD']);
 if(!base)for(const candidate of ['origin/main','origin/master','main','master'])if(await optional(['rev-parse','--verify','--quiet',candidate])){base=candidate;break;}
 base??=branch??'HEAD';
 const onBase=!!branch&&[base.split('/').at(-1),'main','master','develop','development','trunk','staging','production'].includes(branch);
 const counts=(await optional(['rev-list','--left-right','--count',`${base}...HEAD`]))?.split(/\s+/).map(Number)??[0,0];
 const upstream=await optional(['rev-parse','--abbrev-ref','@{upstream}']);
 const unpushed=upstream?Number(await optional(['rev-list','--count',`${upstream}..HEAD`])):null;
 const status=await git(['status','--porcelain=v1','-z','--untracked-files=normal']);
 const entries=status.split('\0');let dirty=0;for(let i=0;i<entries.length;i++){if(!entries[i])continue;dirty++;if(/^[RC]|^.[RC]/.test(entries[i]))i++;}
 const log=onBase?'':await optional(['log','--max-count=100','--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%D',`${base}..HEAD`]);
 const commits=(log??'').split('\n').filter(Boolean).map(line=>{const [hash,short,author,date,subject,refs]=line.split('\x1f');return {hash,short,author,date,subject,refs:refs??''};});
 const gitDir=await optional(['rev-parse','--path-format=absolute','--git-dir']);
 return {session_id:typeof args.sessionId==='string'?args.sessionId:'',agent:args.agent??null,state:null,state_via:null,cwd,updated:null,active_secs:null,run_secs:null,touched:[],branch,detached:!branch,base,on_base:onBase,workdir:top,isolated:gitDir!==((await common(cwd)).trim()),cwd_missing:false,dirty,ahead:counts[1]??0,behind:counts[0]??0,unpushed,merged:!onBase&&!!(await optional(['merge-base','--is-ancestor','HEAD',base])===''),commits};
}
