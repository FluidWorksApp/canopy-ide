// A research entry's directory inside the workspace. The entry itself lives in
// the workspace's Canopy service, outside the container, where an agent cannot
// write; a research run still needs one directory it may write prose and its
// progress file to (CANOPY_RESEARCH_DIR — the hook's write gate compares
// against it). This is that directory, under ~/.canopy/research/<id>, and the
// IDE copies what the agent wrote there into the entry as sources
// (remoteExecution/harnessCommands.ts).
import {mkdir,readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';

const ID=/^\d{4}-[a-z0-9-]{1,64}$/;
const MAX_FILES=64,MAX_BYTES=512*1024;
const SKIP=new Set(['progress.txt']);

export function researchMirrorCommands({home}){
 const dirOf=id=>{if(typeof id!=='string'||!ID.test(id))throw Error(`not a research id: "${String(id).slice(0,80)}"`);return path.join(home,'.canopy','research',id);};
 return {
  async research_entry_dir({id}={}){
   const dir=dirOf(id);await mkdir(dir,{recursive:true,mode:0o700});return dir;
  },
  /** The prose an agent left in the entry's directory: Markdown and text
   *  files at its top level, oldest first, each up to the service's source size. */
  async research_entry_files({id}={}){
   const dir=dirOf(id);
   let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
   const files=[];
   for(const e of entries){
    if(!e.isFile()||SKIP.has(e.name)||!/\.(md|markdown|txt)$/i.test(e.name))continue;
    const file=path.join(dir,e.name),info=await stat(file);
    if(info.size>MAX_BYTES||info.size===0)continue;
    files.push({name:e.name,path:file,bytes:info.size,modified:Math.floor(info.mtimeMs),text:await readFile(file,'utf8')});
   }
   return files.sort((a,b)=>a.modified-b.modified).slice(0,MAX_FILES);
  },
 };
}
