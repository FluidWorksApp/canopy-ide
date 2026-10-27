import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,realpath,mkdir,chmod,stat,unlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {turnsCommands,pairNative,forgetDeliveries,TURNS_READ_ONLY,MAX_TURNS,MAX_AGE_SECS} from './turns.mjs';

const execute=promisify(execFile);
const ENV={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
const sh=(cwd,...args)=>execute('git',['-c','user.name=T','-c','user.email=t@t','-c','commit.gpgSign=false',...args],{cwd,env:ENV}).then(r=>r.stdout);
const write=async(root,rel,body)=>{await mkdir(dirname(join(root,rel)),{recursive:true});await writeFile(join(root,rel),body);};
const read=(root,rel)=>readFile(join(root,rel),'utf8').catch(()=>null);
const exists=p=>access(p).then(()=>true,()=>false);
const now=()=>Date.now();

// Repo with a commit, a staged change, an unstaged change, an untracked file and
// an ignored file; plus a home with a sessions dir.
async function fixture(){
 const base=await realpath(await mkdtemp(join(tmpdir(),'turns-')));
 const root=join(base,'repo'),home=join(base,'home');
 await mkdir(root);await mkdir(join(home,'.canopy/sessions'),{recursive:true});
 await sh(root,'init','-q','-b','main');
 await write(root,'.gitignore','ignored.log\nbuild/\n');await write(root,'tracked.txt','v1\n');await write(root,'src/lib.rs','fn a() {}\n');
 await sh(root,'add','-A');await sh(root,'commit','-q','-m','init');await sh(root,'branch','feature');
 await write(root,'src/lib.rs','fn a() { staged }\n');await sh(root,'add','src/lib.rs');
 await write(root,'tracked.txt','v1 unstaged\n');await write(root,'untracked.txt','new file\n');
 await write(root,'ignored.log','noise\n');await write(root,'build/out.bin','artifact\n');
 return {base,root,home};
}
// The host ctx over a temp workspace; `intercept` can answer a bin first.
function ctxFor({base,home},intercept){
 const scoped=async p=>{const r=await realpath(p);if(r!==base&&!r.startsWith(base+'/'))throw Error('Path outside selected workspace');return r;};
 const exec=(bin,argv,options)=>{const hit=intercept?.(bin,argv,options);if(hit)return hit;return execute(bin,argv,{...options,env:{...options.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});};
 return {home,root:base,scoped,execute:exec,run:(bin,argv,cwd=base)=>exec(bin,argv,{cwd,env:process.env}).then(r=>r.stdout)};
}
async function fingerprint(r){
 const v=[await readFile(join(r,'.git/index')),await readFile(join(r,'.git/HEAD')),await sh(r,'for-each-ref','refs/heads'),await sh(r,'status','--porcelain=v2','--untracked-files=all','--ignored')];
 for(const f of ['tracked.txt','src/lib.rs','untracked.txt','ignored.log','build/out.bin','.gitignore'])v.push(await readFile(join(r,f)).catch(()=>Buffer.alloc(0)));
 return v.map(String);
}
const filesIn=async(r,rev)=>(await sh(r,'ls-tree','-r','--name-only',rev)).split('\n').filter(Boolean);
const snap=(c,root,sessionId,kind,extra={})=>{forgetDeliveries(root);return c.turn_snapshot({cwd:root,sessionId,kind,observedMs:now(),...extra});};
const cleanup=f=>rm(f.base,{recursive:true,force:true});

test('a snapshot leaves the index, worktree, HEAD and branches byte-identical',async()=>{
 const f=await fixture(),{root}=f;
 try{
  const c=turnsCommands(ctxFor(f));
  await sh(root,'status','--porcelain');
  const before=await fingerprint(root),index=await readFile(join(root,'.git/index'));
  const out=await snap(c,root,'s1','start',{prompt:'do   the\nthing'});
  assert.deepEqual(out,{taken:true,ref:'refs/canopy/turns/s1/1',n:1,late:false,note:null});
  assert.deepEqual(await readFile(join(root,'.git/index')),index,'user index changed');
  assert.deepEqual(await fingerprint(root),before);
  const files=await filesIn(root,'refs/canopy/turns/s1/1');
  assert.ok(files.includes('untracked.txt')&&files.includes('tracked.txt'));
  assert.ok(!files.some(x=>x==='ignored.log'||x.startsWith('build/')));
  assert.equal(await sh(root,'show','refs/canopy/turns/s1/1:tracked.txt'),'v1 unstaged\n');
  assert.equal(await sh(root,'show','refs/canopy/turns/s1/1:src/lib.rs'),'fn a() { staged }\n');
  assert.equal((await sh(root,'diff','--cached','--name-only')).trim(),'src/lib.rs');
  // Same commit body format as Rust: subject, blank, one JSON line.
  const body=await sh(root,'log','-1','--format=%B','refs/canopy/turns/s1/1');
  assert.match(body,/^canopy turn 1 start\n\n\{"v":1,"kind":"start","session":"s1","n":1,"ts_ms":\d+,"observed_ms":\d+,"prompt":"do the thing","late":false,"root":".*","target":null\}\n/);
  assert.equal((await sh(root,'log','-1','--format=%an <%ae>','refs/canopy/turns/s1/1')).trim(),'Canopy <canopy@localhost>');
 }finally{await cleanup(f);}
});

test('snapshot works on an unborn branch and creates no index',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'turns-'))),root=join(base,'r'),home=join(base,'h');
 try{
  await mkdir(root);await mkdir(home);await sh(root,'init','-q','-b','main');await write(root,'a.txt','hello\n');
  const c=turnsCommands(ctxFor({base,home}));
  assert.equal((await snap(c,root,'s1','start')).taken,true);
  assert.equal(await sh(root,'show','refs/canopy/turns/s1/1:a.txt'),'hello\n');
  await assert.rejects(sh(root,'rev-parse','--verify','-q','HEAD^{commit}'));
  assert.equal(await exists(join(root,'.git/index')),false,'no index may be created');
 }finally{await rm(base,{recursive:true,force:true});}
});

