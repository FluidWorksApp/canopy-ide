import {DatabaseSync} from 'node:sqlite';
import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {WorkspaceProfiles} from './profiles.mjs';
const number=value=>Number.isSafeInteger(value)&&value>=0?value:0;
function model(value){if(typeof value!=='string'||!value||value.length>1024)return null;try{const parsed=JSON.parse(value);return typeof parsed==='string'?parsed:typeof parsed?.id==='string'?parsed.id:null;}catch{return value;}}
function usage(row,profile){return {agent:'opencode',session_id:row.id,profile,cwd:typeof row.directory==='string'?row.directory:'',title:typeof row.title==='string'&&row.title?row.title:null,model:model(row.model),input_tokens:number(row.tokens_input),output_tokens:number(row.tokens_output)+number(row.tokens_reasoning),cache_read_tokens:number(row.tokens_cache_read),cache_creation_tokens:number(row.tokens_cache_write),cost:Number.isFinite(row.cost)&&row.cost>0?row.cost:null,turns:number(row.turns),updated:Math.floor(number(row.time_updated)/1000),supported:true};}
async function fileStamp(file,optional=false){try{const info=await lstat(file,{bigint:true});if(!info.isFile()||info.isSymbolicLink()||await realpath(file)!==file)throw Error('Unsafe OpenCode store path');return [info.ino,info.size,info.mtimeNs].join(':');}catch(error){if(optional&&error.code==='ENOENT')return 'missing';throw error;}}
// Session aggregates only. No message/part text or authentication stores leave
// the profile. DatabaseSync opens read-only; cache tracks DB AND active WAL.
export function opencodeUsageReader(home,{onQuery=()=>{}}={}){
 const profiles=new WorkspaceProfiles(home),cache=new Map();let inflight;
 async function read(profile,sessionId=null){
  const root=await profiles.root(profile.id),file=path.join(root,'.local/share/opencode/opencode.db');let stamp;
  try{stamp=await fileStamp(file)+'/'+await fileStamp(file+'-wal',true);await fileStamp(file+'-shm',true);}catch(error){cache.delete(file);if(error.code==='ENOENT'||error.message==='Unsafe OpenCode store path')return [];throw error;}
  let entry=cache.get(file);if(entry?.stamp===stamp){if(!sessionId&&entry.rows!==null)return entry.rows;if(entry.exact.has(sessionId))return entry.exact.get(sessionId);const found=(entry.rows??[]).filter(row=>row.session_id===sessionId);if(found.length)return found;}
  let db;
  try{
   db=new DatabaseSync(file,{readOnly:true,enableLoadExtension:false});db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=50; BEGIN;');
   const tables=new Map(db.prepare("SELECT name,type FROM sqlite_schema WHERE name IN ('session','message','session_message')").all().map(row=>[row.name,row.type]));if(tables.get('session')!=='table')return [];
   const columns=new Set(db.prepare('PRAGMA table_info(session)').all().map(row=>row.name));if(!['id','model','cost','tokens_input','tokens_output','tokens_reasoning','tokens_cache_read','tokens_cache_write','time_updated'].every(field=>columns.has(field)))return [];
   const sources=[];
   if(tables.get('message')==='table')sources.push("SELECT id FROM message WHERE session_id=s.id AND json_valid(data) AND json_extract(data,'$.role')='assistant'");
   if(tables.get('session_message')==='table')sources.push("SELECT id FROM session_message WHERE session_id=s.id AND type='assistant'");
   const turns=sources.length?'(SELECT COUNT(DISTINCT id) FROM ('+sources.join(' UNION ALL ')+'))':'0';
   const query='SELECT s.id,'+(columns.has('directory')?'s.directory':'NULL AS directory')+','+(columns.has('title')?'s.title':'NULL AS title')+',s.model,s.cost,s.tokens_input,s.tokens_output,s.tokens_reasoning,s.tokens_cache_read,s.tokens_cache_write,s.time_updated,'+turns+' AS turns FROM session s'+(sessionId?' WHERE s.id=?':' ORDER BY s.time_updated DESC LIMIT 60');
   onQuery();const raw=sessionId?db.prepare(query).all(sessionId):db.prepare(query).all();const rows=raw.filter(row=>typeof row.id==='string').map(row=>usage(row,profile.id));db.exec('COMMIT;');
   // Reject path replacement while reading rather than returning another store.
   if(await realpath(file)!==file)return [];
   if(!entry||entry.stamp!==stamp)entry={stamp,rows:null,exact:new Map()};
   if(sessionId){entry.exact.delete(sessionId);entry.exact.set(sessionId,rows);while(entry.exact.size>32)entry.exact.delete(entry.exact.keys().next().value);}else entry.rows=rows;cache.set(file,entry);return rows;
  }catch{return [];}finally{db?.close();}
 }
 async function scan(sessionId=null){const inventory=await profiles.list(),valid=new Set(inventory.map(profile=>path.join(profile.root,'.local/share/opencode/opencode.db')));for(const file of cache.keys())if(!valid.has(file))cache.delete(file);const rows=[];for(const profile of inventory){rows.push(...await read(profile,sessionId));if(sessionId&&rows.length)break;}return rows;}
 return {usage(){if(!inflight)inflight=scan().finally(()=>{inflight=null;});return inflight;},async sessionStats(sessionId){if(typeof sessionId!=='string'||! /^[\w-]{1,128}$/.test(sessionId))throw Error('Invalid OpenCode session');const row=(await scan(sessionId))[0];if(!row)return null;return Object.fromEntries(['model','input_tokens','output_tokens','cache_read_tokens','cache_creation_tokens','turns','cost'].map(key=>[key,row[key]]));}};
}
