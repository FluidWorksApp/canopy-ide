import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForPicker} from './server.mjs';
test('picker operations wait for the next document rather than an early navigation event',async()=>{
 const calls=[];let release;const load=new Promise(r=>release=r);const page={async waitForLoadState(state,options){calls.push({state,timeout:options.timeout});await load;},async waitForFunction(predicate,arg,options){calls.push({picker:true,timeout:options.timeout});}};
 const ready=waitForPicker(page);await Promise.resolve();assert.equal(calls.length,1);release();await ready;assert.equal(calls[0].state,'domcontentloaded');assert.equal(calls[1].picker,true);assert.ok(calls[1].timeout>0&&calls[1].timeout<=10000);
});
test('missing picker or failed document load fails without hidden retries',async()=>{
 let attempts=0;const page={async waitForLoadState(){},async waitForFunction(){attempts++;throw Error('picker timed out');}};
 await assert.rejects(waitForPicker(page),/picker timed out/);assert.equal(attempts,1);
 page.waitForLoadState=async()=>{throw Error('document closed');};await assert.rejects(waitForPicker(page),/document closed/);assert.equal(attempts,1);
});
