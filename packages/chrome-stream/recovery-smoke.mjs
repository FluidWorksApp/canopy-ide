// Real workspace Chromium + iframe + one-use-ticket proxy; no external services.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {WebSocketServer} from 'ws';
const {BrowserStreams}=await import(process.env.CANOPY_BROWSER_STREAMS_MODULE??new URL('../remote-host/browser-streams.mjs',import.meta.url).href);
const home=await mkdtemp(join(tmpdir(),'canopy-preview-recovery-'));
const registry=new BrowserStreams({home,script:process.env.CANOPY_BROWSER_STREAM_SCRIPT??new URL('../remote-host/chrome-stream/server.mjs',import.meta.url).pathname});
const tickets=new Set(),clients=new Set();let browserId,session=0,reopens=0,failedTickets=0,available=true,clicks=0,origin,qa;
const html=await readFile(new URL('./viewer.html',import.meta.url));
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,origin);
  if(url.pathname==='/clicked'){clicks++;res.end('ok');return;}
  if(url.pathname==='/hang')return;
  if(url.pathname==='/fixture'){
   res.setHeader('Content-Type','text/html');
   if(!available){res.statusCode=503;res.end('<h1>Server restarting</h1>');return;}
   res.end('<!doctype html><title>Recovery fixture</title><style>body{font:20px system-ui;margin:20px}input{font:inherit}</style><h1>Recovery fixture</h1><input id="entry"><button id="click" onclick="this.textContent=\'Clicked\';fetch(\'/clicked\',{method:\'POST\'})">Click</button>');return;
  }
  if(url.pathname==='/ticket'){
   if(failedTickets){failedTickets--;res.statusCode=503;res.end();return;}
   const ticket=randomUUID();tickets.add(ticket);res.end(JSON.stringify({url:origin.replace('http:','ws:')+'/stream?ticket='+ticket}));return;
  }
  if(url.pathname==='/reopen'){
   await registry.close(browserId);session++;reopens++;
   ({id:browserId}=await registry.open({sessionId:'test-'+session,profileId:'recovery-test',url:origin+'/fixture'}));
   res.end(JSON.stringify({sessionId:'test-'+session}));return;
  }
  if(url.pathname==='/viewer'){
   res.setHeader('Content-Type','text/html');res.end(`<!doctype html><style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><iframe src="/chrome-stream/viewer.html?remote=1&sessionId=test-${session}"></iframe><script>
const iframe=document.querySelector('iframe');let sessionId='test-${session}';window.replies=[];
const init=()=>iframe.contentWindow.postMessage({canopy:'stream-init',sessionId,url:${JSON.stringify(origin+'/fixture')},visible:true},location.origin);
iframe.onload=init;
addEventListener('message',async e=>{if(e.source!==iframe.contentWindow)return;const d=e.data;window.replies.push(d);
if(d.canopy==='stream-ready')init();
if(d.canopy==='remote-stream-ticket-request'&&d.sessionId===sessionId){try{const r=await fetch('/ticket');if(!r.ok)throw Error();const ticket=await r.json();iframe.contentWindow.postMessage({canopy:'remote-stream-ticket',sessionId,requestId:d.requestId,url:ticket.url},location.origin);}catch{iframe.contentWindow.postMessage({canopy:'remote-stream-ticket-error',sessionId,requestId:d.requestId},location.origin);}}
if(d.canopy==='stream-reopen'&&d.sessionId===sessionId){const r=await fetch('/reopen');({sessionId}=await r.json());iframe.src='/chrome-stream/viewer.html?remote=1&sessionId='+sessionId;}
});
window.op=message=>new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{removeEventListener('message',answer);reject(Error('Preview command timed out'));},12000);function answer(e){if(e.source!==iframe.contentWindow||e.data.id!==id)return;clearTimeout(timer);removeEventListener('message',answer);e.data.ok?resolve(e.data.data.result):reject(Error(String(e.data.data)));}addEventListener('message',answer);iframe.contentWindow.postMessage({canopy:'agent',op:'eval',id,code:message,bg:true},location.origin);});
window.command=message=>iframe.contentWindow.postMessage(message,location.origin);
</script>`);return;
  }
  const files={'/chrome-stream/viewer.html':html,'/chrome-stream/viewer.js':await readFile(new URL('./viewer.js',import.meta.url)),'/chrome-stream/protocol.mjs':await readFile(new URL('./protocol.mjs',import.meta.url))};
  if(files[url.pathname]){res.setHeader('Content-Type',url.pathname.endsWith('.html')?'text/html':'text/javascript');res.end(files[url.pathname]);return;}
  res.statusCode=404;res.end();
 }catch(error){res.statusCode=500;res.end(error.message);}
});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{
 const ticket=new URL(req.url,origin).searchParams.get('ticket');
 if(!tickets.delete(ticket)){socket.destroy();return;}
 wss.handleUpgrade(req,socket,head,ws=>{clients.add(ws);ws.on('close',()=>clients.delete(ws));try{registry.attach(browserId,ws);}catch{ws.close(1011,'Synthetic bridge expired');}});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
try{
 ({id:browserId}=await registry.open({sessionId:'test-0',profileId:'recovery-test',url:origin+'/fixture'}));
 qa=await chromium.launch({executablePath:process.env.CANOPY_CHROMIUM_EXECUTABLE??'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await qa.newContext({deviceScaleFactor:2,viewport:{width:1400,height:900}}),page=await context.newPage();
 page.on('pageerror',error=>console.error('Viewer error:',error.stack));await page.goto(origin+'/viewer');
 const waitReady=async()=>{await page.waitForFunction(()=>window.replies.some(m=>m.canopy==='ready'&&m.url.includes('/fixture')),{},{timeout:20_000});return page.frames().find(f=>f.url().includes('/chrome-stream/viewer.html'));};
 let viewer=await waitReady();await viewer.waitForFunction(()=>{const c=document.getElementById('canvas');return !c.hidden&&c.width>=2600;},{},{timeout:20_000});
 const pixels=await viewer.evaluate(()=>{const c=document.getElementById('canvas'),r=c.getBoundingClientRect();return {pixels:c.width,css:r.width,viewport:c.dataset.viewportWidth};});
 assert.ok(pixels.pixels>=pixels.css*1.8,JSON.stringify(pixels));console.log('PASS retina stream:',JSON.stringify(pixels));
 const point=await page.evaluate(()=>window.op('(()=>{const r=document.querySelector("#click").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()'));
 await viewer.locator('#canvas').click({position:point});
 assert.equal(await page.evaluate(()=>window.op('document.querySelector("#click").textContent')),'Clicked');
 console.log('PASS physical-density pointer coordinates');
 const captureId=randomUUID();await page.evaluate(id=>window.command({canopy:'capture',id}),captureId);
 await page.waitForFunction(id=>window.replies.some(m=>m.canopy==='capture-result'&&m.id===id),captureId,{timeout:12000});
 const capture=await page.evaluate(id=>window.replies.find(m=>m.canopy==='capture-result'&&m.id===id),captureId),png=Buffer.from(capture.image,'base64');
 assert.equal(capture.width,png.readUInt32BE(16));assert.equal(capture.height,png.readUInt32BE(20));assert.ok(capture.width>=2600);
 console.log('PASS screenshot dimensions match physical pixels');

 await page.evaluate(()=>window.op('document.cookie="preview=retained; Max-Age=3600"; localStorage.setItem("preview","retained"); document.querySelector("#entry").focus(); true'));
 await viewer.locator('#typing').fill('');await viewer.locator('#typing').pressSequentially('live controls');
 assert.equal(await page.evaluate(()=>window.op('document.querySelector("#entry").value')),'live controls');
 // A quick reconnect to the same bridge needs its unchanged picture too.
 await page.evaluate(()=>window.op('document.querySelector("#click").textContent="Reconnect click";true'));
 await new Promise(r=>setTimeout(r,500));await page.evaluate(()=>{window.replies=[];});for(const socket of clients)socket.close();
 await waitReady();await new Promise(r=>setTimeout(r,500));await viewer.locator('#canvas').click({position:point});
 assert.equal(await page.evaluate(()=>window.op('document.querySelector("#click").textContent')),'Clicked');
 console.log('PASS transient socket recovery: unchanged frame restores pointer controls');
 // Project hidden, socket lost, bridge retired after its normal idle grace.
 await page.evaluate(()=>window.command({canopy:'stream-visible',visible:false}));await new Promise(r=>setTimeout(r,200));for(const socket of clients)socket.close();
 const expiryDeadline=Date.now()+20_000;while(registry.entries.size&&Date.now()<expiryDeadline)await new Promise(r=>setTimeout(r,100));assert.equal(registry.entries.size,0,'Hidden disconnected bridge should expire');failedTickets=1;
 await page.evaluate(()=>{window.replies=[];window.command({canopy:'stream-visible',visible:true});window.command({canopy:'navigate',delta:0});});
 viewer=await waitReady();await viewer.waitForFunction(()=>!document.getElementById('canvas').hidden,{},{timeout:20_000});assert.equal(reopens,1);
 assert.ok((await page.evaluate(()=>window.op('document.cookie'))).includes('preview=retained'));assert.equal(await page.evaluate(()=>window.op('localStorage.getItem("preview")')),'retained');console.log('PASS project-switch recovery: failed ticket, expired bridge, refresh and profile cookies');
 const beforeClick=clicks;
 await page.evaluate(url=>window.command({canopy:'navigate',url}),origin+'/hang');await new Promise(r=>setTimeout(r,300));
 await viewer.locator('#canvas').click({position:point});
 const deadline=Date.now()+1500;while(clicks===beforeClick&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.ok(clicks>beforeClick,'Pointer control must not wait behind a stalled navigation');
 await page.evaluate(url=>window.command({canopy:'navigate',url}),origin+'/fixture');await new Promise(r=>setTimeout(r,300));
 console.log('PASS responsive controls and navigation cancellation during a stalled server request');
 available=false;await page.evaluate(()=>window.command({canopy:'navigate',delta:0}));await new Promise(r=>setTimeout(r,500));available=true;
 await page.evaluate(()=>window.command({canopy:'navigate',delta:0}));
 for(let attempt=0;attempt<40;attempt++){if(await page.evaluate(()=>window.op('!!document.querySelector("#entry")')).catch(()=>false))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(await page.evaluate(()=>window.op('!!document.querySelector("#entry")')),true);
 await page.evaluate(()=>window.op('document.querySelector("#entry").focus();true'));
 await viewer.locator('#typing').pressSequentially('after restart');assert.equal(await page.evaluate(()=>window.op('document.querySelector("#entry").value')),'after restart');
 console.log('PASS server restart: refresh and input remain usable');
}finally{
 await qa?.close();await Promise.all([...registry.entries.keys()].map(id=>registry.close(id)));for(const socket of clients)socket.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));await rm(home,{recursive:true,force:true});
}
