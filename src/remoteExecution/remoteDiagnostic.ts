import {invoke} from '@tauri-apps/api/core';

// Stage codes only, like startup diagnostics: the resilience log never keeps
// paths, URLs, tokens or error text. One line per stage per 30s at most, so a
// retry loop shows up without flooding the log.
export type RemoteStage='terminal-attach-failed'|'terminal-stream-retry'|'terminal-stream-live'|'desktop-connected'|'desktop-disconnected'|'desktop-failed';
const last=new Map<RemoteStage,number>();
export function remoteDiagnostic(stage:RemoteStage){
 const now=Date.now();
 if(now-(last.get(stage)??0)<30_000)return;
 last.set(stage,now);
 try{void invoke('js_log',{level:'boot',message:`remote-stage:${stage}`}).catch(()=>{});}catch{/* Not running in Canopy. */}
}
