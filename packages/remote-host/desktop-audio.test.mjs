import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PAREC_ARGS,streamDesktopAudio} from './desktop-audio.mjs';
function fixture(){const capture=new EventEmitter();capture.stdout=new EventEmitter();capture.kill=()=>{capture.killed=true;};
 const ws=new EventEmitter();Object.assign(ws,{readyState:1,bufferedAmount:0,sent:[],send(data){ws.sent.push(Buffer.from(data));},close(code){ws.closed=code;}});
 let spawned;streamDesktopAudio(ws,{spawn:(...args)=>{spawned=args;return capture;},env:{}});return {capture,ws,spawned};}
test('reads the virtual sound card and sends whole frames only',()=>{
 const {capture,ws,spawned}=fixture();assert.equal(spawned[0],'parec');assert.deepEqual(spawned[1],[...PAREC_ARGS]);
 capture.stdout.emit('data',Buffer.from([1,2,3,4,5,6]));capture.stdout.emit('data',Buffer.from([7,8]));
 assert.deepEqual(ws.sent.map(b=>[...b]),[[1,2,3,4],[5,6,7,8]]);
});
test('a slow connection skips sound instead of queueing it',()=>{
 const {capture,ws}=fixture();ws.bufferedAmount=300*1024;capture.stdout.emit('data',Buffer.alloc(8));assert.equal(ws.sent.length,0);
 ws.bufferedAmount=0;capture.stdout.emit('data',Buffer.alloc(8));assert.equal(ws.sent.length,1);
});
test('either side ending ends the other',()=>{
 const a=fixture();a.ws.emit('close');assert.equal(a.capture.killed,true);
 const b=fixture();b.capture.emit('close');assert.equal(b.ws.closed,1011);
 const c=fixture();c.capture.emit('error',Error('no parec'));assert.equal(c.ws.closed,1011);
});
