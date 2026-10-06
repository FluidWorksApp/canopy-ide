import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {processAgentHint,parseProcessStat} from './session-processes.mjs';
// Unknown processes prevent automatic shutdown. No command lines or user paths
// leave the workspace; an idle CPU sample alone is never proof a job is done.
export async function workspaceActivity(){
 let activeAgents=0,activeJobs=0,unknownActivity=false;
 const ids=(await readdir('/proc')).filter(id=>/^\d+$/.test(id));
 if(ids.length>4096)return {activeAgents:0,activeJobs:0,unknownActivity:true,sampledAt:Date.now()};
 for(const id of ids){
  if(Number(id)===process.pid)continue;
  try{
   const argv=(await readFile(`/proc/${id}/cmdline`,'utf8')).split('\0').filter(Boolean);
   if(!argv.length)continue;
   const name=path.basename(argv[0]),stat=parseProcessStat(await readFile(`/proc/${id}/stat`,'utf8'));
   if(processAgentHint(argv,argv[0],stat.name)){activeAgents++;continue;}
   if(name==='node'&&['/opt/canopy/runner.mjs','runner.mjs'].includes(argv[1]))continue;
   // Even an open shell might hold a function/job not represented by children.
   // Keep it alive until its session has ended rather than risking work loss.
   if(['Xvfb','x11vnc','openbox','xfwm4','xfce4-session','xfce4-panel','xfsettingsd','xfdesktop','dbus-daemon','dbus-launch','at-spi-bus-launcher','at-spi2-registryd','xfconfd','tini','docker-init'].includes(name))continue;
   activeJobs++;
  }catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')unknownActivity=true;}
 }
 return {activeAgents,activeJobs,unknownActivity,sampledAt:Date.now()};
}