test('outside a git work tree: list says so, snapshot skips, preview/restore refuse',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'turns-')));
 try{
  const c=turnsCommands(ctxFor({base,home:base}));
  assert.deepEqual(await c.turn_list({cwd:base,sessionId:'s'}),{git:false,root:null,shared:false,peers:[],turns:[],restores:[]});
  assert.deepEqual(await c.turn_snapshot({cwd:base,sessionId:'s',kind:'start'}),{taken:false,ref:null,n:null,late:false,note:'rollback needs git'});
  await assert.rejects(c.turn_preview({cwd:base,sessionId:'s',target:'refs/canopy/turns/s/1',scope:'all'}),/rollback needs git/);
  await assert.rejects(c.turn_restore({cwd:base,sessionId:'s',target:'refs/canopy/turns/s/1',scope:'all'}),/rollback needs git/);
  await assert.rejects(c.turn_list({cwd:'/etc',sessionId:'s'}),/outside/);
 }finally{await rm(base,{recursive:true,force:true});}
});

test('turns number in order and a Stop closes the open turn',async()=>{
 const f=await fixture(),{root}=f;
 try{
  const c=turnsCommands(ctxFor(f)),s=k=>snap(c,root,'s2',k,{prompt:'p'}).then(o=>o.n);
  assert.equal(await s('start'),1);assert.equal(await s('end'),1);
  assert.equal(await s('start'),2);assert.equal(await s('end'),2);
  assert.equal(await s('end'),3);
  const l=await c.turn_list({cwd:root,sessionId:'s2'});
  assert.equal(l.git,true);assert.equal(l.root,root);assert.equal(l.turns.length,3);
  assert.ok(l.turns[2].start===null&&l.turns[2].end!==null);
  assert.equal(l.turns[0].prompt,'p');
  assert.deepEqual(Object.keys(l.turns[0]),['n','start','end','prompt','late','native_uuid']);
  assert.deepEqual(Object.keys(l.turns[0].start),['ref','commit','tree','ts_ms']);
 }finally{await cleanup(f);}
});

