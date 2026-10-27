// One digest per conversation in the stores of the CLIs session-digests.mjs
// does not read itself — omp, gemini, agy, opencode, aider — so the workspace's
// session list (Agents, "Open as document" for a CLI without Canopy hooks,
// commit trailers) knows them as the desktop does. The twin of stores.rs
// `digests`; the enumeration and parsing are spot-index.mjs's, the readers
// SpotSearch already uses here. Metadata only.
import {open,stat} from 'node:fs/promises';
import {sourceFiles,wholeSessions,appendMeta,appendLineText} from './spot-index.mjs';

/** The CLIs this adds; claude and codex come from session-digests.mjs. */
export const EXTRA_STORE_AGENTS=['omp','gemini','agy','opencode','aider'];
const MAX_ROWS=512;

/** The first human line of an append-only transcript, for the row's label. */
async function firstPrompt(agent,file){
 let head='';try{const fh=await open(file,'r');try{const b=Buffer.alloc(128*1024);const {bytesRead}=await fh.read(b,0,b.length,0);head=b.subarray(0,bytesRead).toString('utf8');}finally{await fh.close();}}catch{return '';}
 for(const line of head.split('\n')){const t=appendLineText(agent,line);if(t)return [...t].slice(0,120).join('');}
 return '';
}

const row=(agent,session_id,cwd,updated,title)=>({session_id,agent,profile:'default',cwd,launch_cwd:cwd,resume_cwd:cwd,updated,prompts:title?[title]:[],first_prompt:title||undefined,resumable:true,store:true});

/** Reads whose files have not changed are reused: the session list is polled. */
export function storeDigestReader(home,{scoped}={}){
 let cache=new Map();
 return async(roots=[])=>{
  const list=(Array.isArray(roots)?roots:[]).filter(r=>typeof r==='string'&&r).slice(0,16);
  const files=await sourceFiles(home,list,a=>EXTRA_STORE_AGENTS.includes(a),scoped??(async()=>{throw Error('no workspace scope');}));
  const fresh=new Map(),out=[];
  for(const f of files){
   let info;try{info=await stat(f.path);}catch{continue;}
   const stamp=`${info.size}:${info.mtimeMs}`,hit=cache.get(f.path);
   let rows;
   if(hit?.stamp===stamp)rows=hit.rows;
   else if(f.layout==='append'){
    const [id,cwd]=await appendMeta(f.agent,f.path);
    rows=id?[row(f.agent,id,cwd,Math.floor(info.mtimeMs/1000),await firstPrompt(f.agent,f.path))]:[];
   }else{
    rows=(await wholeSessions(f.agent,f.path,list,Math.floor(info.mtimeMs/1000))).filter(s=>s.session_id).map(s=>{
     const first=s.bodies[(s.roles??[]).indexOf('user')]??s.bodies[0]??'';
     return row(f.agent,s.session_id,s.cwd??'',s.updated>0?s.updated:Math.floor(info.mtimeMs/1000),[...first].slice(0,120).join(''));
    });
   }
   fresh.set(f.path,{stamp,rows});
   out.push(...rows);
  }
  cache=fresh;
  return out.sort((a,b)=>(b.updated??0)-(a.updated??0)).slice(0,MAX_ROWS);
 };
}

/** The hook/claude/codex list with the other stores' conversations added —
 *  never a second row for a session the first list already describes. */
export function withStoreDigests(rows,extra){
 const seen=new Set(rows.map(r=>`${r.agent}\u0000${r.session_id}`));
 return [...rows,...extra.filter(r=>!seen.has(`${r.agent}\u0000${r.session_id}`))].sort((a,b)=>(b.updated??0)-(a.updated??0));
}
