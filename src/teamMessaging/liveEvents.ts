// Joining a live agent session: the traffic between the person whose agent it
// is (the owner) and the teammates watching it (joiners).
//
// It rides on the team chat's own message path as a chat event (chatEvents.ts
// `event`), so it is end-to-end encrypted, queued, retried and replay-checked
// like any message — and, being an event, it never joins a transcript, never
// counts as unread and never notifies. Every live event is a direct message
// between the owner and one joiner, and is sent only to devices known to speak
// chat v4 (LIVE_VERSION): an older client would show its fallback text as a
// new message. The one exception is a joiner's first `join`, which falls back
// to every device of the owner when none is known yet — its text then reads as
// a sensible message ("Ana wants to join your live agent session").
//
// `target` is the room: a random id the owner's Canopy minted when it let
// teammates join (src/liveSession/rooms.ts). Possessing it is not access —
// the owner's machine checks who may join on every `join`.
//
// Everything here is untrusted on receipt: bounded, stripped of controls and
// bidi characters, exact keys only. A malformed event is dropped.
import {UUID,hasControl} from './messageSchema';
import {safeBlock,safeLine} from './cardSchema';

/** Lowest chat version that understands live session events. */
export const LIVE_VERSION=4;

export const LIVE_LIMITS={
 /** A message a joiner wants to give the agent. */
 sayBytes:4000,
 /** One turn in the transcript a joiner sees. */
 turnBytes:2000,
 turns:16,files:12,fileChars:300,viewers:50,title:200,agent:64,
 /** A state event as JSON, under the 32 KB envelope with room to spare. */
 stateBytes:24*1024,
} as const;

/** One entry in the live transcript: what was asked (a prompt, possibly a
 *  joiner's message the owner let through), and what the agent answered. */
export type LiveTurn={id:string;at:number;kind:'prompt'|'reply';text:string;by?:string;files?:string[]};
/** The agent's terminal, where a cloud workspace shares it (shared sessions):
 *  the joiner opens it read-only, and the workspace checks their access. */
export type LiveTerminal={workspace:string;publication:string};
export type LiveByeReason='ended'|'removed'|'not-allowed';
export type LiveOp=
 /** Joiner → owner: I'm watching (sent on open and every 30 s). */
 |{op:'join'}
 /** Joiner → owner: I stopped watching. */
 |{op:'leave'}
 /** Joiner → owner: please give the agent this. `request` names it in the answer. */
 |{op:'say';request:string;text:string}
 /** Owner → joiner: the room as it stands. `turns` only on the first answer to a join. */
 |{op:'state';title:string;agent:string;direct:boolean;viewers:string[];turns?:LiveTurn[];terminal?:LiveTerminal}
 /** Owner → joiner: a new or finished turn. */
 |{op:'turn';turn:LiveTurn}
 /** Owner → joiner: what became of a `say`. `text` when the owner edited it. */
 |{op:'answer';request:string;outcome:'sent'|'declined'|'failed';text?:string}
 /** Owner → joiner: the room is closed to you. */
 |{op:'bye';reason:LiveByeReason};
export type LiveEvent={type:'live';target:string}&LiveOp;

const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:object,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
const uuid=(v:unknown):v is string=>typeof v==='string'&&UUID.test(v);
const bytes=(v:string)=>new TextEncoder().encode(v).length;
const BIDI=/[\u0080-\u009f‪-‮⁦-⁩؜‎‏]/;
/** An account id as chatEvents' validUserId has it. */
const userId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&!hasControl(v)&&!BIDI.test(v);
const WORKSPACE=/^[a-z0-9][a-z0-9-]{0,62}$/;

function parseTurn(v:unknown):LiveTurn|undefined{
 if(!plain(v)||!exact(v,['id','at','kind','text','by','files']))return undefined;
 if(typeof v.id!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(v.id)||!Number.isSafeInteger(v.at)||(v.at as number)<0)return undefined;
 if(v.kind!=='prompt'&&v.kind!=='reply')return undefined;
 if(!safeBlock(v.text,LIVE_LIMITS.turnBytes))return undefined;
 if(v.by!==undefined&&!safeLine(v.by,120))return undefined;
 const f=v.files;
 if(f!==undefined&&!(Array.isArray(f)&&f.length<=LIVE_LIMITS.files&&f.every(x=>safeLine(x,LIVE_LIMITS.fileChars))))return undefined;
 return {id:v.id,at:v.at as number,kind:v.kind,text:v.text,...(v.by!==undefined?{by:v.by as string}:{}),...(f!==undefined?{files:[...f as string[]]}:{})};
}

