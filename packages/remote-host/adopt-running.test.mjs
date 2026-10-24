import test from 'node:test';
import assert from 'node:assert/strict';
import {adoptRunning} from './adopt-running.mjs';

test('after a host restart only running owner workspaces are opened, never started',async()=>{
 const opened=[],attached=[],states={alice:{Running:true},bob:{Running:false},carol:{Running:true,Paused:true}};
 const host={inspectRuntime:async w=>w.id==='gone'?null:{State:states[w.id]??{Running:true}},open:async(w,options)=>{opened.push([w.id,typeof options.authorize]);return {url:'u-'+w.id,harness:true};}};
 const harness={attach:async(w,runtime)=>attached.push([w.id,runtime.url])};
 const config={workspaces:[{id:'alice'},{id:'bob'},{id:'carol'},{id:'gone'},{id:'member-x',memberId:'m',parentWorkspaceId:'alice'},{id:'dave',desiredState:'stopped'}]};
 const ids=await adoptRunning({config,host,harness,authorize:async()=>true,log:()=>{}});
 assert.deepEqual(ids,['alice']);
 assert.deepEqual(opened,[['alice','function']],'open without resume, under the runtime authority');
 assert.deepEqual(attached,[['alice','u-alice']]);
});

test('one workspace failing does not stop the others',async()=>{
 const logs=[];
 const host={inspectRuntime:async w=>{if(w.id==='a')throw Error('docker down');return {State:{Running:true}};},open:async w=>({url:w.id})};
 assert.deepEqual(await adoptRunning({config:{workspaces:[{id:'a'},{id:'b'}]},host,log:m=>logs.push(m)}),['b']);
 assert.match(logs[0],/a was not adopted: docker down/);
});
