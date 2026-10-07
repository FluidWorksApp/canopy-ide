import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalScreen} from './terminal-screen.mjs';
const lines=s=>Array.from({length:s.term.rows},(_,i)=>s.term.buffer.active.getLine(i+s.term.buffer.active.baseY)?.translateToString(true));
test('reattachment restores current CLI menu instead of replaying historic redraws',async()=>{
 const source=new TerminalScreen(40,10),client=new TerminalScreen(40,10);
 await source.write(Buffer.from('\x1b[2J\x1b[HTheme\r\n> Dark\r\n  Light'));
 await source.write(Buffer.from('\x1b[2;1H  Dark\x1b[K\r\n> Light\x1b[K'));
 const snapshot=await source.snapshot();await client.write(Buffer.from(snapshot.b64,'base64'),true,snapshot.cols,snapshot.rows);
 assert.deepEqual(lines(client),lines(source));
 await client.write(Buffer.from('obsolete redraw'));await client.write(Buffer.from(snapshot.b64,'base64'),true,snapshot.cols,snapshot.rows);
 assert.deepEqual(lines(client),lines(source));assert.equal(snapshot.end,source.end);
 source.dispose();client.dispose();
});
test('parser barriers keep differently sized redraws ordered',async()=>{
 const s=new TerminalScreen(40,10);
 const before=s.write(Buffer.from('before'),false,40,10);
 const resize=s.enqueue(0,()=>s.term.resize(20,5));
 const after=s.write(Buffer.from('\x1b[2J\x1b[Hafter'),false,20,5);
 await Promise.all([before,resize,after]);assert.equal(s.term.cols,20);assert.equal(lines(s)[0],'after');s.dispose();
});
test('parser backlog is bounded',()=>{
 const s=new TerminalScreen();assert.throws(()=>s.enqueue(1024*1024+1,()=>{}),/capacity/);s.dispose();
});

test('even an empty screen supplies a parser acknowledgement byte',async()=>{const s=new TerminalScreen();const frame=await s.snapshot();assert.ok(Buffer.from(frame.b64,'base64').length>0);assert.equal(frame.end,0);s.dispose();});
test('restore preserves full-width wrapping before the next CLI write',async()=>{
 const source=new TerminalScreen(40,10),client=new TerminalScreen(40,10);try{
  await source.write(Buffer.from('X'.repeat(40)));const snapshot=await source.snapshot();await client.write(Buffer.from(snapshot.b64,'base64'),true,40,10);
  await source.write(Buffer.from('Y'));await client.write(Buffer.from('Y'));assert.deepEqual(lines(client),lines(source));
  assert.equal(client.term.buffer.active.cursorX,source.term.buffer.active.cursorX);assert.equal(client.term.buffer.active.cursorY,source.term.buffer.active.cursorY);
 }finally{source.dispose();client.dispose();}
});

test('returning after sustained spinner output restores the final screen without its animation backlog',async()=>{
 const source=new TerminalScreen(80,24),client=new TerminalScreen(80,24);
 try{
  const animation=Array.from({length:5000},(_,i)=>`\rProgress ${i} ${'|/-\\'[i%4]}\x1b[K`).join('');
  await source.write(Buffer.from(animation+'\rComplete\x1b[K'));
  const snapshot=await source.snapshot();const bytes=Buffer.from(snapshot.b64,'base64');
  assert.ok(bytes.length<1024,'snapshot should contain cells, not thousands of spinner updates');
  await client.write(bytes,true,snapshot.cols,snapshot.rows);
  assert.equal(lines(client)[0],'Complete');assert.deepEqual(lines(client),lines(source));
 }finally{source.dispose();client.dispose();}
});