test('duplicate delivery is collapsed',async()=>{
 const f=await fixture(),{root}=f;
 try{
  const c=turnsCommands(ctxFor(f));forgetDeliveries(root);
  const [a,b]=await Promise.all([c.turn_snapshot({cwd:root,sessionId:'dup',kind:'start'}),c.turn_snapshot({cwd:root,sessionId:'dup',kind:'start'})]);
  assert.ok(a.taken&&!b.taken);assert.equal(b.note,'duplicate delivery');
 }finally{await cleanup(f);}
});

test('restore brings back exact content, removes files created since, and is undoable',async()=>{
 const f=await fixture(),{root}=f;
 try{
  const c=turnsCommands(ctxFor(f));
  await snap(c,root,'s3','start');
  const index=await readFile(join(root,'.git/index'));
  await write(root,'tracked.txt','agent rewrote this\n');await unlink(join(root,'untracked.txt'));
  await write(root,'new/dir/created.txt','by the agent\n');await write(root,'ignored.log','agent noise\n');
  const pv=await c.turn_preview({cwd:root,sessionId:'s3',target:'refs/canopy/turns/s3/1',scope:'all'});
  assert.deepEqual(Object.keys(pv),['changes','excluded','scoped','shared','patch','truncated']);
  assert.deepEqual(pv.changes.map(x=>[x.path,x.status]).sort(),[['new/dir/created.txt','delete'],['tracked.txt','modify'],['untracked.txt','add']]);
  assert.deepEqual(Object.keys(pv.changes[0]),['path','status']);
  assert.ok(pv.patch.includes('agent rewrote this'));assert.equal(pv.truncated,false);
  const out=await c.turn_restore({cwd:root,sessionId:'s3',target:'refs/canopy/turns/s3/1',scope:'all'});
  assert.deepEqual(out.failed,[]);
  assert.deepEqual(out.native,{attempted:false,ok:false,message:''});
  assert.match(out.redo_ref,/^refs\/canopy\/restores\/s3\/\d+$/);
  assert.equal(await read(root,'tracked.txt'),'v1 unstaged\n');
  assert.equal(await read(root,'untracked.txt'),'new file\n');
  assert.equal(await exists(join(root,'new/dir/created.txt')),false);
  assert.equal(await exists(join(root,'new')),false,'emptied directories are tidied');
  assert.equal(await read(root,'ignored.log'),'agent noise\n');
  assert.deepEqual(await readFile(join(root,'.git/index')),index,'restore never writes the user index');
  const l=await c.turn_list({cwd:root,sessionId:'s3'});
  assert.deepEqual(l.restores.map(r=>[r.ref,r.target]),[[out.redo_ref,'refs/canopy/turns/s3/1']]);
  const redo=await c.turn_restore({cwd:root,sessionId:'s3',target:out.redo_ref,scope:'all'});
  assert.deepEqual(redo.failed,[]);
  assert.equal(await read(root,'tracked.txt'),'agent rewrote this\n');
  assert.equal(await read(root,'new/dir/created.txt'),'by the agent\n');
  assert.equal(await exists(join(root,'untracked.txt')),false);
 }finally{await cleanup(f);}
});

test('restore keeps the executable bit and symlinks',async()=>{
 const f=await fixture(),{root}=f;
 try{
  const c=turnsCommands(ctxFor(f));
  await write(root,'run.sh','#!/bin/sh\necho hi\n');await chmod(join(root,'run.sh'),0o755);
  await execute('ln',['-s','tracked.txt',join(root,'link')]);
  await snap(c,root,'x','start');
  await unlink(join(root,'run.sh'));await unlink(join(root,'link'));
  await c.turn_restore({cwd:root,sessionId:'x',target:'refs/canopy/turns/x/1',scope:'all'});
  assert.equal((await stat(join(root,'run.sh'))).mode&0o111,0o111);
  assert.equal(await read(root,'link'),'v1 unstaged\n');
 }finally{await cleanup(f);}
});

