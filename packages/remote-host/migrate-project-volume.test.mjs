import test from 'node:test';import assert from 'node:assert/strict';
import {migrateProjectVolume} from './migrate-project-volume.mjs';
import {projectMounts} from './project-mounts.mjs';
const workspace={id:'owner'},project={id:'app',name:'App',components:[{id:'web',label:'Web',source:'repo',relativePath:'.'}]};
const destination=projectMounts({...workspace,projectMounts:[{id:'app',writable:true}]})[0][1];
function harness({busy=false,failure=false,mapping}={}){
 const calls=[];
 const docker=async args=>{
  calls.push(args);
  if(args[0]==='volume'&&args[1]==='inspect')return {stdout:JSON.stringify([{Name:args[2],Driver:'local',Labels:{'canopy.workspace':'owner','canopy.project':'app'}}])};
  if(args[0]==='ps')return {stdout:busy?'live-container':''};
  if(args[0]==='run'&&args.includes('node')&&failure)throw Error('Docker timeout');
  if(args[0]==='run'&&args.includes('node'))return {stdout:JSON.stringify(mapping??project.components.map(({id,label,relativePath})=>({id,label,relativePath:relativePath==='.'?'content':'content/'+relativePath})))};
  return {stdout:''};
 };return {calls,docker,image:'synthetic-image'};
}
test('migration refuses active users and member runtimes without creating volumes',async()=>{
 const active=harness({busy:true});await assert.rejects(migrateProjectVolume(workspace,project,active),/Stop all/);
 assert.ok(active.calls.every(args=>!['create','run','rm'].some(op=>args.includes(op))));
 const member=harness();await assert.rejects(migrateProjectVolume({...workspace,memberId:'alice'},project,member),/owning workspace/);assert.equal(member.calls.length,0);
});
test('migration helper sees only read-only source and its selected destination, with no account volumes',async()=>{
 const h=harness();const result=await migrateProjectVolume(workspace,project,h);
 assert.equal(result.components[0].relativePath,'content');
 const run=h.calls.find(args=>args[0]==='run'&&args.includes('node'));
 assert.ok(run.includes('type=volume,source=canopy-project-owner,target=/source,readonly'));
 assert.ok(run.includes(`type=volume,source=${destination},target=/destination`));
 assert.ok(!run.some(value=>value.includes('canopy-home')||value.includes('canopy-account')));
 assert.ok(run.includes('--read-only'));assert.ok(run.includes('none'));
});
test('Docker timeout forcibly removes only the uniquely named migration helper',async()=>{
 const h=harness({failure:true});await assert.rejects(migrateProjectVolume(workspace,project,h),/timeout/);
 const run=h.calls.find(args=>args[0]==='run'&&args.includes('node'));
 const name=run[run.indexOf('--name')+1];assert.match(name,/^canopy-migrate-[0-9a-f-]{36}$/);
 assert.deepEqual(h.calls.at(-1),['rm','--force',name]);
});

test('failed helper cleanup blocks workspace startup until explicit recovery succeeds',async()=>{
 const {DockerWorkspaces}=await import('./docker.mjs');
 const h=harness({failure:true});const original=h.docker;
 let cleanupFails=true;
 const docker=async args=>{if(args[0]==='rm'&&cleanupFails)throw Error('Docker unavailable');return original(args);};
 const host=new DockerWorkspaces({secret:'synthetic',docker,registry:[workspace]});
 await assert.rejects(host.migrateProject(workspace,project),/could not be stopped/);
 await assert.rejects(host.ensure(workspace),/requires recovery/);
 await assert.rejects(host.ensure({id:'member',parentWorkspaceId:'owner'}),/requires recovery/);
 cleanupFails=false;await host.recoverMigrations();assert.equal(host.migrationCleanupRequired.size,0);
});
test('host recovery stops orphaned copies only for configured workspace ownership',async()=>{
 const {DockerWorkspaces}=await import('./docker.mjs');
 const name='canopy-migrate-11111111-1111-4111-8111-111111111111',calls=[];
 let owner='foreign';
 const docker=async args=>{calls.push(args);return {stdout:args[0]==='ps'?name:args[0]==='inspect'?JSON.stringify([{Config:{Labels:{'canopy.migration':'true','canopy.workspace':owner}}}]):''};};
 const host=new DockerWorkspaces({secret:'synthetic',docker,registry:[workspace]});
 await assert.rejects(host.recoverMigrations(),/ownership differs/);assert.ok(!calls.some(a=>a[0]==='rm'));
 owner='owner';await host.recoverMigrations();assert.deepEqual(calls.at(-1),['rm','--force',name]);
});
test('returned component metadata cannot change identities, escape the volume or inject configuration',async()=>{
 for(const mapping of [[{id:'other',label:'Web',relativePath:'content'}],[{id:'web',label:'Web',relativePath:'content/../../home'}],[{id:'web',label:'Web',relativePath:'content',credential:'forged'}]]){
  const h=harness({mapping});await assert.rejects(migrateProjectVolume(workspace,project,h));const cleanup=h.calls.at(-1);assert.equal(cleanup[0],'rm');assert.equal(cleanup[1],'--force');assert.match(cleanup[2],/^canopy-migrate-/);
 }
});
