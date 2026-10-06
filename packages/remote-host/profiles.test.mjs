import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceProfiles} from './profiles.mjs';
import {importAccountProfiles} from './agent-accounts.mjs';
const fixture=async fn=>{const home=await realpath(await mkdtemp(path.join(tmpdir(),'canopy-profiles-')));try{await fn(home,new WorkspaceProfiles(home));}finally{await rm(home,{recursive:true,force:true});}};
test('named profiles persist activation, isolate launch env and retain files after removal',()=>fixture(async(home,p)=>{
 const work=await p.create('Work account');await p.activate(work.id);
 assert.equal((await new WorkspaceProfiles(home).registry()).active,work.id);
 assert.deepEqual(await p.env('codex',work.id),[['CANOPY_PROFILE',work.id],['CODEX_HOME',work.root+'/.codex']]);
 assert.deepEqual(await p.env('codex','default'),[]);
 assert.equal(await p.remove(work.id),work.root);
 assert.equal((await p.registry()).active,'default');
 await assert.rejects(p.env('codex',work.id),/not found/);
 await assert.rejects(p.remove('default'));
}));
test('copies named credentials without overwriting an existing cloud account',()=>fixture(async(home,p)=>{
 const item={id:'work',label:'Work account',accounts:{codex:{tokens:{access_token:'synthetic'}}}};
 assert.deepEqual(await importAccountProfiles([item],home),{imported:['Work account'],skipped:[]});
 assert.equal((await p.list())[1].label,'Work account');
 assert.equal((await p.accounts('work')).find(a=>a.agent==='codex').state,'in');
 assert.deepEqual(await importAccountProfiles([item],home),{imported:[],skipped:['Work account']});
 await p.remove('work');assert.match(await readFile(home+'/.canopy/profiles/work/.codex/auth.json','utf8'),/synthetic/);
}));
test('invalid import and symlink roots cannot write outside a profile',()=>fixture(async(home,p)=>{
 await assert.rejects(importAccountProfiles([{id:'../escape',label:'Bad',accounts:{}}],home));
 await mkdir(home+'/.canopy');await mkdir(home+'/outside');await symlink(home+'/outside',home+'/.canopy/profiles');
 await assert.rejects(p.create('work'),/symlink/);
}));

test('failed credential preparation is not published as a completed account',()=>fixture(async(home,p)=>{
 await assert.rejects(p.create('work',async()=>{throw Error('Synthetic write failure');}),/Synthetic/);
 assert.equal((await p.list()).length,1);
 const retry=await p.create('work');assert.equal(retry.id,'work');
}));
