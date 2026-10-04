import {spawn} from 'node:child_process';
import {lstat,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {repositorySource} from './git-source.mjs';

export class CloneJobs {
 constructor({scoped,home='/home/agent',launch=spawn,now=Date.now}){this.scoped=scoped;this.home=home;this.launch=launch;this.now=now;this.jobs=new Map();this.pending=0;}
 async start(parent,raw){
  for(const [id,job] of this.jobs)if(job.finishedAt&&this.now()-job.finishedAt>900000)this.jobs.delete(id);
  if([...this.jobs.values()].filter(job=>job.state==='cloning').length+this.pending>=2||this.jobs.size+this.pending>=32)throw Error('Another clone is already running. Try again after it completes.');
  this.pending++;
  try {
  const {url,name}=repositorySource(raw),directory=await this.scoped(parent),destination=await this.scoped(path.join(directory,name),true);
  try{await lstat(destination);throw Error('A folder with this repository name already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  // Reserve a fresh directory; cancellation never removes user files.
  await mkdir(destination,{mode:0o700});
  const id=randomUUID(),job={id,state:'cloning',stage:'Connecting to repository',percent:null,name,path:destination,startedAt:this.now(),finishedAt:null};this.jobs.set(id,job);
  let child;
  try{child=this.launch('git',['clone','--progress','--',url,destination],{cwd:directory,env:{...process.env,HOME:this.home,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'},stdio:['ignore','ignore','pipe']});}catch{job.state='failed';job.error='Git could not start';job.finishedAt=this.now();return this.status(id);}
  job.child=child;let pending='';
  const finish=(state,error)=>{if(job.state!=='cloning')return;job.state=state;job.error=error;job.finishedAt=this.now();clearTimeout(job.timer);delete job.child;};
  child.stderr.on('data',chunk=>{
   pending=(pending+chunk.toString()).slice(-8192);const lines=pending.split(/[\r\n]/);pending=lines.pop()??'';
   for(const line of lines){const match=line.match(/(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking out files):\s*(\d+)%/);if(match){job.stage=match[1];job.percent=Math.min(100,Number(match[2]));}
    if(/Authentication failed|could not read Username|Permission denied/.test(line))job.failure='Git authentication failed. Connect the workspace Git account and try again.';
    else if(/Repository not found|repository .*not found/.test(line))job.failure='Repository not found or access denied.';
   }
  });
  child.once('error',()=>finish('failed','Git could not start'));
  child.once('close',code=>finish(code===0?'complete':'failed',code===0?null:(job.failure??'Git clone failed. Check repository access and connection. Incomplete files were kept.')));
  job.timer=setTimeout(()=>{if(job.state==='cloning'){child.kill('SIGTERM');finish('failed','Git clone timed out. Incomplete files were kept.');}},300000);job.timer.unref();
  return this.status(id);
  } finally {this.pending--;}
 }
 status(id){const job=this.jobs.get(id);if(!job)throw Error('Clone job not found');return {id:job.id,state:job.state,stage:job.stage,percent:job.percent,name:job.name,path:job.path,startedAt:job.startedAt,elapsedSeconds:Math.floor((this.now()-job.startedAt)/1000),error:job.error??null};}
 cancel(id){const job=this.jobs.get(id);if(!job)throw Error('Clone job not found');if(job.state==='cloning'){job.state='cancelled';job.finishedAt=this.now();clearTimeout(job.timer);job.child?.kill('SIGTERM');delete job.child;}return this.status(id);}
}