test('restore runs smudge filters like checkout',async()=>{
 const f=await fixture(),{root}=f;
 try{
  const c=turnsCommands(ctxFor(f));
  await sh(root,'config','filter.shout.clean','tr a-z A-Z');await sh(root,'config','filter.shout.smudge','tr A-Z a-z');
  await write(root,'.gitattributes','*.shout filter=shout\n');await write(root,'x.shout','quiet words\n');
  await snap(c,root,'f','start');
  assert.equal(await sh(root,'cat-file','blob','refs/canopy/turns/f/1:x.shout'),'QUIET WORDS\n');
  await write(root,'x.shout','changed\n');
  await c.turn_restore({cwd:root,sessionId:'f',target:'refs/canopy/turns/f/1',scope:'all'});
  assert.equal(await read(root,'x.shout'),'quiet words\n');
 }finally{await cleanup(f);}
});

test('restore honours the autocrlf round trip',async()=>{
 const f=await fixture(),{root}=f;
 try{
  const c=turnsCommands(ctxFor(f));
  await sh(root,'config','core.autocrlf','true');await write(root,'win.txt','line1\r\nline2\r\n');
  await snap(c,root,'c','start');await write(root,'win.txt','other\r\n');
  await c.turn_restore({cwd:root,sessionId:'c',target:'refs/canopy/turns/c/1',scope:'all'});
  assert.equal(await read(root,'win.txt'),'line1\r\nline2\r\n');
 }finally{await cleanup(f);}
});

// A peer digest in the same checkout makes it shared; the journal says which paths are ours.
async function makeShared(home,repo,ours,files){
 const t=Math.floor(now()/1000);
 await writeFile(join(home,'.canopy/sessions/peer.json'),JSON.stringify({session_id:'peer',cwd:repo,updated:t,state:'working'}));
 await writeFile(join(home,`.canopy/sessions/${ours}.edits.jsonl`),files.map(x=>JSON.stringify({ts:t,agent:'claude',path:join(repo,x),tool:'Write'})+'\n').join(''));
}

test('a shared checkout restores only attributed paths unless asked for all',async()=>{
 const f=await fixture(),{root,home}=f;
 try{
  const c=turnsCommands(ctxFor(f));
  await snap(c,root,'me','start');
  await write(root,'tracked.txt','mine edit\n');await write(root,'mine.txt','mine new\n');
  await write(root,'src/lib.rs','peer edit\n');await write(root,'theirs.txt','peer new\n');
  await makeShared(home,root,'me',['tracked.txt','mine.txt']);
  const l=await c.turn_list({cwd:root,sessionId:'me'});
  assert.equal(l.shared,true);assert.deepEqual(l.peers,['peer']);
  const pv=await c.turn_preview({cwd:root,sessionId:'me',target:'refs/canopy/turns/me/1',scope:'auto'});
  assert.equal(pv.scoped,true);assert.equal(pv.shared,true);
  assert.ok(!pv.patch.includes('peer edit'));
  const out=await c.turn_restore({cwd:root,sessionId:'me',target:'refs/canopy/turns/me/1',scope:'auto'});
  assert.equal(await read(root,'tracked.txt'),'v1 unstaged\n');
  assert.equal(await exists(join(root,'mine.txt')),false);
  assert.equal(await read(root,'src/lib.rs'),'peer edit\n');assert.equal(await read(root,'theirs.txt'),'peer new\n');
  assert.deepEqual([...out.excluded].sort(),['src/lib.rs','theirs.txt']);
  await write(root,'tracked.txt','again\n');
  await c.turn_restore({cwd:root,sessionId:'me',target:'refs/canopy/turns/me/1',scope:'all'});
  assert.equal(await read(root,'src/lib.rs'),'fn a() { staged }\n');
  assert.equal(await exists(join(root,'theirs.txt')),false);
 }finally{await cleanup(f);}
});

