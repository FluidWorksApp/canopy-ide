import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {createServer} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {servePortForward,forwardablePort,frame,OPEN,DATA,END,RESET,WINDOW,PING,PONG,SEND_WINDOW,MAX_STREAMS} from './port-forward.mjs';
async function tunnel(){
 const wss=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(r=>wss.once('listening',r));wss.on('connection',c=>servePortForward(c));
 const ws=new WebSocket(`ws://127.0.0.1:${wss.address().port}`);await new Promise(r=>ws.once('open',r));
 const seen=[];let wake=()=>{};ws.on('message',d=>{seen.push({type:d[0],id:d.readUInt32BE(1),payload:d.subarray(5)});wake();});
 const until=async test=>{const end=Date.now()+3000;for(;;){if(test(seen))return seen;if(Date.now()>end)throw Error('timed out; saw '+seen.map(f=>f.type));await new Promise(r=>{wake=r;setTimeout(r,20);});}};
 return {ws,seen,until,close:async()=>{ws.terminate();await new Promise(r=>wss.close(r));}};
}
const open=(t,id,port)=>t.ws.send(frame(OPEN,id,Buffer.from(JSON.stringify({port}))));
test('runtime services and invalid ports are never forwarded',()=>{
 for(const port of [8080,8081,8787,0,65536,'3000',null])assert.equal(forwardablePort(port),false);
 assert.equal(forwardablePort(3000),true);
});
test('a stream carries bytes both ways and reports the close',async()=>{
 const server=net.createServer(s=>s.on('data',d=>{s.write('echo:'+d);s.end();}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const t=await tunnel();try{
  open(t,1,server.address().port);t.ws.send(frame(DATA,1,Buffer.from('hi')));
  await t.until(s=>s.some(f=>f.type===END));
  assert.equal(Buffer.concat(t.seen.filter(f=>f.type===DATA).map(f=>f.payload)).toString(),'echo:hi');
  assert.ok(t.seen.some(f=>f.type===WINDOW),'received bytes return credit');
 }finally{await t.close();server.close();}
});
test('a closed port and a blocked port reset only that stream',async()=>{
 const t=await tunnel();try{
  open(t,1,8081);await t.until(s=>s.some(f=>f.type===RESET&&f.id===1));
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  open(t,3,port);await t.until(s=>s.some(f=>f.type===RESET&&f.id===3));
  t.ws.send(frame(PING,0,Buffer.from('x')));await t.until(s=>s.some(f=>f.type===PONG&&f.payload.toString()==='x'));
 }finally{await t.close();}
});
test('a stream stops at its send window until the desktop returns credit',async()=>{
 const size=SEND_WINDOW*3,server=net.createServer(s=>s.end(Buffer.alloc(size,7)));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const t=await tunnel(),bytes=()=>t.seen.filter(f=>f.type===DATA).reduce((n,f)=>n+f.payload.length,0);try{
  open(t,1,server.address().port);await t.until(()=>bytes()>=SEND_WINDOW);await new Promise(r=>setTimeout(r,150));
  assert.ok(bytes()<size,'sender paused short of the whole body: '+bytes());
  const grant=Buffer.alloc(4);grant.writeUInt32BE(size);t.ws.send(frame(WINDOW,1,grant));
  await t.until(()=>bytes()===size);
 }finally{await t.close();server.close();}
});
test('streams are bounded and a dropped tunnel closes its sockets',async()=>{
 const sockets=new Set(),server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const t=await tunnel();try{
  for(let id=1;id<=MAX_STREAMS+1;id++)open(t,id,server.address().port);
  await t.until(s=>s.some(f=>f.type===RESET&&f.id===MAX_STREAMS+1));
  const end=Date.now()+2000;while(sockets.size<MAX_STREAMS&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.equal(sockets.size,MAX_STREAMS);
  t.ws.terminate();const gone=Date.now()+2000;while(sockets.size&&Date.now()<gone)await new Promise(r=>setTimeout(r,20));assert.equal(sockets.size,0);
 }finally{await t.close();server.close();}
});
