import test from 'node:test';import assert from 'node:assert/strict';import {checkpointOwner} from './owner-checkpoint.mjs';
const image='sha256:'+'a'.repeat(64);
test('owner checkpoint refuses a live or foreign container before committing',async()=>{
 for(const current of [{Config:{Labels:{'canopy.workspace':'other'}},State:{Running:false}},{Config:{Labels:{'canopy.workspace':'owner'}},State:{Running:true}}]){
  const calls=[];await assert.rejects(checkpointOwner({id:'owner'},{docker:async args=>{calls.push(args);return {stdout:JSON.stringify([current])};}}),/Stop/);assert.equal(calls.length,1);
 }
});
test('checkpoint verifies its pinned image while retaining the original container',async()=>{
 const calls=[];const result=await checkpointOwner({id:'owner'},{docker:async args=>{calls.push(args);return {stdout:args[0]==='inspect'?JSON.stringify([{Id:'original',Config:{Labels:{'canopy.workspace':'owner'}},State:{Running:false}}]):args[0]==='commit'?image:JSON.stringify([{Id:image,Config:{Labels:{'canopy.owner-checkpoint':'owner'}}}])};}});
 assert.deepEqual(result,{ownerImage:image,originalContainerId:'original'});assert.deepEqual(calls.map(c=>c[0]),['inspect','commit','image']);
});