test('a peer in another worktree does not make the checkout shared',async()=>{
 const f=await fixture(),{root,home}=f;
 try{
  const c=turnsCommands(ctxFor(f)),wt=join(root,'.claude/worktrees/w1');
  await sh(root,'worktree','add','-q',wt,'feature');
  await writeFile(join(home,'.canopy/sessions/peer.json'),JSON.stringify({session_id:'peer',cwd:wt,updated:Math.floor(now()/1000),state:'working'}));
  // Ended and stale peers never count either.
  await writeFile(join(home,'.canopy/sessions/old.json'),JSON.stringify({session_id:'old',cwd:root,updated:Math.floor(now()/1000)-3*3600,state:'working'}));
  await writeFile(join(home,'.canopy/sessions/done.json'),JSON.stringify({session_id:'done',cwd:root,updated:Math.floor(now()/1000),state:'ended'}));
  assert.deepEqual((await c.turn_list({cwd:root,sessionId:'me'})).peers,[]);
  assert.deepEqual((await c.turn_list({cwd:wt,sessionId:'me'})).peers,['peer']);
 }finally{await cleanup(f);}
});

test('a late start snapshot is flagged from the journal',async()=>{
 const f=await fixture(),{root,home}=f;
 try{
  const c=turnsCommands(ctxFor(f)),observed=now();
  await writeFile(join(home,'.canopy/sessions/late.edits.jsonl'),JSON.stringify({ts:Math.floor(observed/1000),path:'/x',tool:'Edit'})+'\n');
  assert.equal((await snap(c,root,'late','start',{observedMs:observed})).late,true);
  assert.equal((await snap(c,root,'late','start',{observedMs:observed+10000})).late,false);
 }finally{await cleanup(f);}
});

test('retention keeps the newest turns and drops old ones; branches survive',async()=>{
 const f=await fixture(),{root}=f;
 try{
  const c=turnsCommands(ctxFor(f));
  await snap(c,root,'keep','start');
  const commit=(await sh(root,'rev-parse','refs/canopy/turns/keep/1')).trim();
  let script='';for(let n=2;n<=MAX_TURNS+5;n++)script+=`create refs/canopy/turns/keep/${n} ${commit}\n`;
  script+=`create refs/canopy/turn-ends/keep/3 ${commit}\n`;
  const p=execute('git',['update-ref','--stdin'],{cwd:root,env:ENV});p.child.stdin.end(script);await p;
  // The next snapshot prunes: 205 + 1 turns -> starts 1..=6 and end 3 go.
  const out=await snap(c,root,'keep','start');
  assert.equal(out.n,MAX_TURNS+6);
  const l=await c.turn_list({cwd:root,sessionId:'keep'});
  assert.equal(l.turns.length,MAX_TURNS);assert.equal(l.turns[0].n,7);
  assert.ok(!l.turns.some(t=>t.end));
  assert.ok((await sh(root,'for-each-ref','refs/heads')).includes('refs/heads/feature'));
  assert.equal(MAX_AGE_SECS,30*24*3600);
 }finally{await cleanup(f);}
});

test('restore refuses foreign refs and invalid sessions',async()=>{
 const f=await fixture(),{root}=f;
 try{
  const c=turnsCommands(ctxFor(f));
  await assert.rejects(c.turn_restore({cwd:root,sessionId:'s',target:'refs/heads/main',scope:'all'}),/not a snapshot of this session/);
  await assert.rejects(c.turn_restore({cwd:root,sessionId:'s',target:'refs/canopy/turns/other/1',scope:'all'}),/not a snapshot of this session/);
  await assert.rejects(c.turn_restore({cwd:root,sessionId:'s',target:'refs/canopy/turns/s/1',scope:'all'}),/no longer exists \(pruned\?\)/);
  await assert.rejects(c.turn_preview({cwd:root,sessionId:'s',target:'refs/canopy/turns/s/1x',scope:'all'}),/not a snapshot/);
  await assert.rejects(c.turn_snapshot({cwd:root,sessionId:'../evil',kind:'start'}),/invalid session id/);
  await assert.rejects(c.turn_snapshot({cwd:root,sessionId:'s',kind:'middle'}),/unknown snapshot kind middle/);
  await assert.rejects(c.turn_list({cwd:root,sessionId:'a b'}),/invalid session id/);
 }finally{await cleanup(f);}
});

test('native checkpoints pair with the nearest turn in order',()=>{
 const cps=[{uuid:'a',ts_ms:1000},{uuid:'b',ts_ms:30500},{uuid:'c',ts_ms:500000}];
 const p=pairNative([[1,1400],[2,30000],[3,200000]],cps,60000);
 assert.equal(p.get(1),'a');assert.equal(p.get(2),'b');assert.equal(p.has(3),false);
});

