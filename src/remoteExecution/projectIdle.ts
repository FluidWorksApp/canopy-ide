import {invoke} from '@tauri-apps/api/core';
import {activeWorkspace} from './workspace';
import {canSwitchExecutionMode} from '../executionMode';
import {isAccountWorkspace} from './accountWorkspace';
let pending=false;
/** Closing the final project is an explicit request to stop its compute. */
export async function stopIdleProjectWorkspace(stillIdle:()=>boolean,notify:(message:string)=>void){
 const active=activeWorkspace();
 if(pending||!active||!isAccountWorkspace(active.connection))return;
 // A member closing their projects cannot stop the shared owner's compute.
 // This is a UI guard; the control plane independently enforces ownership.
 let memberConnection=!!active.connection.scope;
 try{memberConnection ||= JSON.parse(atob(active.connection.token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'))).version===2;}catch{}
 if(memberConnection){active.setProjectIdle(true);return;}
 pending=true;
 try{
  let reason='The workspace is still open in another IDE. It will keep running until that session closes.';
  for(let attempt=0;attempt<6;attempt++){
   await new Promise(resolve=>setTimeout(resolve,5000));
   if(!stillIdle()||!canSwitchExecutionMode()||activeWorkspace()!==active)return;
   active.setProjectIdle(true);
   const result=await invoke<{accepted:boolean;reason?:string}>('canopy_account_request',{route:'/api/operations',body:{workspaceId:active.connection.workspaceId,action:'hibernate-if-alone',clientId:active.connectionClientId,confirmInterrupt:true,requestKey:crypto.randomUUID()}});
   if(result.accepted){notify('All projects are closed or hibernating. The workspace is stopping; files and setup are saved.');return;}
   if(result.reason)reason=result.reason;
  }
  notify(reason);
 }catch{notify('Could not stop the workspace. It may still be running; retry Stop workspace in Workspaces.');}
 finally{pending=false;}
}
