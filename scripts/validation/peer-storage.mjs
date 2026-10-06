import {build} from 'vite';
import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
const bundle=await build({configFile:false,root,logLevel:'error',build:{write:false,lib:{entry:root+'scripts/validation/peer-storage-entry.js',formats:['iife'],name:'PeerValidation'},minify:false}});
const code=(Array.isArray(bundle)?bundle[0]:bundle).output.find(item=>item.type==='chunk').code;
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/test.js'?'text/javascript':'text/html');res.end(req.url==='/test.js'?code:'<!doctype html><script src="/test.js"></script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext();
 const a=await context.newPage(),b=await context.newPage();const url=`http://127.0.0.1:${server.address().port}`;await Promise.all([a.goto(url),b.goto(url)]);
 const create=page=>page.evaluate(async()=>{const identity=await window.peerTest.deviceIdentity('synthetic-account');return {id:identity.id,public:await window.peerTest.publicIdentity(identity.keys),extractable:identity.keys.signing.privateKey.extractable};});
 const [first,second]=await Promise.all([create(a),create(b)]);assert.deepEqual(first,second);assert.equal(first.extractable,false);
 await a.reload();assert.deepEqual(await create(a),first);
 const replay=page=>page.evaluate(()=>window.peerTest.rememberMessage('synthetic-envelope',Date.now()+300000));
 assert.deepEqual((await Promise.all([replay(a),replay(b)])).sort(),[false,true]);await b.reload();assert.equal(await replay(b),false);
 const roundtrip=await a.evaluate(async()=>{
  const p=window.peerTest,alice=await p.deviceIdentity('alice'),bob=await p.deviceIdentity('bob');const from={team:'team',user:'alice',device:alice.id},to={team:'team',user:'bob',device:bob.id};
  const envelope=await p.seal(alice.keys,await p.publicIdentity(bob.keys),from,to,'Synthetic private message');
  const text=await p.open(bob.keys,await p.publicIdentity(alice.keys),from,to,envelope,p.rememberMessage);
  let replayRejected=false;try{await p.open(bob.keys,await p.publicIdentity(alice.keys),from,to,envelope,p.rememberMessage);}catch{replayRejected=true;}
  return {text,replayRejected,wireLeaks:JSON.stringify(envelope).includes('Synthetic private message')};
 });
 assert.deepEqual(roundtrip,{text:'Synthetic private message',replayRejected:true,wireLeaks:false});
 const save=(page,id)=>page.evaluate(async id=>{await window.peerTest.saveChatMessage('history-user','history-team',{id,sender:'alice',recipient:null,text:'Private history '+id,created:1});},id);
 await Promise.all([save(a,'one'),save(b,'two')]);await a.reload();
 const history=await a.evaluate(async()=>({messages:await window.peerTest.loadChatHistory('history-user','history-team'),otherAccount:await window.peerTest.loadChatHistory('other-user','history-team'),otherTeam:await window.peerTest.loadChatHistory('history-user','other-team')}));
 assert.equal(history.messages.length,2);assert.deepEqual(history.otherAccount,[]);assert.deepEqual(history.otherTeam,[]);
 await a.evaluate(async()=>{
  const p=window.peerTest;
  await Promise.all([
   p.saveChatReadState('history-user','history-team',{unreadIds:['one','two'],receipts:{one:['bob']}}),
   p.saveChatReadState('history-user','history-team',{unreadIds:['two'],receipts:{one:['bob']}})
  ]);
 });
 await a.reload();
 const readState=await a.evaluate(async()=>({
  own:await window.peerTest.loadChatReadState('history-user','history-team'),
  other:await window.peerTest.loadChatReadState('other-user','history-team'),
  otherTeam:await window.peerTest.loadChatReadState('history-user','other-team')
 }));
 assert.deepEqual(readState,{own:{unreadIds:['two'],receipts:{one:['bob']}},other:{unreadIds:[],receipts:{}},otherTeam:{unreadIds:[],receipts:{}}});
 const stateTamper=await a.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('canopy-chat-history',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  let plaintext=false;
  await new Promise((resolve,reject)=>{const tx=db.transaction('messages','readwrite'),store=tx.objectStore('messages');const r=store.get('state:'+JSON.stringify(['history-user','history-team']));r.onsuccess=()=>{const row=r.result;plaintext='unreadIds' in row||'receipts' in row;row.ciphertext=new Uint8Array([1,2,3]).buffer;store.put(row);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  db.close();let rejected=false;try{await window.peerTest.loadChatReadState('history-user','history-team');}catch{rejected=true;}return {plaintext,rejected};
 });
 assert.deepEqual(stateTamper,{plaintext:false,rejected:true});
 console.log('PASS: encrypted unread/receipt state survives reload, preserves write order, isolates accounts/teams and rejects tampering.');
 const tamper=await a.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('canopy-chat-history',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});let leaks=false;await new Promise((resolve,reject)=>{const tx=db.transaction('messages','readwrite'),store=tx.objectStore('messages'),r=store.getAll();r.onsuccess=()=>{leaks=JSON.stringify(r.result).includes('Private history');const row=r.result[0];row.ciphertext=new Uint8Array([1,2,3]).buffer;store.put(row);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();let rejected=false;try{await window.peerTest.loadChatHistory('history-user','history-team');}catch{rejected=true;}return {leaks,rejected};});
 assert.deepEqual(tamper,{leaks:false,rejected:true});
 console.log('PASS: encrypted history survives reload/concurrent writers, isolates accounts/teams, and rejects tampering.');
 console.log('PASS: Chromium concurrent identity persistence, reload, non-exportable private key, durable replay gate, encrypted round-trip. Synthetic isolated browser profile only.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
