import {chromium} from 'playwright-core';import {createRequire} from 'node:module';import {createServer} from 'node:http';import {readFile,mkdir,writeFile,rm,mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {registrationProof,relayEnvelope} from '/smoke/peer-messaging.mjs';
const ts=createRequire(import.meta.url)('/usr/local/lib/node_modules/typescript'),home=await mkdtemp(join(tmpdir(),'canopy-peer-fixture-')),modules=new Map();
for(const file of ['client','crypto','store','history','messageSchema'])modules.set('/'+file+'.js',ts.transpileModule(await readFile('/smoke/source/'+file+'.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
const team=randomUUID(),users=new Set(['synthetic-alice','synthetic-bob']),devices=new Map(),queues=new Map(),revoked=new Set(),relayWire=[];let relayCount=0;
const server=createServer(async(req,res)=>{
 const respond=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
 try{
  const url=new URL(req.url,'http://fixture');if(req.method==='GET'){
   const resource=url.pathname.endsWith('.js')?url.pathname:url.pathname+'.js';if(modules.has(resource)){res.writeHead(200,{'content-type':'text/javascript'});return res.end(modules.get(resource));}
   if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end('<!doctype html><title>Synthetic Canopy peer fixture</title>');}return respond(404,{});
  }
  if(req.method!=='POST'||url.pathname!=='/relay')return respond(404,{});
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536)throw Error('Fixture request too large');}
  const input=JSON.parse(raw),user=req.headers['x-test-user'];if(!users.has(user)||revoked.has(user))throw Error('Synthetic membership denied');
  let result={};if(input.action==='register'){const keys=registrationProof(user,input);devices.set(input.deviceId,{id:input.deviceId,user_id:user,public_keys:keys});}
  else{
   if(input.teamId!==team||devices.get(input.deviceId)?.user_id!==user)throw Error('Synthetic device denied');
   if(input.action==='directory')result={devices:[...devices.values()].filter(device=>!revoked.has(device.user_id)),members:[...users].filter(value=>!revoked.has(value)).map(id=>({id,name:id})),iceServers:[]};
   else if(input.action==='poll')result={envelopes:queues.get(input.deviceId)??[]};
   else if(input.action==='ack')queues.set(input.deviceId,(queues.get(input.deviceId)??[]).filter(row=>!input.ids.includes(row.id)));
   else if(input.action==='relay'){
    const sender=devices.get(input.deviceId),recipient=devices.get(input.recipientDevice);if(!recipient||revoked.has(recipient.user_id))throw Error('Synthetic recipient denied');
    const envelope=relayEnvelope(input,user,sender,recipient);relayWire.push(JSON.stringify(envelope));relayCount++;const queue=queues.get(recipient.id)??[];if(!queue.some(row=>row.envelope.id===envelope.id))queue.push({id:randomUUID(),envelope});queues.set(recipient.id,queue);
   }else throw Error('Unsupported fixture action');
  }
  respond(200,result);
 }catch{respond(403,{error:'Synthetic peer request denied'});}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;let browser;
const diagnostics=async pages=>Promise.all(pages.map(page=>page.evaluate(async()=>{const peers=[...window.fixture.client.peers.values()];return Promise.all(peers.map(async peer=>({state:peer.pc.connectionState,channel:peer.channel?.readyState,pairs:[...(await peer.pc.getStats()).values()].filter(value=>value.type==='candidate-pair').map(value=>({state:value.state,nominated:value.nominated}))})));})));
const nativeBaseline=async page=>page.evaluate(async()=>{
 const one=new RTCPeerConnection({iceServers:[]}),two=new RTCPeerConnection({iceServers:[]});one.createDataChannel('synthetic-baseline');
 const gather=async pc=>{const until=Date.now()+4000;while(pc.iceGatheringState!=='complete'&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));};
 try{await one.setLocalDescription(await one.createOffer());await gather(one);await two.setRemoteDescription(one.localDescription);await two.setLocalDescription(await two.createAnswer());await gather(two);await one.setRemoteDescription(two.localDescription);const until=Date.now()+5000;while(one.connectionState!=='connected'&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));const pairs=[...(await one.getStats()).values()].filter(value=>value.type==='candidate-pair');return {state:one.connectionState,nominated:pairs.some(value=>value.nominated&&value.state==='succeeded'),candidatePairs:pairs.length};}finally{one.close();two.close();}
});
try{
 // Same container sandbox arrangement as the workspace preview smoke. No ICE,
 // mDNS, certificate, encryption or peer-authentication policy overrides.
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage'],env:{...process.env,HOME:home}});
 const contexts=[await browser.newContext(),await browser.newContext()],pages=await Promise.all(contexts.map(context=>context.newPage()));for(const page of pages)await page.goto(origin);
 for(const [index,page]of pages.entries())await page.evaluate(async({team,user})=>{
  const {PeerClient}=await import('/client.js'),history=await import('/history.js');const messages=[],receipts=[],statuses=[],directWire=[];
  const rtc=config=>{const pc=new RTCPeerConnection(config),attach=channel=>channel.addEventListener('message',event=>{if(typeof event.data==='string')directWire.push(event.data);});const create=pc.createDataChannel.bind(pc);pc.createDataChannel=(...args)=>{const channel=create(...args);attach(channel);return channel;};pc.addEventListener('datachannel',event=>attach(event.channel));return pc;};
  const client=new PeerClient({team,user,rtc,request:async body=>{const response=await fetch('/relay',{method:'POST',headers:{'content-type':'application/json','x-test-user':user},body:JSON.stringify(body)}),result=await response.json();if(!response.ok)throw Error(result.error);return result;},message:message=>messages.push(message),receipt:id=>receipts.push(id),status:status=>statuses.push(status),persist:message=>history.saveChatMessage(user,team,message)});
  window.fixture={client,messages,receipts,statuses,directWire,user,team};await client.start();
 },{team,user:index?'synthetic-bob':'synthetic-alice'});
 try{for(const page of pages)await page.waitForFunction(()=>[...window.fixture.client.peers.values()].some(peer=>peer.pc.connectionState==='connected'&&peer.channel?.readyState==='open'),{},{timeout:30000});}catch(error){console.error('Peer direct diagnostic '+JSON.stringify({application:await diagnostics(pages),nativeBaseline:await nativeBaseline(pages[0])}));throw error;}
 const before=relayCount,text='Synthetic direct encrypted delivery '+randomUUID(),sent=await pages[0].evaluate(async text=>window.fixture.client.send(text,'synthetic-bob'),text);
 await pages[1].waitForFunction(id=>window.fixture.messages.some(message=>message.id===id&&message.sender==='synthetic-alice'),sent.id,{timeout:5000});await pages[0].waitForFunction(id=>window.fixture.receipts.includes(id),sent.id,{timeout:5000});
 const received=await pages[1].evaluate(id=>window.fixture.messages.find(message=>message.id===id),sent.id);assert.equal(received.text,text);
 const wire=await Promise.all(pages.map(page=>page.evaluate(()=>window.fixture.directWire)));assert.ok(wire.flat().length>=2);assert.ok(wire.flat().every(frame=>!frame.includes(text)));assert.equal(relayCount,before,'Direct message and receipt must not submit relay envelopes');assert.ok(relayWire.every(frame=>!frame.includes(text)));
 const state=await diagnostics(pages);assert.ok(state.every(peers=>peers.some(peer=>peer.pairs.some(pair=>pair.state==='succeeded'&&pair.nominated))));
 // Membership removal denies the next send through real directory authority.
 revoked.add('synthetic-bob');await assert.rejects(pages[0].evaluate(()=>window.fixture.client.send('Synthetic revoked send','synthetic-bob')));
 console.log('PASS real PeerClient direct P2P: isolated Chromium contexts, connected nominated ICE pair, authenticated encrypted message+receipt, zero message relay submissions, revoked-recipient denial');
 console.log(JSON.stringify({directDataFrames:wire.flat().length,encryptedSignalingRelays:before,messageRelaySubmissions:relayCount-before,selectedPairConnected:true,contexts:2,syntheticOnly:true}));
 for(const page of pages)await page.evaluate(()=>window.fixture.client.stop());
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});}
