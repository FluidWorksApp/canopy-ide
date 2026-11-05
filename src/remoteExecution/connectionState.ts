import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
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
/** How long a drop from connected must last before the UI says so. A stream that
 * reconnects within a second or two is not news; showing it made the workspace
 * pill flip between "Connected" and "Reconnecting" and shift the tab strip. */
export const RECONNECT_SETTLE_MS=3000;
/** The connection state for display: a fall from connected to reconnecting is
 * held back until it has lasted RECONNECT_SETTLE_MS. Every other change (sign-in
 * errors, stopping, recovery) shows at once. */
export function useSettledConnectionState(key:string):ConnectionState{
 const live=useConnectionState(key);
 const [held,setHeld]=useState<{key:string;state:ConnectionState}>({key,state:live});
 const liveRef=useRef(live);liveRef.current=live;
 // Another workspace's last state says nothing about this one.
 const shown=held.key===key?held.state:live;
 const holding=live.phase==='reconnecting'&&shown.phase==='connected';
 // Anything that is not a fresh drop shows at once.
 useEffect(()=>{if(!holding)setHeld({key,state:live});},[key,live,holding]);
 // Keyed on `holding`, not on the state object: every failed request stores a
 // new object, and restarting the timer on each one would hide a real outage.
 useEffect(()=>{
  if(!holding)return;
  const timer=setTimeout(()=>setHeld({key,state:liveRef.current}),RECONNECT_SETTLE_MS);
  return()=>clearTimeout(timer);
 },[key,holding]);
 return shown;
}
// Failed concurrent requests are not reconnect attempts. Avoid presenting an
// inflated retry counter as if it described the transport supervisor.
export const connectionLabel=(state:ConnectionState)=>state.phase==='hibernated'?'Hibernated':state.phase==='stopping'?'Stopping workspace…':state.phase==='connected'?'Connected':state.phase==='authentication-error'?'Sign-in required':state.phase==='reconnecting'?'Connection lost · reconnecting…':'Connecting…';
/** Outside React: the current state of one connection, and every change. */
export const connectionStateOf=(key:string)=>states.get(key)??initial;
export function subscribeConnectionStates(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
