import {execFileSync,spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';
export function sharedGitArguments(args,config,remotes=[]){
 const url=new URL(config.url);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||! /^[\w-]{43}$/.test(config.token)||! /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[-\w.]{1,100}$/.test(config.repository)||['.','..'].includes(config.repository.split('/')[1]))throw Error('Invalid shared Git facade');
 const original='https://github.com/'+config.repository,match=value=>value===original||value===original+'.git';
 // Exact URL and exact configured remote matches; prefix-based insteadOf would
 // accidentally hijack personal repositories with similar names.
 const index=args.findIndex(value=>['fetch','push','pull','remote','ls-remote','clone'].includes(value));
 const command=args[index],tail=args.slice(index+1);let name='origin';
 if(command==='remote'&&tail[0]==='get-url')name=tail[1];
 else if(['fetch','push','pull'].includes(command))name=tail.find(value=>!value.startsWith('-'))??'origin';
 const selected=remotes.find(remote=>remote.name===name&&match(remote.url));
 // Rewrite is installed only for a single requested shared remote. Git's URL
 // config is prefix based; applying it to --all or a personal remote is unsafe.
 const overrides=selected&&!tail.includes('--all')?['-c','url.'+url.href+'.insteadOf='+selected.url]:[];
 const rewritten=args.map(value=>match(value)?url.href:value);
 return ['-c','http.'+url.href+'.extraHeader=Authorization: Bearer '+config.token,'-c','http.'+url.href+'.followRedirects=false',...overrides,...rewritten];
}
export function sharedGitInvocations(args,config,remotes=[]){
 const command=args.indexOf('fetch');
 if(command<0||!args.slice(command+1).includes('--all'))return [sharedGitArguments(args,config,remotes)];
 const names=[...new Set(remotes.filter(remote=>/^[\w.-]+$/.test(remote.name)&&!remote.skipFetchAll).map(remote=>remote.name))];
 return names.map(name=>sharedGitArguments(args.map((value,index)=>index>command&&value==='--all'?name:value),config,remotes));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const config=JSON.parse(process.argv[2]),args=process.argv.slice(3);let remotes=[];
  try{remotes=execFileSync('/usr/bin/git',['config','--get-regexp','^remote\\..*\\.url$'],{encoding:'utf8',timeout:5000}).trim().split('\n').map(line=>{const match=line.match(/^remote\.(.+)\.url (.*)$/);return match?{name:match[1],url:match[2]}:{name:'',url:''};});}catch{}
  let child;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child?.kill(signal));
  for(const remote of remotes){try{remote.skipFetchAll=execFileSync('/usr/bin/git',['config','--bool','--get','remote.'+remote.name+'.skipFetchAll'],{encoding:'utf8',timeout:5000}).trim()==='true';}catch{}}
  let status=0;for(const invocation of sharedGitInvocations(args,config,remotes)){const code=await new Promise(resolve=>{child=spawn('/usr/bin/git',invocation,{stdio:'inherit',env:process.env});child.on('error',()=>resolve(1));child.on('exit',value=>resolve(value??1));});if(code)status=code;}process.exit(status);
 }catch{console.error('Shared Git setup is unavailable');process.exit(1);}
}
