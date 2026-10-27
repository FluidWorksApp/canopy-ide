import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,realpath,mkdir,appendFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {safeGitRead,GIT_READ_COMMANDS} from './git-read.mjs';
import {provenanceCommands,checkEdge,PROVENANCE_READ_ONLY,MAX_EDGES} from './provenance.mjs';

const execute=promisify(execFile);
const ENV={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Ada',GIT_AUTHOR_EMAIL:'ada@example.com',GIT_COMMITTER_NAME:'Ada',GIT_COMMITTER_EMAIL:'ada@example.com'};
const sh=(cwd,...args)=>execute('git',args,{cwd,env:ENV}).then(r=>r.stdout.trim());

async function setup(){
 const base=await realpath(await mkdtemp(join(tmpdir(),'provenance-')));
 const repo=join(base,'repo'),home=join(base,'home');
 await mkdir(repo);await mkdir(join(home,'.canopy/sessions'),{recursive:true});
 await sh(repo,'init','-q','-b','main');await writeFile(join(repo,'f'),'x');await sh(repo,'add','-A');await sh(repo,'commit','-qm','init');
 const wt=join(base,'wt');await sh(repo,'worktree','add','-q',wt,'-b','feat/x');
 const gh=[];let ghOut='[]';
 const scoped=async p=>{const r=await realpath(p);if(r!==base&&!r.startsWith(base+'/'))throw Error('Path outside selected workspace');return r;};
 const run=async(bin,argv,cwd=base,timeout=15000,env={})=>{
  if(bin==='gh'){gh.push({argv,cwd,timeout,env});if(ghOut instanceof Error)throw ghOut;return ghOut;}
  const options={allowedRoot:base,cwd:await scoped(cwd),timeout,maxBuffer:1024*1024,env:{...ENV,...env}};
  return (await (bin==='git'&&GIT_READ_COMMANDS.has(argv[0])?safeGitRead(execute,argv,options):execute(bin,argv,options))).stdout;
 };
 const changes=[];
 const ctx={home,root:base,scoped,run,execute,changed:(...a)=>changes.push(a)};
 return {base,repo,wt,home,ctx,gh,changes,setGh:v=>{ghOut=v;},c:provenanceCommands(ctx),done:()=>rm(base,{recursive:true,force:true})};
}
const rec=(t,o={})=>t.c.provenance_record({repo:t.repo,prNumber:42,prUrl:'https://github.com/o/n/pull/42',branch:'feat/x',sessionId:'s1',agent:'claude',profile:'default',cwd:t.wt,via:'pr_watch',...o});
const rows=async t=>(await readFile(join(t.home,'.canopy/provenance.jsonl'),'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l));

test('the same edge learned twice is one row, and the first writer stands',async()=>{
 const t=await setup();
 try{
  assert.equal(await rec(t),true);
  assert.equal(await rec(t,{via:'job_done'}),false);
  const r=await rows(t);assert.equal(r.length,1);assert.equal(r[0].via,'pr_watch');
  // Same line schema and field order as provenance.rs, keyed to the main checkout.
  assert.deepEqual(Object.keys(r[0]),['repo','pr_number','pr_url','branch','session_id','agent','profile','cwd','via','at']);
  assert.equal(r[0].repo,t.repo);
  assert.equal((await stat(join(t.home,'.canopy/provenance.jsonl'))).mode&0o777,0o600);
  assert.deepEqual(t.changes,[['provenance',t.repo,'42']]);
 }finally{await t.done();}
});

test('two sessions on one PR are two rows; reads are newest first with confidence',async()=>{
 const t=await setup();
 try{
  await rec(t,{via:'job_done'});await rec(t,{sessionId:'s2',agent:null,profile:undefined});
  // Recorded from the worktree, read from the main checkout: one repo.
  const edges=await t.c.provenance_for_pr({repo:t.wt,prNumber:42});
  assert.equal(edges.length,2);
  const s1=edges.find(e=>e.session_id==='s1'),s2=edges.find(e=>e.session_id==='s2');
  assert.equal(s1.confidence,'declared');assert.equal(s2.confidence,'observed');
  assert.equal(s2.agent,null);assert.equal(s2.profile,null);
  assert.deepEqual(await t.c.provenance_for_pr({repo:t.repo,prNumber:7}),[]);
  const mine=await t.c.provenance_for_session({sessionId:'s1'});
  assert.equal(mine.length,1);assert.equal(mine[0].pr_number,42);assert.equal(mine[0].via,'job_done');
 }finally{await t.done();}
});

test('newest first is by `at`',async()=>{
 const t=await setup();
 try{
  const old={repo:t.repo,pr_number:1,pr_url:'u',branch:'b',session_id:'old',agent:null,profile:null,cwd:t.repo,via:'backfill',at:100};
  await mkdir(join(t.home,'.canopy'),{recursive:true});
  await writeFile(join(t.home,'.canopy/provenance.jsonl'),JSON.stringify(old)+'\n'+JSON.stringify({...old,session_id:'new',at:200})+'\n');
  assert.deepEqual((await t.c.provenance_for_pr({repo:t.repo,prNumber:1})).map(e=>[e.session_id,e.confidence]),[['new','inferred'],['old','inferred']]);
 }finally{await t.done();}
});

test('a corrupt line costs only itself; another writer\'s rows are picked up',async()=>{
 const t=await setup();
 try{
  await rec(t,{prNumber:1});
  const file=join(t.home,'.canopy/provenance.jsonl');
  await appendFile(file,'{"repo": "/repo", truncated\n');
  await rec(t,{sessionId:'s2',prNumber:2});
  const r=(await readFile(file,'utf8')).split('\n').filter(Boolean);
  assert.equal(r.length,3);assert.equal(JSON.parse(r[2]).session_id,'s2');
  // Somebody else appends behind our back; the same edge offered again is a no-op.
  await appendFile(file,JSON.stringify({...JSON.parse(r[0]),session_id:'s3'})+'\n');
  assert.equal(await rec(t,{sessionId:'s3',prNumber:1}),false);
  assert.equal((await t.c.provenance_for_pr({repo:t.repo,prNumber:1})).length,2);
 }finally{await t.done();}
});

test('compaction keeps the newest MAX_EDGES rows',async()=>{
 const t=await setup();
 try{
  const base={repo:t.repo,pr_url:'u',branch:'b',session_id:'s',agent:null,profile:null,cwd:t.repo,via:'backfill',at:1};
  await mkdir(join(t.home,'.canopy'),{recursive:true});
  await writeFile(join(t.home,'.canopy/provenance.jsonl'),Array.from({length:MAX_EDGES},(_,i)=>JSON.stringify({...base,pr_number:i+1})).join('\n')+'\n');
  assert.equal(await rec(t,{prNumber:999999}),true);
  const r=await rows(t);assert.equal(r.length,MAX_EDGES);assert.equal(r[0].pr_number,2);assert.equal(r.at(-1).pr_number,999999);
 }finally{await t.done();}
});

test('invalid edges are refused with the desktop\'s messages',async()=>{
 const t=await setup();
 try{
  await assert.rejects(rec(t,{sessionId:'../../etc/passwd'}),/invalid session id/);
  await assert.rejects(rec(t,{sessionId:'a/b'}),/invalid session id/);
  await assert.rejects(rec(t,{branch:'  '}),/a branch is required/);
  await assert.rejects(rec(t,{prNumber:0}),/a pull request number is required/);
  await assert.rejects(rec(t,{repo:' '}),/a repo is required/);
  await assert.rejects(rec(t,{via:'guess'}),/unknown variant/);
  await assert.rejects(rec(t,{prNumber:-1}),/invalid pull request number/);
  assert.equal(await rec(t,{sessionId:'019fb713-b047-77c2-98fc-cf008cea0bf0'}),true);
  assert.throws(()=>checkEdge({session_id:'s',pr_number:1,branch:'b',repo:''}),/a repo is required/);
 }finally{await t.done();}
});

test('a path that is not a repo keys to itself',async()=>{
 const t=await setup();
 try{
  await rec(t,{repo:'/nowhere/at/all/'});
  assert.equal((await rows(t))[0].repo,'/nowhere/at/all');
  assert.equal((await t.c.provenance_for_pr({repo:'/nowhere/at/all',prNumber:42})).length,1);
 }finally{await t.done();}
});

async function digests(home,list){
 for(const [session,branch,cwd] of list)await writeFile(join(home,'.canopy/sessions',`${session}.json`),JSON.stringify({session_id:session,branch,cwd,agent:'claude',profile:'default',updated:1700000123}));
}

test('backfill attributes only what it can prove, and a second sweep records nothing',async()=>{
 const t=await setup();
 try{
  const elsewhere=join(t.base,'elsewhere');await mkdir(elsewhere);
  await digests(t.home,[['s-main','feat/a',join(t.repo,'src')],['s-wt','feat/b',t.wt],['s-other','feat/a',elsewhere],['s-idle','feat/unshipped',t.repo],['s-bare','',t.repo],['s-sib','feat/a',t.repo+'-two/src']]);
  await writeFile(join(t.home,'.canopy/sessions/notes.txt'),'ignore me');
  await writeFile(join(t.home,'.canopy/sessions/broken.json'),'{ truncated');
  await writeFile(join(t.home,'.canopy/sessions/s-main.edits.jsonl'),'{}\n');
  const prs=[{number:1,url:'u1',branch:'feat/a'},{number:2,url:'u2',branch:'feat/b'}];
  const report=await t.c.provenance_backfill({repo:t.wt,prs});
  // broken.json fails to parse and is not counted, as in provenance.rs.
  assert.deepEqual(report,{scanned:6,matched:2,recorded:2,unattributable:2});
  assert.equal(t.gh.length,0,'seeds passed in need no network');
  const r=await rows(t);
  assert.deepEqual(r.map(e=>[e.session_id,e.pr_number]).sort(),[['s-main',1],['s-wt',2]]);
  assert.ok(r.every(e=>e.at===1700000123&&e.via==='backfill'&&e.repo===t.repo));
  assert.deepEqual(await t.c.provenance_backfill({repo:t.repo,prs}),{scanned:6,matched:2,recorded:0,unattributable:2});
  assert.equal((await rows(t)).length,2);
 }finally{await t.done();}
});

test('backfill with no seeds asks gh, and a gh failure is an empty report',async()=>{
 const t=await setup();
 try{
  await digests(t.home,[['s-main','feat/a',t.repo]]);
  t.setGh(JSON.stringify([{number:5,url:'https://github.com/o/n/pull/5',headRefName:'feat/a'},{bogus:true}]));
  const report=await t.c.provenance_backfill({repo:t.repo,prs:[]});
  assert.deepEqual(report,{scanned:1,matched:1,recorded:1,unattributable:0});
  assert.deepEqual(t.gh[0].argv,['pr','list','--limit','200','--state','all','--json','number,url,headRefName']);
  assert.equal(t.gh[0].cwd,t.repo);assert.equal(t.gh[0].env.GH_PROMPT_DISABLED,'1');
  assert.equal((await rows(t))[0].pr_url,'https://github.com/o/n/pull/5');
  t.setGh(Error('gh: not logged in'));
  assert.deepEqual(await t.c.provenance_backfill({repo:t.repo,prs:[]}),{scanned:0,matched:0,recorded:0,unattributable:0});
  await assert.rejects(t.c.provenance_backfill({repo:'/etc',prs:[]}),/outside/);
  await assert.rejects(t.c.provenance_backfill({repo:t.repo,prs:[{number:'1',url:'u',branch:'b'}]}),/invalid pull request number/);
 }finally{await t.done();}
});

test('reads are the read-only half',()=>{assert.deepEqual(PROVENANCE_READ_ONLY,['provenance_for_pr','provenance_for_session']);});

test('the workspace PR watcher records new PRs as observed and reports their open and merge times',async()=>{
 const t=await setup();
 try{
  await digests(t.home,[['s-main','feat/a',t.repo],['s-wt','feat/b',t.wt]]);
  await rec(t,{prNumber:2,branch:'feat/b',sessionId:'s-wt',via:'job_done'});
  t.setGh(JSON.stringify([
   {number:1,url:'https://github.com/o/n/pull/1',headRefName:'feat/a',createdAt:'2026-01-01T00:00:00Z',mergedAt:'2026-01-02T06:00:00Z'},
   {number:2,url:'https://github.com/o/n/pull/2',headRefName:'feat/b',createdAt:'2026-01-03T00:00:00Z',mergedAt:null},
  ]));
  const out=await t.c.provenance_observe({repo:t.wt});
  assert.equal(out.repo,t.repo);assert.equal(out.recorded,1,'only the PR with no edge yet is swept');
  assert.deepEqual(out.prs.map(p=>[p.number,p.createdAt,p.mergedAt]),[[1,Date.parse('2026-01-01T00:00:00Z'),Date.parse('2026-01-02T06:00:00Z')],[2,Date.parse('2026-01-03T00:00:00Z'),null]]);
  const r=await rows(t);
  assert.deepEqual(r.map(e=>[e.session_id,e.pr_number,e.via]).sort(),[['s-main',1,'pr_watch'],['s-wt',2,'job_done']]);
  assert.deepEqual(t.gh[0].argv,['pr','list','--limit','200','--state','all','--json','number,url,headRefName,createdAt,mergedAt']);
  assert.equal((await t.c.provenance_observe({repo:t.repo})).recorded,0);
  t.setGh(Error('gh: not logged in'));
  await assert.rejects(t.c.provenance_observe({repo:t.repo}),/GitHub pull requests are unavailable here: gh: not logged in/);
 }finally{await t.done();}
});
