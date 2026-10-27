// A running session's subagents and context use, for the cloud workspace —
// the twin of src-tauri/src/session_activity.rs (which documents the
// transcript shapes, verified against Claude Code 2.1.311 on 2026-10-27).
// The transcript is found the way session-transcript.mjs finds one: through
// session-digests.mjs's lookup over the registered profile homes, never a
// path the caller names. Parsed incrementally, like the desktop.
import {open,constants} from 'node:fs/promises';
import {sessionDigestReader} from './session-digests.mjs';

const RESULT_CHARS=600,DESCRIPTION_CHARS=200;
/** The CLIs whose transcript records subagents and per-reply usage. */
export const ACTIVITY_AGENTS=['claude'];

const chars=(s,n)=>[...String(s??'')].slice(0,n).join('');
const textOf=v=>{if(typeof v==='string')return v;if(!Array.isArray(v))return null;const t=v.filter(p=>p?.type==='text'&&typeof p.text==='string').map(p=>p.text).join('\n');return t||null;};
const summary=t=>{const f=String(t??'').split(/\s+/).filter(Boolean).join(' ');return f?chars(f,RESULT_CHARS):null;};
const tsMs=v=>{const t=Date.parse(v?.timestamp??'');return Number.isFinite(t)?t:null;};
const tag=(text,name)=>{const open=`<${name}>`,close=`</${name}>`;const s=text.indexOf(open);if(s<0)return null;const e=text.indexOf(close,s+open.length);return e<0?null:text.slice(s+open.length,e).trim();};
const statusWord=s=>['completed','success','done'].includes(s)?'done':['failed','error'].includes(s)?'failed':['killed','stopped','cancelled'].includes(s)?'stopped':'running';
const num=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?Math.trunc(v):null;

export function emptyState(){return {order:[],byId:new Map(),byAgent:new Map(),context:null,compactions:[]};}

function applyNotifications(st,text,at){
 let rest=text;
 for(let i=rest.indexOf('<task-notification>');i>=0;i=rest.indexOf('<task-notification>')){
  const block=rest.slice(i);const close=block.indexOf('</task-notification>');const end=close<0?block.length:close+20;const n=block.slice(0,end);rest=block.slice(end);
  const id=tag(n,'tool-use-id')??st.byAgent.get(tag(n,'task-id')??'');const sub=id&&st.byId.get(id);if(!sub)continue;
  const s=tag(n,'status');if(s)sub.status=statusWord(s);
  if(sub.status!=='running')sub.ended_ms=at??sub.ended_ms;
  const n2=k=>{const v=Number(tag(n,k));return tag(n,k)!=null&&Number.isFinite(v)?v:null;};
  sub.duration_ms=n2('duration_ms')??sub.duration_ms;sub.tokens=n2('subagent_tokens')??sub.tokens;sub.tool_uses=n2('tool_uses')??sub.tool_uses;
  if(sub.result==null){const r=tag(n,'result');if(r&&!r.includes('was delivered to you'))sub.result=summary(r);else{const s2=tag(n,'summary');if(s2)sub.result=summary(s2);}}
 }
}

function applyReports(st,text){
 const marker='<agent-message from="';let rest=text;
 for(let i=rest.indexOf(marker);i>=0;i=rest.indexOf(marker)){
  const after=rest.slice(i+marker.length);const q=after.indexOf('"');if(q<0)break;
  const agent=after.slice(0,q);const endAt=after.indexOf('</agent-message>');const body=after.slice(q,endAt<0?after.length:endAt);rest=after.slice(endAt<0?after.length:endAt);
  const k=body.indexOf('The report follows:');const report=k>=0?body.slice(k+19):body.slice(body.indexOf('>')+1);
  const sub=st.byId.get(st.byAgent.get(agent)??'');const s=summary(report);if(sub&&s)sub.result=s;
 }
}

