import {invoke} from '@tauri-apps/api/core';
import {RemoteExecutionClient} from './client';
export async function sharedSessionClient(workspaceId:string,isCurrent:()=>boolean){
 const clientId=crypto.randomUUID(),endpoint=`https://${workspaceId}.workspaces.canopyide.dev`;
 let cached:{token:string;expiresAt:number}|null=null;
 const resolve=async()=>{
  if(!isCurrent())throw Error('Account or workspace changed. Reopen shared sessions.');
  if(cached&&cached.expiresAt>Date.now()+30000)return cached.token;
  const result=await invoke<{connection:{workspaceId:string;endpoint:string;token:string};expiresAt:string}>('canopy_account_request',{route:'/api/operations',body:{action:'shared-session-connect',workspaceId,clientId}});
  if(!isCurrent()||result.connection.workspaceId!==workspaceId||result.connection.endpoint!==endpoint||typeof result.connection.token!=='string'||!result.connection.token)throw Error('Shared session workspace identity changed.');cached={token:result.connection.token,expiresAt:Date.parse(result.expiresAt)};return cached.token;
 };
 const token=await resolve();return new RemoteExecutionClient(endpoint,token,resolve);
}
