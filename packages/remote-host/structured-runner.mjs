// Headless agent attempts with structured (JSON-lines) output, run beside the
// code (src-tauri/src/structured_runner.rs). Lines go to the caller's channel
// as {kind:'line'|'stderr'|'exit'}; stdin stays open for follow-up turns when
// asked. The task store authorizes each attempt: it must be running and its
// cwd must be the worktree the task reserved. Like the desktop's mint_attempt,
// the runner gets a context-bridge credential: the gateway mints one for the
// attempt (`harness`) and the Canopy service keeps it while
// structured_runner_live still lists the attempt.
import {spawn} from 'node:child_process';
import {stat,realpath} from 'node:fs/promises';
import {harnessEnvironment} from './runner-harness.mjs';
const STDERR_KEEP=8*1024,STDOUT_LINE_MAX=1024*1024;
const validId=id=>typeof id==='string'&&id.length>0&&id.length<=128&&/^[A-Za-z0-9_-]+$/.test(id);
export const STRUCTURED_RUNNER_READ_ONLY=[];
/** Split a stream into lines of at most `max` bytes, marking truncation. */
export function lineSplitter(max,onLine){
 let parts=[],size=0,truncated=false;
 const flush=()=>{onLine(Buffer.concat(parts).toString('utf8'),truncated);parts=[];size=0;truncated=false;};
 return {push(chunk){let start=0;for(;;){const nl=chunk.indexOf(10,start);const end=nl<0?chunk.length:nl+1;const piece=chunk.subarray(start,end);if(!truncated){const keep=Math.min(piece.length,max-size);parts.push(piece.subarray(0,keep));size+=keep;truncated=keep<piece.length;}if(nl<0)return;flush();start=end;if(start>=chunk.length)return;}},end(){if(size||truncated)flush();}};
}
export function structuredRunnerCommands({home,scoped,authorize}){
 const running=new Map();
 const check=(attemptId,controlToken)=>{const run=running.get(attemptId);if(!run)throw Error(`structured runner attempt is not running: ${attemptId}`);if(run.controlToken!==controlToken)throw Error('structured runner control token does not match the attempt');return run;};
 const killGroup=run=>{try{process.kill(-run.child.pid,'SIGKILL');}catch{try{run.child.kill('SIGKILL');}catch{}}};
 return {
  structured_runner_spawn:async({attemptId,controlToken,command,args=[],cwd,env,keepStdin,onData,harness})=>{
   if(!validId(attemptId))throw Error('a structured runner requires a valid attempt id');
   if(!validId(controlToken))throw Error('a structured runner requires a valid control token');
   if(typeof command!=='string'||!command||command.includes('\0'))throw Error('a structured runner requires a command');
   if(!Array.isArray(args)||args.length>256||args.some(a=>typeof a!=='string'||a.includes('\0')))throw Error('Invalid structured runner arguments');
   let directory;try{directory=await realpath(await scoped(String(cwd)));if(!(await stat(directory)).isDirectory())throw Error();}catch{throw Error(`structured runner cwd does not exist: ${cwd}`);}
   await authorize(attemptId,directory);
   if(running.has(attemptId))throw Error(`structured runner attempt is already active: ${attemptId}`);
   const extra=Array.isArray(env)?env:[];
   if(extra.some(pair=>!Array.isArray(pair)||!/^[_A-Za-z][_A-Za-z0-9]*$/.test(String(pair[0]))||typeof pair[1]!=='string'))throw Error('Invalid environment variable');
   const bridge=harnessEnvironment(harness??null);
   const child=spawn(command,args,{cwd:directory,stdio:['pipe','pipe','pipe'],detached:true,env:{...process.env,HOME:home,CANOPY:'1',...bridge,...Object.fromEntries(extra)}});
   try{await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}
   catch(error){throw Error(`could not start \`${command}\`: ${error.message} — Canopy could not find it on this machine's PATH`);}
   if(keepStdin===false)child.stdin.end();child.stdin.on('error',()=>{});
   const run={child,controlToken,stdin:keepStdin===false?null:child.stdin};running.set(attemptId,run);
   const send=message=>onData?.send(message);
   const out=lineSplitter(STDOUT_LINE_MAX,(line,truncated)=>{let text=line.trimEnd();if(truncated)text+='\n[Canopy: runner line truncated after 1 MiB]';if(text.trim())send({kind:'line',text});});
   let kept=0;const err=lineSplitter(STDERR_KEEP,(line,truncated)=>{let text=line.trimEnd();if(truncated)text+='\n[Canopy: stderr line truncated]';kept+=text.length;if(kept<=STDERR_KEEP)send({kind:'stderr',text});});
   child.stdout.on('data',chunk=>out.push(chunk));child.stderr.on('data',chunk=>err.push(chunk));
   let streams=2;const ended=()=>{if(--streams===0)finish();};child.stdout.on('end',()=>{out.end();ended();});child.stderr.on('end',()=>{err.end();ended();});
   let code;let exited=false;
   // A killed attempt reports no exit, like the desktop: its watcher finds it gone.
   const finish=()=>{if(!exited||streams>0)return;if(running.get(attemptId)===run){running.delete(attemptId);send({kind:'exit',code});}onData?.close();};
   child.on('exit',status=>{code=status;exited=true;killGroup(run);finish();});
   onData?.onClose(()=>{if(running.get(attemptId)===run){running.delete(attemptId);killGroup(run);}});
   return {pid:child.pid??null};
  },
  /** Attempts whose runner is still running: the service keeps their
   *  context-bridge credentials while they are listed. */
  structured_runner_live:async()=>[...running.keys()],
  structured_runner_write:async({attemptId,controlToken,line})=>{
   const run=check(attemptId,controlToken);
   if(!run.stdin)throw Error(`structured runner ${attemptId} takes its prompt at launch, not on stdin`);
   await new Promise((resolve,reject)=>run.stdin.write(String(line)+'\n',error=>error?reject(Error(`could not reach structured runner ${attemptId}: ${error.message}`)):resolve()));
  },
  structured_runner_kill:async({attemptId,controlToken})=>{
   const run=check(attemptId,controlToken);running.delete(attemptId);killGroup(run);
   let timer;await Promise.race([new Promise(resolve=>run.child.exitCode!==null||run.child.signalCode?resolve():run.child.once('exit',resolve)),new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);clearTimeout(timer);
  },
 };
}
