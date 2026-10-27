// Language servers for the editor, run beside the code (src-tauri/src/lsp.rs).
// Same framing and limits as the desktop: Content-Length messages, 16 MiB per
// message, 64 KiB of headers. Output goes to the caller's channel; when the
// server ends the channel closes, which the desktop reports as lsp:exit.
import {spawn} from 'node:child_process';
const MAX_HEADER_BYTES=64*1024,MAX_MESSAGE_BYTES=16*1024*1024,MAX_SERVERS=16;
export const LSP_READ_ONLY=[];
export function lspCommands({scoped,home}){
 const servers=new Map();let nextId=0;
 const stop=id=>{const server=servers.get(id);if(!server)return;servers.delete(id);try{server.child.kill('SIGKILL');}catch{}server.channel?.close();};
 return {
  lsp_start:async({command,args=[],root,onMessage})=>{
   if(typeof command!=='string'||!command||command.length>4096||/[\0\n]/.test(command))throw Error('Invalid language server');
   if(!Array.isArray(args)||args.length>64||args.some(a=>typeof a!=='string'||a.length>4096||a.includes('\0')))throw Error('Invalid language server arguments');
   if(servers.size>=MAX_SERVERS)throw Error('Too many language servers are running');
   const cwd=await scoped(root);
   const child=spawn(command,args,{cwd,stdio:['pipe','pipe','ignore'],env:{...process.env,HOME:home}});
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',error=>reject(Error(`failed to spawn ${command}: ${error.message}`)));});
   const id=++nextId;servers.set(id,{child,channel:onMessage});
   let buffer=Buffer.alloc(0),length=null;
   const fail=()=>stop(id);
   child.stdout.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    for(;;){
     if(length===null){
      const end=buffer.indexOf('\r\n\r\n');
      if(end<0){if(buffer.length>MAX_HEADER_BYTES)return fail();return;}
      if(end>MAX_HEADER_BYTES)return fail();
      const header=buffer.subarray(0,end).toString('latin1');buffer=buffer.subarray(end+4);
      const match=/(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);if(!match)continue;
      length=Number(match[1]);if(length>MAX_MESSAGE_BYTES)return fail();
     }
     if(buffer.length<length)return;
     const body=buffer.subarray(0,length);buffer=buffer.subarray(length);length=null;
     const text=new TextDecoder('utf-8',{fatal:true});let message;try{message=text.decode(body);}catch{continue;}
     if(onMessage&&!onMessage.send(message))return fail();
    }
   });
   child.on('exit',()=>{servers.delete(id);onMessage?.close();});
   child.stdin.on('error',()=>{});
   onMessage?.onClose(()=>{if(servers.has(id))stop(id);});
   return id;
  },
  lsp_send:async({id,message})=>{
   if(typeof message!=='string')throw Error('Invalid LSP message');
   const bytes=Buffer.byteLength(message);
   if(bytes>MAX_MESSAGE_BYTES)throw Error(`LSP message is ${bytes} bytes; maximum is ${MAX_MESSAGE_BYTES}`);
   const server=servers.get(Number(id));if(!server)throw Error(`no lsp server ${id}`);
   await new Promise((resolve,reject)=>server.child.stdin.write(`Content-Length: ${bytes}\r\n\r\n${message}`,error=>error?reject(error):resolve()));
  },
  lsp_stop:async({id})=>{stop(Number(id));},
 };
}
