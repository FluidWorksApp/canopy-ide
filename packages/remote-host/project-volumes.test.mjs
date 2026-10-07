import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareProjectVolumes} from './project-volumes.mjs';
import {projectMounts} from './project-mounts.mjs';
const workspace={id:'owner',projectMounts:[{id:'app',writable:true}]};
const volume=projectMounts(workspace)[0][1];
const valid={Name:volume,Driver:'local',Options:null,Labels:{'canopy.workspace':'owner','canopy.project':'app'}};
test('project initializer refuses foreign and host-bound volumes before launching a helper',async()=>{
 for(const changed of [{Name:'other'},{Driver:'nfs'},{Options:{device:'/'}},{Labels:{'canopy.workspace':'other','canopy.project':'app'}},{Labels:{'canopy.workspace':'owner','canopy.project':'secret'}}]){
  const calls=[];const docker=async args=>{calls.push(args);return {stdout:JSON.stringify([{...valid,...changed}])};};
  await assert.rejects(prepareProjectVolumes(workspace,{docker,image:'image'}),/ownership differs/);
  assert.equal(calls.length,1);
 }
});
test('new project volume is labeled and rechecked before isolated nonrecursive initialization',async()=>{
 let exists=false;const calls=[];
 const docker=async args=>{calls.push(args);if(args[0]==='volume'&&args[1]==='inspect'){if(!exists)throw Object.assign(Error('missing'),{missingResource:true});return {stdout:JSON.stringify([valid])};}if(args[1]==='create')exists=true;return {stdout:''};};
 await prepareProjectVolumes({...workspace,id:'member-a',parentWorkspaceId:'owner'},{docker,image:'image'});
 assert.deepEqual(calls.map(c=>c.slice(0,2)),[['volume','inspect'],['volume','create'],['volume','inspect'],['run','--rm']]);
 const helper=calls.at(-1);assert.ok(helper.includes('none'));assert.ok(helper.includes('--read-only'));assert.ok(helper.includes('--no-dereference'));assert.ok(!helper.includes('-R'));assert.ok(!helper.includes('--env'));assert.equal(helper.filter(x=>x==='--mount').length,1);
});
