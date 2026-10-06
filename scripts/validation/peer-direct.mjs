import {build} from 'vite';
import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
const bundle=await build({configFile:false,root,logLevel:'error',build:{write:false,lib:{entry:root+'scripts/validation/peer-storage-entry.js',formats:['iife'],name:'PeerValidation'},minify:false}});
const code=(Array.isArray(bundle)?bundle[0]:bundle).output.find(item=>item.type==='chunk').code;
const devices=new Map(),queue=[];let relayCount=0;
const server=createServer(async(req,res)=>{
 if(req.url==='/relay'){
  const chunks=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks));const user=req.headers['x-test-user'];let result={};
  if(input.action==='register'){devices.set(input.deviceId,{id:input.deviceId,user_id:user,public_keys:input.keys});result={registered:true};}
  else if(input.action==='directory')result={devices:[...devices.values()]};
  else if(input.action==='relay'){relayCount++;queue.push({id:crypto.randomUUID(),recipient:input.recipientDevice,envelope:input.envelope});result={queued:true};}
  else if(input.action==='poll')result={envelopes:queue.filter(e=>e.recipient===input.deviceId)};
  else if(input.action==='ack'){for(let i=queue.length-1;i>=0;i--)if(input.ids.includes(queue[i].id))queue.splice(i,1);}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
 }
 res.setHeader('Content-Type',req.url==='/test.js'?'text/javascript':'text/html');res.end(req.url==='/test.js'?code:'<!doctype html><script src="/test.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext();
 const a=await context.newPage(),b=await context.newPage();const url=`http://127.0.0.1:${server.address().port}`;await Promise.all([a.goto(url),b.goto(url)]);
 const start=(page,user)=>page.evaluate(async(user)=>{
  window.messages=[];window.receipts=[];window.pcs=[];
  window.client=new window.peerTest.PeerClient({team:'synthetic-team',user,
   request:async body=>{const response=await fetch('/relay',{method:'POST',headers:{'x-test-user':user},body:JSON.stringify(body)});return response.json();},
   message:m=>window.messages.push(m),receipt:(id,user)=>window.receipts.push({id,user}),status:s=>{window.status=s;},
   rtc:config=>{const pc=new RTCPeerConnection(config);window.pcs.push(pc);return pc;}});
  await window.client.start();
 },user);
 await Promise.all([start(a,'alice'),start(b,'bob')]);
 await Promise.all([a.waitForFunction(()=>window.pcs.some(p=>p.connectionState==='connected'),{},{timeout:30000}),b.waitForFunction(()=>window.pcs.some(p=>p.connectionState==='connected'),{},{timeout:30000})]);
 const before=relayCount;
 await a.evaluate(()=>window.client.send('Direct synthetic message','bob'));
 await b.waitForFunction(()=>window.messages.some(m=>m.text==='Direct synthetic message'));
 await a.waitForFunction(()=>window.receipts.length===1);
 assert.equal(relayCount,before,'Established direct delivery should not use the relay');
 assert.equal(await b.evaluate(()=>window.messages.length),1);
 await Promise.all([a.evaluate(()=>window.pcs.forEach(pc=>pc.close())),b.evaluate(()=>window.pcs.forEach(pc=>pc.close()))]);
 const beforeFallback=relayCount;
 await a.evaluate(()=>window.client.send('Fallback synthetic message','bob'));
 await b.waitForFunction(()=>window.messages.some(m=>m.text==='Fallback synthetic message'));
 await a.waitForFunction(()=>window.receipts.length===2);
 assert.ok(relayCount>beforeFallback,'Disconnected delivery must use encrypted relay');
 assert.equal(await b.evaluate(()=>window.messages.length),2);
 await Promise.all([a.evaluate(()=>window.client.stop()),b.evaluate(()=>window.client.stop())]);
 console.log('PASS: two real Chromium endpoints establish WebRTC, exchange encrypted message and receipt directly without message relay, then deliver through relay after direct disconnect. Synthetic directory/relay fixture; not deployed authentication.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
