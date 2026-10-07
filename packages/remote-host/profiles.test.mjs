import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile,symlink,mkdir,writeFile} from 'node:fs/promises';
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
test('copies named credentials and refreshes an existing cloud account on re-sync',()=>fixture(async(home,p)=>{
 const item={id:'work',label:'Work account',accounts:{codex:{tokens:{access_token:'synthetic'}}}};
 assert.deepEqual(await importAccountProfiles([item],home),{imported:['Work account'],updated:[],skipped:[]});
 assert.equal((await p.list())[1].label,'Work account');
 assert.equal((await p.accounts('work')).find(a=>a.agent==='codex').state,'in');
 await writeFile(home+'/.canopy/profiles/work/.codex/history.jsonl','kept');
 const next={...item,label:'Work',accounts:{codex:{tokens:{access_token:'synthetic-next'}},claude:{claudeAiOauth:{accessToken:'synthetic-a',refreshToken:'synthetic-r'}}},claudeIdentity:{emailAddress:'work@example.com',secret:'dropped'}};
 assert.deepEqual(await importAccountProfiles([next],home),{imported:[],updated:['Work'],skipped:[]});
 assert.match(await readFile(home+'/.canopy/profiles/work/.codex/auth.json','utf8'),/synthetic-next/);
 assert.equal(await readFile(home+'/.canopy/profiles/work/.codex/history.jsonl','utf8'),'kept');
 assert.deepEqual(JSON.parse(await readFile(home+'/.canopy/profiles/work/.claude/.claude.json','utf8')).oauthAccount,{emailAddress:'work@example.com'});
 assert.deepEqual((await p.accounts('work')).find(a=>a.agent==='claude'),{agent:'claude',state:'in',account:'work@example.com'});
 assert.equal((await p.list())[1].label,'Work');assert.equal((await p.list()).length,2);
 await p.remove('work');assert.match(await readFile(home+'/.canopy/profiles/work/.codex/auth.json','utf8'),/synthetic-next/);
}));
test('a Claude login without a recorded identity still reads as signed in',()=>fixture(async(home,p)=>{
 await mkdir(home+'/.claude');await writeFile(home+'/.claude/.credentials.json',JSON.stringify({claudeAiOauth:{accessToken:'synthetic-a',refreshToken:'synthetic-r'}}));
 assert.deepEqual((await p.accounts('default')).find(a=>a.agent==='claude'),{agent:'claude',state:'in',account:null});
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
