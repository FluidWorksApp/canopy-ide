// The end of one conversation's transcript, for a session document
// (src/sessionDoc on the desktop). The desktop reads its own stores in
// src-tauri/src/stores.rs; in a cloud workspace the transcripts live here, so
// the same command is answered here, from the same registered profile homes
// session-digests.mjs reads — never a path the caller names.
import {open,constants} from 'node:fs/promises';
import {sessionDigestReader} from './session-digests.mjs';

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

export async function sessionTranscriptTail(home,args={}){
 const sessionId=String(args.sessionId??''),agent=String(args.agent??''),profile=typeof args.profile==='string'&&args.profile?args.profile:'default';
 const max=Math.min(MAX_TAIL,Math.max(1024,Number(args.maxBytes)||DEFAULT_TAIL));
 let rows;
 // The reader validates the lookup (known agent, id shape) and refuses
 // anything else by throwing: an unreadable session is simply no transcript.
 try{rows=await sessionDigestReader(home,{includePaths:true,target:{agent,sessionId,profile}})();}catch{return [];}
 const row=rows.find(r=>r.session_id===sessionId&&typeof r.transcript_path==='string');
 if(!row)return [];
 return (await readTail(row.transcript_path,max)).map(line=>transcriptMessage(agent,line)).filter(Boolean);
}
