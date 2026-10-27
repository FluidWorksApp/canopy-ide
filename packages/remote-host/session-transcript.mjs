// The end of one conversation's transcript, for a session document
// (src/sessionDoc on the desktop). The desktop reads its own stores in
// src-tauri/src/stores.rs; in a cloud workspace the transcripts live here, so
// the same command is answered here, from the same registered profile homes
// session-digests.mjs reads — never a path the caller names.
//
// Claude Code and Codex are found the way session-digests.mjs finds them.
// Every other CLI whose store SpotSearch already reads (omp, gemini, agy,
// opencode, aider) goes through spot-index.mjs's enumeration and parsers, the
// twins of stores.rs — so a CLI searchable here is a CLI whose session
// document has its conversation.
import {open,stat,constants} from 'node:fs/promises';
import path from 'node:path';
import {sessionDigestReader} from './session-digests.mjs';
import {STORE_AGENTS,sourceFiles,wholeSessions} from './spot-index.mjs';

const DEFAULT_TAIL=512*1024,MAX_TAIL=4*1024*1024,MAX_BODY=4000;

/** A message body from a bare string or a list of parts (text ones only). */
function contentText(content){
 if(typeof content==='string')return content;
 if(!Array.isArray(content))return '';
 return content.filter(p=>p&&['text','input_text','output_text'].includes(p.type)&&typeof p.text==='string').map(p=>p.text).join('\n');
}

/** [role, text] from one transcript line, or null for tool traffic and
 *  injected context — the same rules as stores.rs append_line_message. */
export function transcriptMessage(agent,line){
 let v;try{v=JSON.parse(line);}catch{return null;}
 if(!v||typeof v!=='object')return null;
 let role,text;
 if(agent==='claude'){
  if(v.type!=='user'&&v.type!=='assistant')return null;
  role=v.type;text=contentText(v.message?.content);
 }else if(agent==='omp'){
  // omp wraps the same shape one level down and names the role there.
  if(v.type!=='message')return null;
  role=v.message?.role;if(role!=='user'&&role!=='assistant')return null;
  text=contentText(v.message?.content);
 }else if(agent==='codex'){
  if(v.type!=='response_item'||v.payload?.type!=='message')return null;
  role=v.payload.role;if(role!=='user'&&role!=='assistant')return null;
  text=contentText(v.payload.content);
 }else return null;
 const t=String(text??'').trim();
 if(!t||t.startsWith('<'))return null;
 return {role,text:t.slice(0,MAX_BODY)};
}

/** Whole lines from the last `max` bytes; a partial first line is dropped. */
async function readTail(file,max){
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const {size}=await handle.stat();const start=Math.max(0,size-max);
  const buffer=Buffer.alloc(size-start);const {bytesRead}=await handle.read(buffer,0,buffer.length,start);
  const lines=buffer.subarray(0,bytesRead).toString('utf8').split('\n');
  if(start>0)lines.shift();
  return lines.filter(Boolean);
 }finally{await handle.close();}
}

/** How many of a whole-file store's messages a tail keeps, as stores.rs. */
const WHOLE_TAIL=400;

/** The CLIs read through spot-index.mjs's store readers: the file (or the
 *  conversation inside it) is found by id among the store files of the
 *  workspace's homes and the caller's project roots. `scoped` validates a
 *  root before aider's history is read from it. */
async function storeTail(home,agent,sessionId,roots,max,scoped){
 const files=await sourceFiles(home,roots,a=>a===agent,scoped??(async()=>{throw Error('no workspace scope');}));
 for(const f of files){
  if(f.layout==='append'){
   // The file is named for its session; a path-shaped id names none.
   if(/[\\/]/.test(sessionId))continue;
   const stem=path.basename(f.path,path.extname(f.path));
   if(stem!==sessionId&&!stem.endsWith(sessionId))continue;
   return (await readTail(f.path,max)).map(line=>transcriptMessage(agent,line)).filter(Boolean);
  }
  let mtime=0;try{mtime=Math.floor((await stat(f.path)).mtimeMs/1000);}catch{continue;}
  const found=(await wholeSessions(agent,f.path,roots,mtime)).find(s=>s.session_id===sessionId);
  if(!found)continue;
  const rows=found.bodies.map((text,i)=>({role:found.roles?.[i]??'message',text}));
  return rows.slice(Math.max(0,rows.length-WHOLE_TAIL));
 }
 return [];
}

export async function sessionTranscriptTail(home,args={},ctx={}){
 const sessionId=String(args.sessionId??''),agent=String(args.agent??''),profile=typeof args.profile==='string'&&args.profile?args.profile:'default';
 const max=Math.min(MAX_TAIL,Math.max(1024,Number(args.maxBytes)||DEFAULT_TAIL));
 if(!sessionId||sessionId.length>4096)return [];
 if(agent!=='claude'&&agent!=='codex'){
  if(!STORE_AGENTS.includes(agent))return [];
  const roots=(Array.isArray(args.roots)?args.roots:[]).filter(r=>typeof r==='string'&&r).slice(0,16);
  try{return await storeTail(home,agent,sessionId,roots,max,ctx.scoped);}catch{return [];}
 }
 let rows;
 // The reader validates the lookup (known agent, id shape) and refuses
 // anything else by throwing: an unreadable session is simply no transcript.
 try{rows=await sessionDigestReader(home,{includePaths:true,target:{agent,sessionId,profile}})();}catch{return [];}
 const row=rows.find(r=>r.session_id===sessionId&&typeof r.transcript_path==='string');
 if(!row)return [];
 return (await readTail(row.transcript_path,max)).map(line=>transcriptMessage(agent,line)).filter(Boolean);
}
