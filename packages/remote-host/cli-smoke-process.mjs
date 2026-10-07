import {execFile} from 'node:child_process';
// Headless CLI prompts have no interactive/piped context. Codex still reads
// non-TTY stdin with a positional prompt, so EOF must be explicit.
export function runSmokeCli(command,args,options){
 return new Promise((resolve,reject)=>{
  const child=execFile(command,args,options,(error,stdout,stderr)=>{
   if(error)return reject(error);
   if(child.killed)return reject(Error('CLI smoke timed out: '+command));
   resolve({stdout,stderr});
  });
  child.stdin?.on('error',()=>{});child.stdin?.end();
 });
}
