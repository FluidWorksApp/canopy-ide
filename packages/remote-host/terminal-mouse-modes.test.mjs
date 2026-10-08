import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import {trackMouseEncoding} from './terminal-mouse-modes.mjs';
import {TerminalScreen} from './terminal-screen.mjs';
const {Terminal}=headless,{SerializeAddon}=serialize;
const write=(term,data)=>new Promise(done=>term.write(data,done));
const wheel={col:130,row:5,x:960,y:120,button:4,action:0,ctrl:false,alt:false,shift:false};
function reports(term){
 const data=[],binary=[];const a=term.onData(value=>data.push(value)),b=term.onBinary(value=>binary.push(value));
 term._core.coreMouseService.triggerMouseEvent({...wheel});a.dispose();b.dispose();return {data,binary};
}
for(const [name,mode] of [['SGR','\x1b[?1006h'],['SGR pixels','\x1b[?1016h'],['legacy','']]){
 test(`${name} wheel reports survive repeated local compaction`,async()=>{
  const term=new Terminal({cols:200,rows:30,allowProposedApi:true}),addon=new SerializeAddon();term.loadAddon(addon);const modes=trackMouseEncoding(term);
  await write(term,'\x1b[?1000h'+mode);const expected=reports(term);
  for(let i=0;i<5;i++){
   const snapshot=modes.serialize(addon,{scrollback:64});modes.reset();term.reset();await write(term,snapshot);assert.deepEqual(reports(term),expected);
  }
  if(name==='legacy')assert.equal(expected.binary[0].charCodeAt(4),163);else assert.equal(expected.binary.length,0);
  modes.dispose();term.dispose();
 });
 test(`${name} wheel reports survive a remote screen snapshot`,async()=>{
  const screen=new TerminalScreen(200,30);await screen.write(Buffer.from('\x1b[?1000h'+mode));
  const expected=reports(screen.term),frame=await screen.snapshot();
  const viewer=new Terminal({cols:200,rows:30,allowProposedApi:true});await write(viewer,Buffer.from(frame.b64,'base64').subarray(1));
  assert.deepEqual(reports(viewer),expected);viewer.dispose();screen.dispose();
 });
}
test('encoding changes and RIS reset are observed without consuming xterm mode handling',async()=>{
 const term=new Terminal({cols:200,rows:30,allowProposedApi:true}),addon=new SerializeAddon();term.loadAddon(addon);const modes=trackMouseEncoding(term);
 await write(term,'\x1b[?1000;1006h');assert.equal(term.modes.mouseTrackingMode,'vt200');
 await write(term,'\x1b[?1006l');assert.ok(modes.serialize(addon).endsWith('\x1b[?1006l\x1b[?1016l'));
 await write(term,'\x1b[?1006h\x1bc');assert.ok(modes.serialize(addon).endsWith('\x1b[?1006l\x1b[?1016l'));
 modes.dispose();term.dispose();
});
