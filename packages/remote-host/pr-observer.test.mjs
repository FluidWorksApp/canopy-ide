import test from 'node:test';
import assert from 'node:assert/strict';
import {PrObserver} from './pr-observer.mjs';

test('watches the projects the IDE names, sooner while it is focused, and survives a failing one',async()=>{
 const seen=[],timers=[];
 const observer=new PrObserver({observe:async repo=>{seen.push(repo);if(repo==='/workspace/b')throw Error('no gh');},setTimer:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimer:t=>{t.cleared=true;}});
 observer.watch(['/workspace/a','/workspace/b','relative','/workspace/a'],true);
 assert.equal(timers.at(-1).ms,1000);
 await observer.now();
 assert.deepEqual(seen,['/workspace/a','/workspace/b']);
 assert.equal(timers.at(-1).ms,3*60_000);
 observer.watch(['/workspace/a'],false);await observer.now();
 assert.equal(timers.at(-1).ms,15*60_000);
 observer.watch([],false);assert.ok(timers.at(-1).cleared);
});