test('native checkpoints round-trip through the list',async()=>{
 const f=await fixture(),{root,home}=f;
 try{
  const c=turnsCommands(ctxFor(f));
  await snap(c,root,'nat','start');
  assert.equal(await c.turn_native_checkpoint({sessionId:'nat',uuid:'2748084d-4288-4316-bfb9-6ae8954e3e20'}),null);
  await assert.rejects(c.turn_native_checkpoint({sessionId:'nat',uuid:'not a uuid!'}),/invalid session or checkpoint id/);
  const line=JSON.parse((await readFile(join(home,'.canopy/turns/nat.native.jsonl'),'utf8')).trim());
  assert.deepEqual(Object.keys(line),['uuid','ts_ms']);
  assert.equal((await stat(join(home,'.canopy/turns/nat.native.jsonl'))).mode&0o777,0o600);
  assert.equal((await c.turn_list({cwd:root,sessionId:'nat'})).turns[0].native_uuid,'2748084d-4288-4316-bfb9-6ae8954e3e20');
 }finally{await cleanup(f);}
});

test('the native rewind runs first, and its failure never fails the restore',async()=>{
 const f=await fixture(),{root}=f;
 try{
  const calls=[];let fail=false;
  const c=turnsCommands(ctxFor(f,(bin,argv,options)=>{
   if(bin!=='claude')return null;
   calls.push({argv,env:options.env});
   if(fail)return Promise.reject(fail===true?Object.assign(Error('exit 1'),{code:1,stdout:'',stderr:'File rewinding is not enabled'}):fail);
   // The rewind puts tracked.txt back itself; the snapshot pass does the rest.
   return writeFile(join(root,'tracked.txt'),'v1 unstaged\n').then(()=>({stdout:'Files rewound to state at message x\n',stderr:''}));
  }));
  await snap(c,root,'n','start');
  await write(root,'tracked.txt','agent\n');await write(root,'bash.txt','bash\n');
  const uuid='2748084d-4288-4316-bfb9-6ae8954e3e20';
  const out=await c.turn_restore({cwd:root,sessionId:'n',target:'refs/canopy/turns/n/1',scope:'all',claudeBin:'claude',nativeUuid:uuid});
  assert.deepEqual(out.native,{attempted:true,ok:true,message:'Files rewound to state at message x'});
  assert.deepEqual(calls[0].argv,['-p','--resume','n','--rewind-files',uuid,'--permission-mode','dontAsk']);
  assert.equal(calls[0].env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING,'true');assert.equal(calls[0].env.CANOPY,undefined);
  assert.deepEqual(out.written,[]);assert.deepEqual(out.deleted,['bash.txt']);
  fail=true;await write(root,'tracked.txt','agent again\n');
  const second=await c.turn_restore({cwd:root,sessionId:'n',target:'refs/canopy/turns/n/1',scope:'all',claudeBin:'claude',nativeUuid:uuid});
  assert.deepEqual(second.native,{attempted:true,ok:false,message:'File rewinding is not enabled'});
  assert.equal(await read(root,'tracked.txt'),'v1 unstaged\n');
  // Only a known agent CLI is ever executed.
  const third=await c.turn_restore({cwd:root,sessionId:'n',target:'refs/canopy/turns/n/1',scope:'all',claudeBin:'/bin/sh',nativeUuid:uuid});
  assert.equal(third.native.attempted,false);assert.equal(calls.length,2);
  fail=Object.assign(Error('spawn claude ENOENT'),{code:'ENOENT',stdout:'',stderr:''});
  const fourth=await c.turn_restore({cwd:root,sessionId:'n',target:'refs/canopy/turns/n/1',scope:'all',claudeBin:'claude',nativeUuid:uuid});
  assert.equal(fourth.native.attempted,true);assert.equal(fourth.native.ok,false);assert.match(fourth.native.message,/^could not start claude: spawn claude ENOENT/);
 }finally{await cleanup(f);}
});

test('only the listing is read-only',()=>{assert.deepEqual(TURNS_READ_ONLY,['turn_list']);});
