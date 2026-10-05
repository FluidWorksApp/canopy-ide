import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserStreams,workspacePreviewUrl} from './browser-streams.mjs';
import {authorizeStream,digest} from './policy.mjs';
test('workspace preview rejects external destinations and embedded credentials',()=>{
 for(const url of ['file:///etc/passwd','http://example.com','http://token@localhost:3000','http://localhost.example.com'])assert.throws(()=>workspacePreviewUrl(url));
 for(const url of ['http://localhost:3000','https://127.0.0.1:3000','http://[::1]:3000','http://app.localhost:3000'])assert.equal(workspacePreviewUrl(url),url+'/');
});
test('interactive browser stream requires drive and observes credential rotation',()=>{
 const config={workspaces:[{id:'w'}],principals:[{id:'a',scope:'view',workspaces:['w'],tokenSha256:digest('x')}]},grant={principalId:'a',principalFingerprint:digest('x'),workspaceId:'w',stream:'/browsers/00000000-0000-0000-0000-000000000000/stream'};
 assert.throws(()=>authorizeStream(config,grant),/Forbidden/);config.principals[0].scope='drive';assert.equal(authorizeStream(config,grant).workspace.id,'w');config.principals[0].tokenSha256=digest('y');assert.throws(()=>authorizeStream(config,grant),/Unauthorized/);
});
function spawner(viewer='http://127.0.0.1:9001/'+'a'.repeat(64)+'/'){const calls=[];const spawnImpl=(bin,args,options)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stdin={write(config){calls.push({bin,args,options,config:JSON.parse(config)});queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({url:viewer})+'\n')));},end(){child.emit('exit');}};child.kill=()=>child.emit('exit');return child;};return{calls,spawnImpl};}
test('preview profiles are private and bounded; bridge URL is never returned',async()=>{
 const home=await mkdtemp(join(tmpdir(),'canopy-browser-test-')),fake=spawner(),registry=new BrowserStreams({home,spawnImpl:fake.spawnImpl,maxSessions:1});try{
 const result=await registry.open({sessionId:'one',url:'http://localhost:3000'});assert.deepEqual(Object.keys(result),['id']);assert.equal((await registry.open({sessionId:'one',url:'http://localhost:3000'})).id,result.id);assert.equal(fake.calls.length,1);assert.equal(fake.calls[0].config.workspace,true);assert.ok(fake.calls[0].config.profileDirectory.startsWith(home+'/.canopy/browser-profiles/'));await assert.rejects(registry.open({sessionId:'two',url:'http://localhost:3000'}),/Close/);await registry.close(result.id);assert.equal(registry.entries.size,0);await registry.open({sessionId:'reconnected',profileId:'one',url:'http://localhost:3000'});assert.equal(fake.calls[1].config.profileDirectory,fake.calls[0].config.profileDirectory);
 }finally{registry.dispose();await rm(home,{recursive:true,force:true});}
});
test('fabricated bridge replies cannot redirect to management or another host',async()=>{
 const home=await mkdtemp(join(tmpdir(),'canopy-browser-test-'));try{for(const target of ['http://127.0.0.1:8081/'+'a'.repeat(64)+'/','http://management.example:9000/'+'a'.repeat(64)+'/','http://127.0.0.1:9000/other']){const registry=new BrowserStreams({home,spawnImpl:spawner(target).spawnImpl});await assert.rejects(registry.open({sessionId:'one',url:'http://localhost:3000'}),/failed/);assert.equal(registry.entries.size,0);registry.dispose();}}finally{await rm(home,{recursive:true,force:true});}
});
