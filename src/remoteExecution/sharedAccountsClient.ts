import {invoke} from '@tauri-apps/api/core';
import {RemoteExecutionClient} from './client';
export async function sharedAccountRequest<T>(workspaceId:string,body?:unknown):Promise<T>{
 // The control plane sees only connection metadata, never a provider key.
 const data=await invoke<{connection:{workspaceId:string;endpoint:string;token:string}}>('canopy_account_request',{route:'/api/operations',body:{action:'management-connect',workspaceId}});
 if(data.connection.workspaceId!==workspaceId)throw Error('Workspace identity changed. Reopen its account settings.');
 const client=new RemoteExecutionClient(data.connection.endpoint,data.connection.token);
 return client.workspace<T>(workspaceId,'/shared-accounts',body);
}
