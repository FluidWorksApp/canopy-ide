import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {lspCommands} from './lsp.mjs';
import {ChannelHub} from './channels.mjs';

// A tiny "server" that echoes each framed message back, uppercased.
const ECHO=`let b=Buffer.alloc(0);process.stdin.on('data',c=>{b=Buffer.concat([b,c]);for(;;){const e=b.indexOf('\\r\\n\\r\\n');if(e<0)return;const n=Number(/Content-Length: (\\d+)/.exec(b.subarray(0,e).toString())[1]);if(b.length<e+4+n)return;const m=b.subarray(e+4,e+4+n).toString();b=b.subarray(e+4+n);if(m==='"quit"')process.exit(0);const o=m.toUpperCase();process.stdout.write('Content-Length: '+Buffer.byteLength(o)+'\\r\\n\\r\\n'+o);}});`;
test('a language server in the workspace speaks framed messages through a channel and ends it on exit',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'lsp-')));await writeFile(join(root,'echo.js'),ECHO);
 const hub=new ChannelHub();const commands=lspCommands({scoped:async p=>{if(p!==root)throw Error('outside');return p;},home:root});
 const id='00000000-0000-4000-8000-000000000001';
 const server=await commands.lsp_start({command:process.execPath,args:['echo.js'],root,onMessage:hub.open(id)});
 assert.equal(server,1);
 await commands.lsp_send({id:server,message:'{"héllo":1}'});
 const first=await hub.poll([id],3000);assert.deepEqual(first[id].messages,['{"HÉLLO":1}']);
 await commands.lsp_send({id:server,message:'"quit"'});
 let closed=false;for(let i=0;i<50&&!closed;i++)closed=(await hub.poll([id],200))[id].closed;
 assert.ok(closed);await assert.rejects(commands.lsp_send({id:server,message:'{}'}),/no lsp server 1/);
 await assert.rejects(commands.lsp_start({command:'node',args:[],root:'/etc',onMessage:null}),/outside/);
 await assert.rejects(commands.lsp_start({command:'/nonexistent/server',args:[],root,onMessage:null}),/failed to spawn/);
});
