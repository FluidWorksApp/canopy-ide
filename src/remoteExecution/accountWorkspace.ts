import type {WorkspaceConnection} from './NativeWorkspaceHost';
/** Compatibility for the existing account-owned EC2 workspace. The account
 * API still verifies ownership; a custom connection never gains server rights. */
export function isAccountWorkspace(connection:WorkspaceConnection){
 return connection.endpoint===`https://${connection.workspaceId}.workspaces.canopyide.dev`||connection.workspaceId==='shoaib-work';
}
/** A member's connection carries a scoped (version 2) grant; the owner's does not.
 * This only picks the UI; the control plane enforces who may stop compute. */
export function isMemberConnection(connection:WorkspaceConnection){
 if(connection.scope)return true;
 try{return JSON.parse(atob(connection.token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'))).version===2;}catch{return false;}
}
export type AccountRequestError={error:string;status?:number;code?:string;others?:number};
/** Reads an error from a `detailedErrors` account request; null for anything else. */
export function accountRequestError(error:unknown):AccountRequestError|null{
 try{const value=JSON.parse(String(error));return value&&typeof value==='object'&&typeof value.error==='string'?value:null;}catch{return null;}
}
export const accountErrorMessage=(error:unknown)=>accountRequestError(error)?.error??String(error);
export function othersConnected(error:unknown){const detail=accountRequestError(error);return detail?.code==='others-connected'?Math.max(1,Number(detail.others)||1):null;}
export const othersConnectedMessage=(others:number)=>`${others} other ${others===1?'person is':'people are'} connected. Hibernating stops their sessions too.`;
