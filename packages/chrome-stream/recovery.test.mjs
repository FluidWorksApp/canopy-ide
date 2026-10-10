import test from 'node:test';
import assert from 'node:assert/strict';
import {ViewerConnection,streamPixelRatio} from './protocol.mjs';

function fixture(remote=true){
 let now=0,serial=0,tickets=0,reopens=0;const tasks=new Map(),sockets=[],received=[],disconnects=[];
 const setTimer=(fn,delay)=>{const id=++serial;tasks.set(id,{fn,at:now+delay});return id;};
 const clearTimer=id=>tasks.delete(id);
 const tick=ms=>{const until=now+ms;for(;;){const due=[...tasks].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;tasks.delete(due[0]);due[1].fn();}now=until;};
 class Socket{
  readyState=0;messages=[];
  constructor(url){this.url=url;sockets.push(this);}
  send(data){this.messages.push(JSON.parse(data));}
  close(){this.readyState=3;this.onclose?.();}
  open(){this.readyState=1;this.onopen?.();}
  message(value){this.onmessage?.({data:JSON.stringify(value)});}
 }
 const connection=new ViewerConnection({remote,url:'ws://localhost/preview/socket',WebSocketImpl:Socket,setTimer,clearTimer,
  requestTicket:()=>{tickets++;},onReopen:()=>{reopens++;},onDisconnect:text=>disconnects.push(text),onMessage:message=>received.push(message)});
 const ready=()=>{if(remote)connection.ticket('wss://workspace/stream?ticket=one-use');const socket=sockets.at(-1);socket.open();if(remote)socket.message({type:'status',text:'Connected'});return socket;};
 return {connection,sockets,received,disconnects,ready,tick,tasks,get tickets(){return tickets;},get reopens(){return reopens;}};
}

test('returning to a hidden project recovers a dropped stream with a fresh ticket',()=>{
 const f=fixture();f.connection.connect();const old=f.ready();
 f.connection.setVisible(false);old.close();f.tick(30_000);
 assert.equal(f.tickets,1);assert.equal(f.tasks.size,0);
 f.connection.setVisible(true);assert.equal(f.tickets,2);const replacement=f.ready();
 assert.equal(f.connection.ready,true);assert.notEqual(replacement,old);f.connection.dispose();
});
test('a dropped socket automatically retries, and stale socket events cannot kill its replacement',()=>{
 const f=fixture();f.connection.connect();const old=f.ready();old.close();
 f.tick(500);assert.equal(f.tickets,2);const current=f.ready();
 old.onclose();old.message({type:'status',text:'obsolete'});
 assert.equal(f.connection.socket,current);assert.equal(f.connection.ready,true);assert.ok(!f.received.some(m=>m.text==='obsolete'));f.connection.dispose();
});
test('failed or unanswered ticket requests release Reconnect and eventually recreate the bridge',()=>{
 const f=fixture();f.connection.connect();f.connection.ticketFailed();f.tick(500);
 assert.equal(f.tickets,2);f.tick(15_000);f.tick(1_000);assert.equal(f.tickets,3);
 f.connection.ticketFailed();assert.equal(f.reopens,1);assert.equal(f.connection.phase,'reopening');assert.equal(f.tasks.size,0);f.connection.dispose();
});
test('an open gateway socket without an upstream response cannot strand initialization',()=>{
 const f=fixture();f.connection.connect();f.connection.ticket('wss://workspace/stream');f.sockets[0].open();
 assert.equal(f.connection.ready,false);f.tick(15_000);assert.equal(f.sockets[0].readyState,3);f.tick(500);assert.equal(f.tickets,2);f.connection.dispose();
});
test('refresh survives reconnect, but old input is never replayed',()=>{
 const f=fixture();f.connection.send({canopy:'navigate',url:'http://localhost:3000/old'});
 f.connection.send({canopy:'navigate',delta:0});f.connection.send({type:'key',key:'Delete'});f.connection.send({type:'mouse',event:'mousePressed'});
 const socket=f.ready();assert.deepEqual(socket.messages,[{canopy:'navigate',delta:0}]);
 socket.message({type:'tabs',active:1,tabs:[]});assert.equal(socket.messages.length,1);f.connection.dispose();
});
test('explicit reconnect replaces an open socket and disposal cancels all retries',()=>{
 const f=fixture(false);f.connection.connect();const old=f.ready();f.connection.reconnect();
 assert.equal(old.readyState,3);assert.equal(f.sockets.length,2);f.connection.dispose();f.tick(60_000);assert.equal(f.tasks.size,0);assert.equal(f.sockets.length,2);
});
test('physical pixel density is bounded without changing CSS pointer coordinates',()=>{
 assert.equal(streamPixelRatio(1600,1000,2),2);
 assert.equal(streamPixelRatio(2560,1600,3),1.5);
 for(const ratio of [NaN,Infinity,-1,undefined])assert.equal(streamPixelRatio(1280,720,ratio),1);
});

test('late ticket replies cannot attach or cancel a newer connection attempt',()=>{
 const f=fixture();f.connection.connect();const old=f.connection.pendingTicket;
 f.connection.ticketFailed(old);f.tick(500);const current=f.connection.pendingTicket;
 assert.notEqual(current,old);f.connection.ticket('wss://workspace/obsolete',old);f.connection.ticketFailed(old);
 assert.equal(f.connection.phase,'ticket');assert.equal(f.sockets.length,0);
 f.connection.ticket('wss://workspace/current',current);f.sockets[0].open();f.sockets[0].message({type:'status',text:'Connected'});
 assert.equal(f.connection.ready,true);f.connection.dispose();
});
