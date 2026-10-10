import test from 'node:test';
import assert from 'node:assert/strict';
import {ScreencastLifecycle} from './protocol.mjs';
function fixture(options){
 const calls=[];let running=false,visible=true,pending;
 const session={async send(method){calls.push(method);if(method==='Page.startScreencast'){assert.equal(running,false,'CDP forbids a second active screencast');running=true;if(pending)await pending;}if(method==='Page.stopScreencast')running=false;}};
 const stream=new ScreencastLifecycle(session,()=>visible,options);
 return {calls,stream,hide:()=>visible=false,show:()=>visible=true,hold:()=>{let release;pending=new Promise(r=>release=r);return ()=>{pending=null;release();};},running:()=>running};
}
test('connect, repeated visible messages and refresh share one serialized screencast owner',async()=>{
 const f=fixture(),release=f.hold();const first=f.stream.start();
 while(!f.calls.includes('Page.startScreencast'))await Promise.resolve();
 const requests=[...Array.from({length:8},()=>f.stream.start()),f.stream.restart(),f.stream.start()];
 assert.equal(f.calls.filter(c=>c==='Page.startScreencast').length,1);
 release();await Promise.all([first,...requests]);
 assert.equal(f.calls.filter(c=>c==='Page.startScreencast').length,2);
 assert.equal(f.calls.filter(c=>c==='Page.stopScreencast').length,1);assert.equal(f.running(),true);
});
test('hide or tab retirement during an outstanding start cannot restart the old page',async()=>{
 const f=fixture(),release=f.hold(),first=f.stream.start();
 while(!f.calls.includes('Page.startScreencast'))await Promise.resolve();
 const refresh=f.stream.restart();f.hide();const stop=f.stream.stop();release();await Promise.all([first,refresh,stop]);
 assert.equal(f.running(),false);assert.equal(f.calls.filter(c=>c==='Page.startScreencast').length,1);
 f.show();await f.stream.start();assert.equal(f.running(),true);
});
test('unresolved CDP commands fail within a bound and fence late completion',async()=>{
 const f=fixture({timeoutMs:20}),release=f.hold();await assert.rejects(f.stream.start(),/timed out.*Page.startScreencast/);
 const count=f.calls.length;release();await Promise.resolve();
 await assert.rejects(f.stream.start(),/Reconnect/);await assert.rejects(f.stream.restart(),/Reconnect/);
 assert.equal(f.calls.length,count,'A timed-out command must not be followed by another ambiguous start');
});

test('screenshots wait for preceding visibility transitions and do not race a screencast start',async()=>{
 const f=fixture(),release=f.hold(),start=f.stream.start();
 while(!f.calls.includes('Page.startScreencast'))await Promise.resolve();
 const hidden=f.stream.stop(),shown=f.stream.start();
 const capture=f.stream.enqueue(()=>f.stream.command('Page.captureScreenshot',{format:'png',fromSurface:true}));
 await Promise.resolve();assert.ok(!f.calls.includes('Page.captureScreenshot'));
 release();await Promise.all([start,hidden,shown,capture]);
 assert.deepEqual(f.calls.filter(method=>['Page.startScreencast','Page.stopScreencast','Page.captureScreenshot'].includes(method)),['Page.startScreencast','Page.stopScreencast','Page.startScreencast','Page.captureScreenshot']);
});
