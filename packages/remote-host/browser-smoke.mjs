// Isolated synthetic page/profile only; never attaches to a user's Chrome.
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {BrowserStreams} from './browser-streams.mjs';
const home=await mkdtemp(join(tmpdir(),'canopy-browser-smoke-'));
const page=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<html><head><title>${req.url}</title></head><body><h1 id="target">Synthetic workspace preview ${req.url}</h1><input id="input"></body></html>`);});
await new Promise(resolve=>page.listen(0,'127.0.0.1',resolve));
const registry=new BrowserStreams({home});let ws;
try{
 const url=`http://127.0.0.1:${page.address().port}/first`;
 const {id}=await registry.open({sessionId:'smoke',url});const entry=registry.entries.get(id),target=new URL(entry.viewer);
 ws=new WebSocket(entry.viewer.replace('http:','ws:')+'socket',{origin:target.origin});
 const messages=[];ws.on('message',data=>{const message=JSON.parse(data);messages.push(message);if(message.type==='frame')ws.send(JSON.stringify({type:'ack'}));});
 const wait=async predicate=>{const end=Date.now()+20000;while(Date.now()<end){const hit=messages.find(predicate);if(hit)return hit;await new Promise(r=>setTimeout(r,20));}throw Error('Browser protocol timed out: '+JSON.stringify(messages.filter(m=>m.type==='status')));};
 await wait(m=>m.canopy==='nav'&&m.url===url);
 // Visibility bypasses the input queue and can overlap initial attach and the
 // frame-refresh timer. Repeated visible hints must not start CDP twice.
 for(let i=0;i<8;i++)ws.send(JSON.stringify({type:'visible',visible:true}));
 ws.send(JSON.stringify({type:'visible',visible:false}));ws.send(JSON.stringify({type:'visible',visible:true}));
 ws.send(JSON.stringify({canopy:'capture',id:'shot'}));const capture=await wait(m=>m.canopy==='capture-result'&&m.id==='shot');assert.ok(capture.image?.startsWith('iVBOR'),capture.error??'Capture returned no PNG image');assert.ok(capture.width>0);assert.deepEqual(messages.filter(m=>m.type==='status'&&m.error),[],'Repeated visibility must not start an already active CDP stream');
 const next=url.replace('/first','/second');ws.send(JSON.stringify({canopy:'navigate',url:next}));await wait(m=>m.canopy==='nav'&&m.url===next);messages.length=0;
 ws.send(JSON.stringify({canopy:'navigate',delta:-1}));await wait(m=>m.canopy==='nav'&&m.url===url);messages.length=0;
 ws.send(JSON.stringify({canopy:'navigate',delta:0}));await wait(m=>m.canopy==='nav'&&m.url===url);
 ws.send(JSON.stringify({canopy:'agent',id:'dom',op:'snapshot'}));const dom=await wait(m=>m.canopy==='agent-result'&&m.id==='dom');assert.equal(dom.ok,true,JSON.stringify(dom));assert.ok(JSON.stringify(dom.data).includes('Synthetic workspace preview'));
 ws.send(JSON.stringify({canopy:'mode',on:true}));
 for(const message of [{type:'mouse',event:'mouseMoved',x:40,y:30,button:'none',buttons:0},{type:'mouse',event:'mousePressed',x:40,y:30,button:'left',buttons:1,clickCount:1},{type:'mouse',event:'mouseReleased',x:40,y:30,button:'left',buttons:0,clickCount:1}])ws.send(JSON.stringify(message));
 const annotation=await wait(m=>m.canopy==='annotation');assert.equal(annotation.payload.id,'target');ws.send(JSON.stringify({canopy:'mode',on:false}));
 ws.send(JSON.stringify({canopy:'region',on:true}));
 for(const message of [{type:'mouse',event:'mousePressed',x:10,y:10,button:'left',buttons:1,clickCount:1},{type:'mouse',event:'mouseMoved',x:100,y:100,button:'left',buttons:1},{type:'mouse',event:'mouseReleased',x:100,y:100,button:'left',buttons:0,clickCount:1}])ws.send(JSON.stringify(message));
 const region=await wait(m=>m.canopy==='region-done');assert.ok(region.rect.w>50&&region.rect.h>50);
 assert.deepEqual(messages.filter(m=>m.type==='status'&&m.error),[],'Visibility/refresh races must not disconnect the workspace browser');
 console.log('PASS isolated workspace Chromium CDP: real navigation, back, reload, PNG screenshot, DOM picker snapshot, element annotation and real region drag');
}finally{ws?.close();registry.dispose();await new Promise(r=>setTimeout(r,1700));await new Promise(r=>page.close(r));await rm(home,{recursive:true,force:true});}
