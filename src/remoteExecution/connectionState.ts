import {useSyncExternalStore} from 'react';
export type ConnectionPhase = 'connecting'|'connected'|'reconnecting'|'authentication-error'|'stopping'|'hibernated';
export interface ConnectionState {phase:ConnectionPhase; failures:number; lastConnectedAt?:number;}
const initial:ConnectionState={phase:'connecting',failures:0};
const states=new Map<string,ConnectionState>(), listeners=new Set<()=>void>();
const streams=new Map<string,Map<number,boolean>>();
const lifecycle=new Map<string,'stopping'|'hibernated'>();
export const connectionKey=(endpoint:string,id:string)=>`${endpoint}/${id}`;
/** Set while a workspace is intentionally stopping or stopped. Transports
 * must not reconnect to it: a dropped connection is expected, not a fault. */
export const workspaceLifecyclePhase=(key:string)=>lifecycle.get(key);
export function reportWorkspaceLifecycle(key:string,phase:'stopping'|'hibernated'|null){
 if(phase)lifecycle.set(key,phase);else lifecycle.delete(key);
 reportConnection(key,phase??'connecting');
}
export function reportConnection(key:string,phase:ConnectionPhase){
 phase=lifecycle.get(key)??phase;
 if(phase==='connected'&&[...(streams.get(key)?.values()??[])].some(connected=>!connected))phase='reconnecting';
 const before=states.get(key)??initial;
 const after:ConnectionState={phase,failures:phase==='connected'?0:before.failures+1,lastConnectedAt:phase==='connected'?Date.now():before.lastConnectedAt};
 states.set(key,after);listeners.forEach(listener=>listener());
}
export function reportStream(key:string,id:number,connected:boolean|null){
 const channels=streams.get(key)??new Map<number,boolean>();
 if(connected===null)channels.delete(id);else channels.set(id,connected);
 if(channels.size)streams.set(key,channels);else streams.delete(key);
 if(states.get(key)?.phase!=='authentication-error')reportConnection(key,[...channels.values()].some(value=>!value)?'reconnecting':'connected');
}
export function useConnectionState(key:string){return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>states.get(key)??initial);}
// Failed concurrent requests are not reconnect attempts. Avoid presenting an
// inflated retry counter as if it described the transport supervisor.
export const connectionLabel=(state:ConnectionState)=>state.phase==='hibernated'?'Hibernated':state.phase==='stopping'?'Stopping workspace…':state.phase==='connected'?'Connected':state.phase==='authentication-error'?'Sign-in required':state.phase==='reconnecting'?'Connection lost · reconnecting…':'Connecting…';
