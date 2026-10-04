import {readdir,readFile,readlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const exec=promisify(execFile);
const agents=['claude','codex','amp','aider','agy','opencode','omp','cursor-agent','grok'];
export function parseProcessStat(raw){
 const end=raw.lastIndexOf(')'),start=raw.indexOf('('),tail=raw.slice(end+2).trim().split(/\s+/);
 if(start<0||end<start||tail.length<22)throw Error('Invalid process record');
 return {pid:Number(raw.slice(0,start).trim()),name:raw.slice(start+1,end),parent:Number(tail[1]),group:Number(tail[2]),tty:Number(tail[4]),foreground:Number(tail[5]),ticks:Number(tail[11])+Number(tail[12]),started:Number(tail[19]),rss:Number(tail[21])};
}
export function processAgentHint(argv,exe,name){
 const direct=[argv[0],exe,name].filter(Boolean).map(value=>path.basename(value));
 for(const bin of agents)if(direct.includes(bin))return {bin,pkg:null,path:exe,interactive:true};
 const script=argv[1]??'';
 const packages=[['@anthropic-ai/claude-code','claude'],['@openai/codex','codex'],['@ampcode/cli','amp'],['opencode-ai','opencode'],['@oh-my-pi/pi-coding-agent','omp']];
 for(const [pkg,bin] of packages)if(script.includes('/node_modules/'+pkg+'/'))return {bin,pkg:'npm:'+pkg,path:script,interactive:true};
 if(path.basename(script)==='aider'||script.includes('/aider/'))return {bin:'aider',pkg:'py:aider',path:script,interactive:true};
 return null;
}
export function bindSessionProcesses(sessions,processes,runnerPid,known=new Map()){
 const active=sessions.filter(session=>session.exitCode==null).sort((a,b)=>a.id-b.id);
 const roots=processes.filter(proc=>proc.parent===runnerPid&&proc.tty!==0).sort((a,b)=>a.started-b.started||a.pid-b.pid);
 const byPid=new Map(processes.map(proc=>[proc.pid,proc]));
 // Use runner PIDs or the per-spawn marker, never titles or creation order:
 // concurrent account preparation can reorder process launches.
 for(const session of active){const proc=byPid.get(session.pid);if(proc&&proc.parent===runnerPid&&proc.tty!==0)known.set(session.id,{pid:proc.pid,started:proc.started});}
 for(const session of active){
  if(known.has(session.id)||!session.requestId)continue;
  let proc=processes.find(proc=>proc.requestId===session.requestId);
  for(let depth=0;proc&&depth<64;depth++){
   if(proc.parent===runnerPid&&proc.tty!==0){known.set(session.id,{pid:proc.pid,started:proc.started});break;}
   proc=byPid.get(proc.parent);
  }
 }
 // A single legacy live PTY is unambiguous and can be recovered in place.
 if(active.length===1&&roots.length===1&&!known.has(active[0].id))known.set(active[0].id,{pid:roots[0].pid,started:roots[0].started});
 return new Map(active.flatMap(session=>{const identity=known.get(session.id),proc=identity&&byPid.get(identity.pid);return proc&&proc.started===identity.started?[[session.id,proc]]:[];}));
}
export function sessionProcessReader(){
 const known=new Map(),previous=new Map();let units;
 return async sessions=>{
  units??=Promise.all(['CLK_TCK','PAGESIZE'].map(name=>exec('getconf',[name]).then(result=>Number(result.stdout))));
  const [hz,pageSize]=await units;
  const processes=[];let runnerPid;
  for(const id of (await readdir('/proc')).filter(id=>/^\d+$/.test(id)).slice(0,4096)){
   try{const proc=parseProcessStat(await readFile('/proc/'+id+'/stat','utf8'));const argv=(await readFile('/proc/'+id+'/cmdline','utf8')).split('\0').slice(0,2);proc.argv=argv;proc.exe=await readlink('/proc/'+id+'/exe').catch(()=>null);
    if(path.basename(argv[0]??'')==='node'&&['runner.mjs','/opt/canopy/runner.mjs'].includes(argv[1]))runnerPid=proc.pid;
    if(sessions.some(session=>session.requestId)){const env=await readFile('/proc/'+id+'/environ','utf8').catch(()=> '');proc.requestId=env.split('\0').find(value=>value.startsWith('CANOPY_SESSION_REQUEST_ID='))?.slice('CANOPY_SESSION_REQUEST_ID='.length);}
    processes.push(proc);
   }catch{/* Processes may exit between reads. */}
  }
  const bindings=runnerPid?bindSessionProcesses(sessions,processes,runnerPid,known):new Map();
  const liveIds=new Set(sessions.filter(session=>session.exitCode==null).map(session=>session.id));
  for(const id of known.keys())if(!liveIds.has(id))known.delete(id);
  const byPid=new Map(processes.map(proc=>[proc.pid,proc])),now=performance.now();
  const belongs=(proc,root)=>{for(let depth=0;proc&&depth<64;depth++){if(proc.pid===root.pid)return true;proc=byPid.get(proc.parent);}return false;};
  const measured=new Map(processes.map(proc=>{
   const old=previous.get(proc.pid),cpu=old&&old.started===proc.started&&now>old.at?Math.max(0,(proc.ticks-old.ticks)/hz/((now-old.at)/1000)*100):0;
   return [proc.pid,{pid:proc.pid,parent:proc.parent,name:proc.name,cmd:path.basename(proc.argv[0]??proc.exe??proc.name),cpu,mem_bytes:Math.max(0,proc.rss*pageSize)}];
  }));
  previous.clear();for(const proc of processes)previous.set(proc.pid,{started:proc.started,ticks:proc.ticks,at:now});
  return sessions.filter(session=>session.exitCode==null).map(session=>{
   const root=bindings.get(session.id),owned=root?processes.filter(proc=>belongs(proc,root)):[],procs=owned.map(proc=>measured.get(proc.pid));
   const foreground=root&&owned.filter(proc=>proc.tty===root.tty&&proc.group===root.foreground);
   const hint=foreground?.map(proc=>processAgentHint(proc.argv,proc.exe,proc.name)).find(Boolean)??null;
   return {id:session.id,title:session.title,cwd:'/workspace',total_cpu:procs.reduce((sum,proc)=>sum+proc.cpu,0),total_mem_bytes:procs.reduce((sum,proc)=>sum+proc.mem_bytes,0),procs,ports:[],agent_hint:hint,quiet_ms:null,since_input_ms:null,output_bytes:0};
  });
 };
}
