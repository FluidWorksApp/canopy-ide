// Proof receipts in a Linux workspace: the workspace (not the agent) re-runs a
// project's checks and reports the raw exit code and output tail. The desktop
// twin is src-tauri/src/receipt.rs; both answer `receipt_run_check` with the
// same shape, so src/receipts/ never knows which side ran it.
//
// Not the native host's shared `run()`: that throws on a non-zero exit (the
// failing suite's output is the evidence we need most), caps output at 1 MB by
// failing, and shares a four-slot pool with git, so a three-minute test run
// would starve every panel. Checks get their own single slot here.
import {spawn} from 'node:child_process';

const DEFAULT_TIMEOUT=5*60*1000, CEILING=20*60*1000;
const DEFAULT_KEEP=64*1024, MAX_KEEP=1024*1024;

/** Keeps the first or last `max` bytes while draining everything. */
export function capture(max,tail){
 let chunks=[],size=0,truncated=false;
 return {
  push(chunk){
   if(tail){chunks.push(chunk);size+=chunk.length;if(size>max*2){const all=Buffer.concat(chunks);chunks=[all.subarray(all.length-max)];size=max;truncated=true;}}
   else if(size<max){const take=chunk.subarray(0,max-size);chunks.push(take);size+=take.length;if(take.length<chunk.length)truncated=true;}
   else truncated=true;
  },
  done(){let all=Buffer.concat(chunks);if(tail&&all.length>max){all=all.subarray(all.length-max);truncated=true;}return {text:all.toString('utf8'),truncated};},
 };
}

let active=Promise.resolve();
/** Run one check. `scoped` confines cwd to the workspace. */
export function receiptRunCheck(args,{scoped,env=process.env,home}){
 const run=active.catch(()=>{}).then(()=>runOne(args,{scoped,env,home}));
 active=run;
 return run;
}

async function runOne(args,{scoped,env,home}){
 const argv=args?.argv;
 if(!Array.isArray(argv)||!argv.length||argv.length>256||argv.some(a=>typeof a!=='string'||a.length>16384||a.includes('\0'))||!argv[0].trim())throw Error('Invalid check command');
 const cwd=await scoped(String(args.cwd??''));
 const keep=Math.min(MAX_KEEP,Math.max(1024,Number(args.keepBytes)||DEFAULT_KEEP));
 const timeout=Math.min(CEILING,Math.max(100,Number(args.timeoutMs)||DEFAULT_TIMEOUT));
 const tail=!args.head;
 // Same scrub as the desktop: CANOPY* would make the check look like an agent
 // session to the hooks. CI=1 keeps every runner we parse out of watch mode.
 const childEnv=Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('CANOPY')));
 Object.assign(childEnv,{CI:'1',NO_COLOR:'1',FORCE_COLOR:'0',GIT_TERMINAL_PROMPT:'0'},home?{HOME:home}:{});
 const started=Date.now();
 return new Promise(resolve=>{
  let child;
  try{child=spawn(argv[0],argv.slice(1),{cwd,env:childEnv,stdio:['ignore','pipe','pipe'],detached:true});}
  catch(error){resolve(result({spawnError:`could not start \`${argv[0]}\`: ${error.message}`}));return;}
  const out=capture(keep,tail),err=capture(keep,tail);
  let timedOut=false,settled=false;
  const killGroup=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}};
  const timer=setTimeout(()=>{timedOut=true;killGroup();},timeout);
  child.stdout.on('data',chunk=>out.push(chunk));
  child.stderr.on('data',chunk=>err.push(chunk));
  child.once('error',error=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result({spawnError:`could not start \`${argv[0]}\`: ${error.message}`}));});
  child.once('exit',()=>{if(!timedOut&&child.pid)killGroup();});
  child.once('close',(code)=>{
   if(settled)return;settled=true;clearTimeout(timer);
   const o=out.done(),e=err.done();
   resolve(result({code:timedOut?null:code,stdout:o.text,stderr:e.text,stdoutTruncated:o.truncated,stderrTruncated:e.truncated,timedOut,durationMs:Date.now()-started}));
  });
 });
}

function result(r){return {code:null,stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false,timedOut:false,durationMs:0,spawnError:null,...r};}