/** A well formed live event — a fresh object with only the known fields — or undefined. */
export function parseLiveEvent(v:unknown):LiveEvent|undefined{
 if(!plain(v)||v.type!=='live'||!uuid(v.target))return undefined;
 const base={type:'live' as const,target:v.target};
 switch(v.op){
  case 'join':case 'leave':return exact(v,['type','target','op'])?{...base,op:v.op}:undefined;
  case 'say':
   if(!exact(v,['type','target','op','request','text'])||!uuid(v.request)||!safeBlock(v.text,LIVE_LIMITS.sayBytes)||!v.text.trim())return undefined;
   return {...base,op:'say',request:v.request,text:v.text};
  case 'state':{
   if(!exact(v,['type','target','op','title','agent','direct','viewers','turns','terminal'])||!safeLine(v.title,LIVE_LIMITS.title)||!safeLine(v.agent,LIVE_LIMITS.agent)||typeof v.direct!=='boolean')return undefined;
   const viewers=v.viewers;
   if(!Array.isArray(viewers)||viewers.length>LIVE_LIMITS.viewers||!viewers.every(userId)||new Set(viewers).size!==viewers.length)return undefined;
   let turns:LiveTurn[]|undefined;
   if(v.turns!==undefined){
    if(!Array.isArray(v.turns)||v.turns.length>LIVE_LIMITS.turns)return undefined;
    turns=[];for(const t of v.turns){const p=parseTurn(t);if(!p)return undefined;turns.push(p);}
   }
   let terminal:LiveTerminal|undefined;
   if(v.terminal!==undefined){
    const t=v.terminal;
    if(!plain(t)||!exact(t,['workspace','publication'])||typeof t.workspace!=='string'||!WORKSPACE.test(t.workspace)||!uuid(t.publication))return undefined;
    terminal={workspace:t.workspace,publication:t.publication};
   }
   const out:LiveEvent={...base,op:'state',title:v.title,agent:v.agent,direct:v.direct,viewers:[...viewers as string[]],...(turns?{turns}:{}),...(terminal?{terminal}:{})};
   return bytes(JSON.stringify(out))<=LIVE_LIMITS.stateBytes?out:undefined;
  }
  case 'turn':{
   if(!exact(v,['type','target','op','turn']))return undefined;
   const turn=parseTurn(v.turn);return turn?{...base,op:'turn',turn}:undefined;
  }
  case 'answer':
   if(!exact(v,['type','target','op','request','outcome','text'])||!uuid(v.request)||!['sent','declined','failed'].includes(v.outcome as string))return undefined;
   if(v.text!==undefined&&!safeBlock(v.text,LIVE_LIMITS.sayBytes))return undefined;
   return {...base,op:'answer',request:v.request,outcome:v.outcome as 'sent'|'declined'|'failed',...(v.text!==undefined?{text:v.text as string}:{})};
  case 'bye':
   if(!exact(v,['type','target','op','reason'])||!['ended','removed','not-allowed'].includes(v.reason as string))return undefined;
   return {...base,op:'bye',reason:v.reason as LiveByeReason};
  default:return undefined;
 }
}

const clip=(text:string,chars:number)=>{const c=[...text.replace(/\s+/g,' ').trim()];return c.length>chars?`${c.slice(0,chars-1).join('')}…`:c.join('');};
/** What a client that does not know live events would show for one. Only a
 *  first `join` can reach such a client; the rest are written for completeness. */
export function liveText(event:LiveEvent):string{
 switch(event.op){
  case 'join':return 'Wants to join your live agent session. Open Canopy 0.5 or later to let them watch.';
  case 'leave':return 'Stopped watching your live agent session.';
  case 'say':return `Wants to tell your agent: "${clip(event.text,200)}"`;
  case 'state':return `Live agent session: ${event.title}`;
  case 'turn':return event.turn.kind==='prompt'?`The agent was asked: ${clip(event.turn.text,200)}`:`The agent answered: ${clip(event.turn.text,200)}`;
  case 'answer':return event.outcome==='sent'?'Your message was given to the agent.':event.outcome==='declined'?'Your message was not passed to the agent.':'Your message could not be delivered to the agent.';
  case 'bye':return event.reason==='removed'?'You were removed from the live agent session.':event.reason==='ended'?'The live agent session ended.':'You are not invited to that live agent session.';
 }
}

/** Fits a state event under the byte bound by dropping its oldest turns. */
export function fitState(event:Extract<LiveEvent,{op:'state'}>):Extract<LiveEvent,{op:'state'}>{
 let turns=event.turns?.slice(-LIVE_LIMITS.turns);
 const make=()=>({...event,...(turns?{turns}:{})});
 while(turns&&turns.length&&bytes(JSON.stringify(make()))>LIVE_LIMITS.stateBytes)turns=turns.slice(1);
 return make();
}
