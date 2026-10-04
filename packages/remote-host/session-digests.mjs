// Read conversations only from this member's registered profile homes.
// Store evidence deliberately carries no inferred live-process state.
import {readdir,open,realpath,constants} from 'node:fs/promises';
import path from 'node:path';
import {WorkspaceProfiles} from './profiles.mjs';

export function sessionDigestReader(home,{includePaths=false}={}){
 const profiles=new WorkspaceProfiles(home);
 return async()=>{
  const rows=[];let remaining=512;
  async function walk(directory,agent,profile,depth){
   if(depth<0||remaining<=0)return;
   let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
   for(const entry of entries){
    if(remaining<=0)break;
    const file=path.join(directory,entry.name);
    if(entry.isDirectory()){if(entry.name!=='subagents')await walk(file,agent,profile,depth-1);continue;}
    if(!entry.isFile()||!entry.name.endsWith('.jsonl'))continue;
    remaining--;
    // Do not follow transcript links into another home or account file.
    if(await realpath(file)!==file)continue;
    const handle=await open(file,'r');let text,info;
    try{info=await handle.stat();const buffer=Buffer.alloc(Math.min(info.size,1024*1024));const {bytesRead}=await handle.read(buffer,0,buffer.length,0);text=buffer.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}
    const row={agent,profile,store:true,resumable:true,updated:Math.floor(info.mtimeMs/1000),prompts:[]};
    for(const line of text.split('\n')){
     let value;try{value=JSON.parse(line);}catch{continue;}
     if(agent==='claude'){
      if(typeof value.sessionId==='string')row.session_id=value.sessionId;
      if(typeof value.cwd==='string')row.cwd=value.cwd;
      if(value.type==='user'&&!value.isMeta){const content=value.message?.content;const prompt=typeof content==='string'?content:Array.isArray(content)?content.filter(c=>c.type==='text').map(c=>c.text).join('\n'):'';if(prompt)row.prompts.push(prompt.slice(0,1000));}
     }else{
      if(value.type==='session_meta'){row.session_id=value.payload?.id;row.cwd=value.payload?.cwd;}
      if(value.type==='event_msg'&&value.payload?.type==='user_message'&&typeof value.payload.message==='string')row.prompts.push(value.payload.message.slice(0,1000));
     }
     if(row.prompts.length>8)row.prompts.splice(1,1);
    }
    if(typeof row.session_id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(row.session_id)||typeof row.cwd!=='string')continue;
    if(includePaths)row.transcript_path=file;
    row.first_prompt=row.prompts[0];row.resume_cwd=row.cwd;rows.push(row);
   }
  }
  for(const profile of await profiles.list()){
   const root=await profiles.root(profile.id);
   await walk(root+'/.claude/projects','claude',profile.id,2);
   await walk(root+'/.codex/sessions','codex',profile.id,4);
  }
  const allowedProfiles=new Set((await profiles.list()).map(p=>p.id));
  let digests=[];try{digests=await readdir(home+'/.canopy/sessions',{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const entry of digests.slice(0,512)){
   if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
   let handle;
   try{
    handle=await open(home+'/.canopy/sessions/'+entry.name,constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=await handle.stat();if(info.size>1024*1024)continue;
    const digest=JSON.parse(await handle.readFile('utf8'));
    if(typeof digest.session_id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(digest.session_id)||!['claude','codex'].includes(digest.agent)||!allowedProfiles.has(digest.profile??'default'))continue;
    const index=rows.findIndex(row=>row.session_id===digest.session_id&&row.agent===digest.agent&&row.profile===(digest.profile??'default'));
    if(index>=0){
     const transcript=rows[index];
     rows[index]={...transcript,...digest,resumable:true,store:false,resume_cwd:transcript.resume_cwd};
     // An event payload must not replace the verified transcript path.
     delete rows[index].transcript_path;if(includePaths)rows[index].transcript_path=transcript.transcript_path;
    }else {
     const row={...digest,profile:digest.profile??'default',resumable:false,store:false};
     delete row.transcript_path;
     rows.push(row);
    }
   }catch{/* An incomplete hook digest must not hide saved conversations. */}
   finally{await handle?.close();}
  }
  return rows.sort((a,b)=>(b.updated??0)-(a.updated??0));
 };
}
