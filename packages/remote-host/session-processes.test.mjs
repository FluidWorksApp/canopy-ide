import test from 'node:test';import assert from 'node:assert/strict';
import {bindSessionProcesses,processAgentHint,parseProcessStat} from './session-processes.mjs';
test('identifies foreground agent binaries and runtime wrappers without matching agent names in arguments',()=>{
 assert.equal(processAgentHint(['claude','--resume'],'/usr/bin/claude','claude').bin,'claude');
 assert.equal(processAgentHint(['node','/usr/local/lib/node_modules/@openai/codex/bin/codex.js'],'/usr/bin/node','node').bin,'codex');
 assert.equal(processAgentHint(['bash','-lc','echo claude'],'/usr/bin/bash','bash'),null);
 assert.equal(processAgentHint(['node','server.js','--model=claude'],'/usr/bin/node','node'),null);
});
test('binds explicit PTY identity and rejects ambiguous legacy inventories and reused PIDs',()=>{
 const roots=[{pid:21,parent:10,tty:1,started:101},{pid:22,parent:10,tty:2,started:102}];
 const sessions=[{id:1,exitCode:0},{id:4,pid:21,exitCode:null},{id:6,pid:22,exitCode:null}],known=new Map();
 assert.equal(bindSessionProcesses(sessions,roots,10,known).get(4).pid,21);
 assert.equal(bindSessionProcesses(sessions,roots,10,known).get(6).pid,22);
 const legacy=sessions.map(({pid,...session})=>session);
 assert.equal(bindSessionProcesses(legacy,roots,10).size,0);
 assert.equal(bindSessionProcesses([legacy[1]],[roots[0]],10).get(4).pid,21);
 assert.equal(bindSessionProcesses(legacy,[{...roots[0],started:200},roots[1]],10,known).has(4),false);
});
test('correlates spawn markers even when concurrent agents start out of acceptance order',()=>{
 const sessions=[{id:1,requestId:'first',exitCode:null},{id:2,requestId:'second',exitCode:null}];
 const processes=[{pid:21,parent:10,tty:1,started:100,requestId:'second'},{pid:22,parent:10,tty:2,started:101,requestId:'first'}];
 const bindings=bindSessionProcesses(sessions,processes,10);assert.equal(bindings.get(1).pid,22);assert.equal(bindings.get(2).pid,21);
});
test('process-stat parser handles spaces in executable names',()=>{
 const tail=Array(22).fill('0');tail[0]='S';tail[1]='10';tail[4]='34816';tail[5]='23';tail[11]='100';tail[12]='5';tail[19]='42';tail[21]='20';
 assert.deepEqual(parseProcessStat('21 (name with spaces) '+tail.join(' ')),{pid:21,name:'name with spaces',parent:10,group:0,tty:34816,foreground:23,ticks:105,started:42,rss:20});
});

test('discovers only TCP listeners owned by the session, including IPv6 and duplicate descriptors',async()=>{
 const {listeningSockets,processListeningPorts}=await import('./session-processes.mjs');
 const sockets=listeningSockets([
  '0: 0100007F:0BB8 00000000:0000 0A 0:0 0:0 0 1000 0 101\n1: 0100007F:C350 00000000:0000 01 0:0 0:0 0 1000 0 102',
  '0: 00000000000000000000000000000000:0C1C 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1000 0 103',
 ]);
 const links={'/proc/10/fd/1':'socket:[101]','/proc/10/fd/2':'socket:[101]','/proc/11/fd/1':'socket:[103]','/proc/11/fd/2':'socket:[102]','/proc/99/fd/1':'socket:[999]'};
 const io={readdir:async()=>['1','2','3'],readlink:async file=>{if(!links[file])throw Error('Process exited');return links[file];}};
 assert.deepEqual(await processListeningPorts([10,11],sockets,io),[3000,3100]);
 assert.deepEqual(await processListeningPorts([99],sockets,io),[]);
});

test('reads an actual Linux HTTP listening socket and stops reporting it after close',{skip:process.platform!=='linux'},async()=>{
 const {createServer}=await import('node:http');const {readFile}=await import('node:fs/promises');
 const {listeningSockets,processListeningPorts}=await import('./session-processes.mjs');
 const server=createServer((_req,res)=>res.end('preview'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const table=async()=>listeningSockets(await Promise.all(['/proc/net/tcp','/proc/net/tcp6'].map(file=>readFile(file,'utf8'))));
 try{assert.ok((await processListeningPorts([process.pid],await table())).includes(port));}
 finally{await new Promise(resolve=>server.close(resolve));}
 assert.ok(!(await processListeningPorts([process.pid],await table())).includes(port));
});
