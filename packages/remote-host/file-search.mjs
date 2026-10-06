import {spawn} from 'node:child_process';
import {readdir,lstat,readFile} from 'node:fs/promises';
import path from 'node:path';

// Match fsx.rs's local file corpus: hidden source files are searchable, while
// ignore rules, generated trees, symlinks and a depth bound protect the host.
const skip=['.git','.svn','.hg','.direnv','.gradle','.mypy_cache','.pytest_cache','.ruff_cache','.terraform','.yarn','.pnpm-store','.parcel-cache','.sass-cache','.nuxt','.output','.svelte-kit','.astro','.vercel','.serverless','.tox','.dart_tool','.gradle-cache','.stack-work','.history','.rustup','.nx','.angular','.docusaurus','.expo','.metro','.dvc','.ipynb_checkpoints','.ccls-cache','.clangd','node_modules','target','dist','build','.next','.venv','venv','__pycache__','.turbo','.cache','vendor','Pods','.idea'];
const filters=['--hidden','--no-require-git','--max-depth','12','--glob',`!**/{${[...skip,'.canopy'].join(',')}}/**`];
let jobs=0;
async function collect(args, separator, limit, parse) {
  if(jobs>=2)throw Error('Workspace search is busy; try again');
  jobs++;
  try{return await new Promise((resolve,reject)=>{
    const child=spawn('rg',args,{stdio:['ignore','pipe','ignore']});
    let buffer='',bytes=0,stopped=false,failure;
    const output=[],seen=new Set();
    const stop=()=>{stopped=true;child.kill();};
    const timer=setTimeout(()=>{failure=Error('Workspace search timed out');stop();},15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      if(stopped)return;
      buffer+=chunk;
      if(buffer.length>2200000){failure=Error('Workspace search record is too large');stop();return;}
      let end;
      while(!stopped&&(end=buffer.indexOf(separator))>=0){
        const record=buffer.slice(0,end);buffer=buffer.slice(end+separator.length);
        let value;try{value=parse(record);}catch{failure=Error('Invalid workspace search result');stop();return;}
        if(value==null)continue;
        const key=JSON.stringify(value);if(seen.has(key))continue;
        seen.add(key);output.push(value);bytes+=Buffer.byteLength(key);
        if(output.length>=limit||bytes>=4*1024*1024)stop();
      }
    });
    child.once('error',()=>{failure=Error('Workspace search unavailable');});
    child.once('close',code=>{clearTimeout(timer);if(failure)return reject(failure);if(!stopped&&code!==0&&code!==1)return reject(Error('Workspace search failed'));resolve(output);});
  });}finally{jobs--;}
}
export async function listWorkspaceFiles(roots,limit=20000){
  const cap=Math.max(0,Math.min(20000,Number(limit)||0));
  if(!roots.length||!cap)return [];
  const files=await collect(['--files','--null',...filters,'--',...roots],'\0',cap,record=>record||null);
  // Like the local IDE, include Canopy's own artifacts even when ignored.
  const seen=new Set(files);
  let bytes=files.reduce((sum,file)=>sum+Buffer.byteLength(file),0);
  async function artifacts(dir,depth=0){
    if(files.length>=cap||bytes>=4*1024*1024||depth>12)return;
    let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const entry of entries){if(files.length>=cap||bytes>=4*1024*1024)break;if(entry.isSymbolicLink())continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await artifacts(file,depth+1);else if(entry.isFile()&&!seen.has(file)){seen.add(file);files.push(file);bytes+=Buffer.byteLength(file);}}
  }
  for(const root of roots)await artifacts(path.join(root,'.canopy'));
  return files;
}
export async function searchWorkspaceFiles(roots,query,limit=300){
  if(typeof query!=='string'||query.length>4096)throw Error('Invalid search query');
  const cap=Math.max(0,Math.min(1000,Number(limit)||0));
  if(!roots.length||!query.trim()||!cap)return [];
  const hits=await collect(['--json','--ignore-case','--fixed-strings','--max-filesize','2000000',...filters,'--',query,...roots],'\n',cap,record=>{
    const result=JSON.parse(record);if(result.type!=='match'||!result.data.path.text||!result.data.lines.text)return null;
    return {path:result.data.path.text,line:result.data.line_number,text:Array.from(result.data.lines.text.replace(/[\r\n]+$/,'')).slice(0,200).join('')};
  });
  if(hits.length>=cap)return hits;
  const files=await listWorkspaceFiles(roots);
  for(const file of files.filter(file=>file.includes('/.canopy/'))){
    if(hits.length>=cap)break;
    const info=await lstat(file);if(!info.isFile()||info.size>2000000)continue;
    const bytes=await readFile(file);if(bytes.includes(0))continue;
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{continue;}
    const lines=text.split(/\r?\n/),needle=query.toLowerCase();
    for(let i=0;i<lines.length&&hits.length<cap;i++)if(lines[i].toLowerCase().includes(needle))hits.push({path:file,line:i+1,text:Array.from(lines[i]).slice(0,200).join('')});
  }
  return hits;
}
