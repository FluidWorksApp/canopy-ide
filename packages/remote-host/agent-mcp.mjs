import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
const exec=promisify(execFile);
const ours=(entry,helper)=>entry?.command===helper&&Array.isArray(entry.args)&&entry.args.length===1&&entry.args[0]==='--mcp';
async function config(root,agent){
 const file=root+(agent==='claude'?'/.claude/.claude.json':'/.codex/config.toml');
 let raw;try{raw=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;raw='';}
 if(Buffer.byteLength(raw)>1024*1024)throw Error('Agent configuration is too large');
 if(agent==='claude')return {file,raw,value:raw?JSON.parse(raw):{}};
 // Use Python's standard TOML parser; never regex-interpret user credentials.
 const result=await exec('python3',['-c','import json,tomllib,sys; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',file],{maxBuffer:2*1024*1024,timeout:5000}).catch(e=>{if(!raw)return {stdout:'{}'};throw Error('Codex configuration could not be parsed; it was preserved');});
 return {file,raw,value:JSON.parse(result.stdout)};
}
export async function mcpStatus(root,agent,helper){try{const {value}=await config(root,agent);const entry=(agent==='claude'?value.mcpServers:value.mcp_servers)?.canopy;return entry?ours(entry,helper)?'ours':'foreign':'missing';}catch{return 'unreadable';}}
export async function installMcp(root,agent,helper){
 const {file,raw,value}=await config(root,agent);
 const registry=agent==='claude'?'mcpServers':'mcp_servers';
 const entry=value[registry]?.canopy;
 if(entry){if(ours(entry,helper))return;throw Error('A different MCP server named canopy already exists; it was preserved');}
 let output;
 if(agent==='claude'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid Claude configuration');
  value.mcpServers??={};if(typeof value.mcpServers!=='object'||Array.isArray(value.mcpServers))throw Error('Invalid MCP registry');
  value.mcpServers.canopy={type:'stdio',command:helper,args:['--mcp']};output=JSON.stringify(value,null,2)+'\n';
 }else output=raw+'\n[mcp_servers.canopy]\ncommand = '+JSON.stringify(helper)+'\nargs = ["--mcp"]\n';
 const temporary=file+'.'+randomUUID()+'.next';await writeFile(temporary,output,{flag:'wx',mode:0o600});try{if(agent==='codex')await exec('python3',['-c','import tomllib,sys; tomllib.load(open(sys.argv[1],"rb"))',temporary],{timeout:5000,maxBuffer:16384});await rename(temporary,file);}finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