export function applyLine(st,v){
 const at=tsMs(v);
 if(v?.type==='assistant'){
  if(v.isSidechain===true)return;
  const msg=v.message??{},u=msg.usage;
  if(u&&typeof u==='object'){const tokens=(num(u.input_tokens)??0)+(num(u.cache_creation_input_tokens)??0)+(num(u.cache_read_input_tokens)??0);const model=typeof msg.model==='string'&&msg.model&&!msg.model.startsWith('<')?msg.model:null;if(tokens>0)st.context={model:model??st.context?.model??null,tokens,at_ms:at};}
  for(const c of Array.isArray(msg.content)?msg.content:[]){
   if(c?.type!=='tool_use'||(c.name!=='Task'&&c.name!=='Agent')||typeof c.id!=='string'||st.byId.has(c.id))continue;
   const input=c.input??{};st.order.push(c.id);
   st.byId.set(c.id,{id:c.id,agent_id:null,description:chars(typeof input.description==='string'?input.description:'',DESCRIPTION_CHARS),kind:typeof input.subagent_type==='string'?input.subagent_type:null,status:'running',background:input.run_in_background===true,started_ms:at,ended_ms:null,duration_ms:null,tokens:null,tool_uses:null,result:null});
  }
 }else if(v?.type==='user'){
  const content=v.message?.content;
  if(typeof content==='string'){applyNotifications(st,content,at);applyReports(st,content);return;}
  for(const c of Array.isArray(content)?content:[]){
   if(c?.type==='text'&&typeof c.text==='string'){applyNotifications(st,c.text,at);applyReports(st,c.text);continue;}
   if(c?.type!=='tool_result')continue;const sub=st.byId.get(c.tool_use_id);if(!sub)continue;
   const r=v.toolUseResult;
   if(c.is_error===true||typeof r==='string'){sub.status='failed';sub.ended_ms=at;sub.result=summary(textOf(c.content)??(typeof r==='string'?r:''));continue;}
   if(r?.status==='async_launched'){sub.background=true;if(typeof r.agentId==='string'){sub.agent_id=r.agentId;st.byAgent.set(r.agentId,sub.id);}continue;}
   sub.status=typeof r?.status==='string'?statusWord(r.status):'done';if(sub.status==='running')sub.status='done';
   sub.ended_ms=at;sub.duration_ms=num(r?.totalDurationMs);sub.tokens=num(r?.totalTokens);sub.tool_uses=num(r?.totalToolUseCount);
   if(typeof r?.agentId==='string')sub.agent_id=r.agentId;
   sub.result=summary(textOf(r?.content)??textOf(c.content)??'');
  }
 }else if(v?.type==='queue-operation'&&typeof v.content==='string'){applyNotifications(st,v.content,at);applyReports(st,v.content);}
 else if(v?.type==='system'&&v.subtype==='compact_boundary'){
  const m=v.compactMetadata??{};const c={at_ms:at,trigger:typeof m.trigger==='string'?m.trigger:'auto',pre_tokens:num(m.preTokens),post_tokens:num(m.postTokens)};
  if(c.post_tokens!=null)st.context={model:st.context?.model??null,tokens:c.post_tokens,at_ms:at};
  st.compactions.push(c);
 }
}

const worth=l=>l.includes('"assistant"')||l.includes('tool_result')||l.includes('task-notification')||l.includes('agent-message')||l.includes('compact_boundary');
export function snapshot(st){return {subagents:st.order.map(id=>({...st.byId.get(id)})),context:st.context?{...st.context}:null,compactions:st.compactions.map(c=>({...c}))};}
export function activityFromLines(lines){const st=emptyState();for(const l of lines){if(!worth(l))continue;let v;try{v=JSON.parse(l);}catch{continue;}applyLine(st,v);}return snapshot(st);}

const cache=new Map();
/** The activity in one transcript, reading only what grew since last time. */
export async function readActivity(file){
 let entry=cache.get(file)??{offset:0,st:emptyState()};
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const {size}=await handle.stat();
  if(size<entry.offset)entry={offset:0,st:emptyState()};
  if(size>entry.offset){
   const buffer=Buffer.alloc(size-entry.offset);const {bytesRead}=await handle.read(buffer,0,buffer.length,entry.offset);
   const chunk=buffer.subarray(0,bytesRead);const last=chunk.lastIndexOf(0x0a);const consumed=last<0?0:last+1;
   for(const l of chunk.subarray(0,consumed).toString('utf8').split('\n')){if(!l||!worth(l))continue;let v;try{v=JSON.parse(l);}catch{continue;}applyLine(entry.st,v);}
   entry.offset+=consumed;if(cache.size>64)cache.clear();cache.set(file,entry);
  }
 }finally{await handle.close();}
 return snapshot(entry.st);
}

export async function sessionActivity(home,args={}){
 const sessionId=String(args.sessionId??''),agent=String(args.agent??''),profile=typeof args.profile==='string'&&args.profile?args.profile:'default';
 if(!ACTIVITY_AGENTS.includes(agent))return null;
 let rows;try{rows=await sessionDigestReader(home,{includePaths:true,target:{agent,sessionId,profile}})();}catch{return null;}
 const row=rows.find(r=>r.session_id===sessionId&&typeof r.transcript_path==='string');
 if(!row)return null;
 try{return await readActivity(row.transcript_path);}catch{return null;}
}
