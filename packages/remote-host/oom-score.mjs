// When memory runs out the kernel kills the process with the highest
// oom_score_adj first. Every process canopy-host starts inherits the service's
// value, so a runaway dev server and the agent that started it look the same.
// Raising a score needs no privilege: terminals' builds, servers and checks are
// raised so the kernel takes them before the host, its runner or an agent CLI.
import {readFile,writeFile} from 'node:fs/promises';

export const EXPENDABLE_SCORE=800;

/** Raise each pid's oom_score_adj to `score` (never lowers one). A process that
 *  exited, or one this user may not touch, is skipped. */
export async function raiseOomScore(pids,score=EXPENDABLE_SCORE,{read=f=>readFile(f,'utf8'),write=writeFile}={}){
 let raised=0;
 for(const pid of new Set(pids)){
  if(!Number.isSafeInteger(pid)||pid<=1)continue;
  const file=`/proc/${pid}/oom_score_adj`;
  try{
   if(Number((await read(file)).trim())>=score)continue;
   await write(file,String(score));raised++;
  }catch{/* exited, or not ours */}
 }
 return raised;
}
