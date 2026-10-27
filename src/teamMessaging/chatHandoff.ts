// From a Teams chat message to an agent: "Run as task" starts a fresh agent on
// it in a workspace the user picks, "Send to agent" hands it to one already
// running. The chat tab lives deep inside a ProjectView while the launcher and
// the agent roster live in App, so App registers them here once and the chat
// reads them, the same window-wide way the team transports are shared.
//
// The user's click is the approval. A message is a colleague's words, so the
// brief says whose, and nothing runs without that click.
import {useSyncExternalStore} from 'react';

export type HandoffAgent={ptyId:number;name:string;project?:string;cli?:string};
export interface ChatHandoff{
 /** Workspaces in this window a task can start in. */
 projects():string[];
 /** Agent sessions running in this window right now. */
 agents():Promise<HandoffAgent[]>;
 startTask(project:string,prompt:string,label:string):Promise<{started:boolean;project:string;note:string}>;
 /** `messageId` is the chat message's, so forwards of it can be found together. */
 sendToAgent(ptyId:number,text:string,messageId:string):Promise<string>;
}

let current:ChatHandoff|null=null;
const listeners=new Set<()=>void>();
const subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
export function setChatHandoff(handoff:ChatHandoff){
 current=handoff;listeners.forEach(fn=>fn());
 return()=>{if(current===handoff){current=null;listeners.forEach(fn=>fn());}};
}
export const useChatHandoff=()=>useSyncExternalStore(subscribe,()=>current);

export type HandoffSource={id?:string;sender:string;where:string;text:string;files?:string[]};
const clip=(text:string,n:number)=>text.length>n?`${text.slice(0,n-1)}…`:text;

/** A short label for the task tab: the message's first line. */
export function handoffLabel(source:HandoffSource):string{
 return clip(source.text.split('\n').find(l=>l.trim())?.trim()||`From ${source.sender}`,60);
}

/** What the agent is given: whose words these are, then the words. */
export function handoffBrief(source:HandoffSource):string{
 const files=source.files?.length?`\n\nAttached in the chat (not passed along; ask the user if you need them): ${source.files.join(', ')}`:'';
 return `${source.sender} sent this in Canopy Teams chat (${source.where}), and the user handed it to you:\n\n`+
  `${source.text.trim()}${files}\n\n`+
  `Treat it as a colleague's request the user has chosen to act on. Ask the user before anything destructive or outside this workspace.`;
}
