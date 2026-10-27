import test from 'node:test';
import assert from 'node:assert/strict';
import {ChannelHub,isChannelArg} from './channels.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('messages queue until drained, and a closed channel reports once then disappears',async()=>{
 const hub=new ChannelHub();const channel=hub.open(id(1));
 channel.send('a');channel.send({b:1});
 assert.deepEqual(await hub.poll([id(1)]),{[id(1)]:{messages:['a',{b:1}],closed:false,error:null}});
 channel.close();assert.deepEqual((await hub.poll([id(1)]))[id(1)],{messages:[],closed:true,error:null});
 assert.equal(hub.channels.size,0);assert.equal(channel.send('late'),false);
});
test('a poll waits for the next message instead of spinning',async()=>{
 const hub=new ChannelHub();const channel=hub.open(id(2));
 setTimeout(()=>channel.send('x'),20);const started=Date.now();
 assert.deepEqual((await hub.poll([id(2)],2000))[id(2)].messages,['x']);assert.ok(Date.now()-started<1000);
});
test('an undrained channel closes instead of growing, and abandoned ones are swept',async()=>{
 let now=0;const hub=new ChannelHub({maxBytes:10,idleMs:100,now:()=>now});const channel=hub.open(id(3));let closed=0;channel.onClose(()=>closed++);
 assert.equal(channel.send('123456789012'),false);assert.equal(closed,1);
 assert.equal((await hub.poll([id(3)]))[id(3)].error,'The desktop stopped reading this stream');
 const idle=hub.open(id(4));idle.onClose(()=>closed++);now=1000;hub.open(id(5));assert.equal(closed,2);assert.equal(idle.closed,true);
});
test('channel ids are validated and recognized',()=>{
 const hub=new ChannelHub();assert.throws(()=>hub.open('../x'),/Invalid channel/);hub.open(id(6));assert.throws(()=>hub.open(id(6)),/already open/);
 assert.equal(isChannelArg({__canopyChannel:id(6)}),true);assert.equal(isChannelArg('x'),false);
 const dropped=hub.open(id(7));hub.drop([id(7)]);assert.equal(dropped.closed,true);
});
