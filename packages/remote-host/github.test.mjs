import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {safeGitRead,GIT_READ_COMMANDS} from './git-read.mjs';
import {githubCommands,GITHUB_READ_ONLY,assemblePatch,stripGhNoise,parseWorktrees} from './github.mjs';

const execute=promisify(execFile);
Object.assign(process.env,{GIT_AUTHOR_NAME:'Ada',GIT_AUTHOR_EMAIL:'ada@example.com',GIT_COMMITTER_NAME:'Ada',GIT_COMMITTER_EMAIL:'ada@example.com'});
const sh=(cwd,...args)=>execute('git',args,{cwd}).then(r=>r.stdout.trim());

// A fake `gh` first on PATH: it logs argv/cwd/stdin and answers from a fixture
// list (argv prefixes; a trailing * matches by prefix). `git` runs real git in
// the cwd, the way `gh pr checkout` does, and fails the way gh reports it.
const FAKE=`#!/usr/bin/env node
const fs=require('fs'),{execFileSync}=require('child_process');
const argv=process.argv.slice(2),stdin=argv.includes('--input')?fs.readFileSync(0,'utf8'):null;
fs.appendFileSync(process.env.FAKE_GH_LOG,JSON.stringify({argv,cwd:process.cwd(),stdin,prompt:process.env.GH_PROMPT_DISABLED??null,home:process.env.HOME})+'\\n');
const hit=JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES,'utf8')).find(f=>f.args.length<=argv.length&&f.args.every((a,i)=>a.endsWith('*')?argv[i].startsWith(a.slice(0,-1)):a===argv[i]));
if(!hit){process.stderr.write('unexpected gh call: '+argv.join(' '));process.exit(99);}
if(hit.git){try{execFileSync('git',hit.git,{stdio:['ignore','ignore','pipe']});}catch(e){process.stderr.write(String(e.stderr)+'failed to run git: exit status 1\\n');process.exit(1);}}
if(hit.stdout)process.stdout.write(hit.stdout);if(hit.stderr)process.stderr.write(hit.stderr);process.exit(hit.code??0);
`;
const base=await realpath(await mkdtemp(join(tmpdir(),'github-')));
const bin=join(base,'bin'),root=join(base,'workspace'),home=join(base,'home');
await mkdir(bin);await mkdir(root);await mkdir(home);
await writeFile(join(bin,'gh'),FAKE);await chmod(join(bin,'gh'),0o755);
const SYSTEM_PATH=process.env.PATH;
process.env.PATH=`${bin}:${SYSTEM_PATH}`;
process.env.FAKE_GH_LOG=join(base,'log.jsonl');process.env.FAKE_GH_FIXTURES=join(base,'fixtures.json');
test.after(()=>rm(base,{recursive:true,force:true}));

// The ctx native.mjs hands its modules, confined to the temp workspace.
const scoped=async value=>{const abs=resolve(String(value));const real=await realpath(abs).catch(()=>abs);if(real!==root&&!real.startsWith(root+'/'))throw Error('Path is outside the workspace');return real;};
const ctx={root,home,execute,scoped,run:async(cmd,argv,cwd=root,timeout=15000,environment={})=>{try{const options={allowedRoot:root,cwd:await scoped(cwd),timeout,maxBuffer:1024*1024,env:{...process.env,HOME:home,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',...environment}};return (await (cmd==='git'&&GIT_READ_COMMANDS.has(argv[0])?safeGitRead(execute,argv,options):execute(cmd,argv,options))).stdout;}catch(error){throw Error(String(error.stderr||'Workspace command failed'));}}};
const gh=githubCommands(ctx);

async function fixtures(list){await writeFile(process.env.FAKE_GH_FIXTURES,JSON.stringify(list));await writeFile(process.env.FAKE_GH_LOG,'');}
const calls=async()=>(await readFile(process.env.FAKE_GH_LOG,'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l));
let repoCount=0;
async function repo(){
 const dir=join(root,`repo${repoCount++}`);await mkdir(dir);
 await sh(dir,'init','-q','-b','main');await writeFile(join(dir,'a.txt'),'one\n');await sh(dir,'add','.');await sh(dir,'commit','-q','-m','First');
 return dir;
}
const NWO={args:['repo','view','--json','nameWithOwner','--jq','.nameWithOwner'],stdout:'acme/widgets\n'};
const SHA='a'.repeat(40);

test('exports a read-only subset of the commands it handles',()=>{
 assert.equal(Object.keys(gh).length,28);
 for(const c of GITHUB_READ_ONLY)assert.ok(gh[c],c);
 for(const c of ['gh_pr_checkout','gh_pr_merge','gh_pr_file_viewed','gh_issue_comment'])assert.ok(!GITHUB_READ_ONLY.includes(c));
});

test('gh_available and gh_auth mirror the desktop shapes',async()=>{
 await fixtures([{args:['--version'],stdout:'gh version 2.60.0\n'},{args:['api','user','--jq','.login'],stdout:'ada\n'},{args:['auth','status'],stderr:'github.com\n  Logged in to github.com account ada (keyring)\n'}]);
 assert.equal(await gh.gh_available(),true);
 assert.deepEqual(await gh.gh_auth(),{installed:true,path:join(bin,'gh'),authenticated:true,account:'ada',host:'github.com',detail:''});
 const log=await calls();
 assert.equal(log.find(c=>c.argv[0]==='api').prompt,'1');assert.equal(log[0].home,home);
 await fixtures([{args:['--version'],stdout:'gh\n'},{args:['api','user'],stderr:'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate GH_TOKEN.\n',code:4},{args:['auth','status'],stderr:'You are not logged into any GitHub hosts.\n',code:1}]);
 assert.deepEqual(await gh.gh_auth(),{installed:true,path:join(bin,'gh'),authenticated:false,account:'',host:'',detail:'To get started with GitHub CLI, please run:  gh auth login'});
 process.env.PATH=join(base,'nothing');
 try{
  assert.equal(await gh.gh_available(),false);
  assert.deepEqual(await gh.gh_auth(),{installed:false,path:'',authenticated:false,account:'',host:'',detail:''});
 }finally{process.env.PATH=`${bin}:${SYSTEM_PATH}`;}
});

test('gh_pr_list asks for the inbox fields from the toplevel and shapes PrInfo',async()=>{
 const dir=await repo();await mkdir(join(dir,'sub'));
 const rows=[{number:7,title:'Fix',author:{login:'ada'},headRefName:'fix',baseRefName:'main',headRefOid:SHA.toUpperCase(),baseRefOid:'abc',isDraft:true,state:'OPEN',url:'u',createdAt:'c',updatedAt:'d',reviewDecision:'APPROVED',additions:3,deletions:1,mergeable:'MERGEABLE',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'},{state:'PENDING'}]},{number:8,author:{login:'bob'},statusCheckRollup:[]}];
 await fixtures([{args:['pr','list'],stdout:JSON.stringify(rows)},{args:['api','user'],stdout:'ada\n'}]);
 const list=await gh.gh_pr_list({repo:join(dir,'sub')});
 assert.deepEqual(list[0],{number:7,title:'Fix',author:'ada',branch:'fix',base:'main',draft:true,state:'OPEN',url:'u',created:'c',updated:'d',review_decision:'APPROVED',additions:3,deletions:1,mine:true,mergeable:'MERGEABLE',checks:'PENDING',checks_summary:'1/2 checks passed',head_sha:SHA,base_sha:''});
 assert.equal(list[1].mine,false);assert.equal(list[1].mergeable,'UNKNOWN');assert.equal(list[1].checks,'');
 const [call]=await calls();
 assert.deepEqual(call.argv,['pr','list','--limit','50','--state','open','--json','number,title,author,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,state,url,createdAt,updatedAt,reviewDecision,additions,deletions,mergeable,statusCheckRollup']);
 assert.equal(call.cwd,dir);
 // `me` failing is "not mine", never an error.
 await fixtures([{args:['pr','list'],stdout:JSON.stringify(rows)},{args:['api','user'],stderr:'HTTP 401',code:1}]);
 assert.equal((await gh.gh_pr_list({repo:dir}))[0].mine,false);
 await assert.rejects(gh.gh_pr_list({repo:base}),/outside the workspace/);
});

test('gh_pr_diff falls back to per-file patches when GitHub refuses the combined diff',async()=>{
 const dir=await repo();
 await fixtures([{args:['pr','diff','3'],stdout:'diff --git a/x b/x\n'}]);
 assert.equal(await gh.gh_pr_diff({repo:dir,number:3}),'diff --git a/x b/x');
 const files=[{filename:'new.txt',status:'added',patch:'@@ -0,0 +1 @@\n+hi\n'},{filename:'b.txt',previous_filename:'a.txt',status:'renamed',patch:'@@ -1 +1 @@\n-a\n+b'},{filename:'img.png',status:'modified',changes:0},{filename:'big.json',status:'modified',changes:9000}];
 await fixtures([{args:['pr','diff'],stderr:'HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)',code:1},NWO,{args:['api','--paginate'],stdout:files.map(f=>JSON.stringify(f)).join('\n')}]);
 const patch=await gh.gh_pr_diff({repo:dir,number:3});
 assert.match(patch,/^diff --git a\/new.txt b\/new.txt\n--- \/dev\/null\n\+\+\+ b\/new.txt\n@@ -0,0 \+1 @@\n\+hi\n/);
 assert.match(patch,/diff --git a\/a.txt b\/b.txt\n--- a\/a.txt\n\+\+\+ b\/b.txt\n/);
 assert.match(patch,/Binary files a\/img.png and b\/img.png differ\ndiff/);
 assert.match(patch,/\(GitHub didn't include this file's patch — 9000 changed lines\. Open it on GitHub\.\)\n$/);
 assert.deepEqual((await calls())[2].argv,['api','--paginate','--jq','.[] | @json','repos/acme/widgets/pulls/3/files?per_page=100']);
 assert.match(assemblePatch(Array.from({length:402},(_,i)=>JSON.stringify({filename:`f${i}`,status:'modified',patch:'@@'})).join('\n')),/\(2 more file\(s\) not shown — this pull request touches more than 400\.\)\n$/);
 await fixtures([{args:['pr','diff'],stderr:'HTTP 404: Not Found',code:1}]);
 await assert.rejects(gh.gh_pr_diff({repo:dir,number:3}),/^Error: HTTP 404: Not Found$/);
});

test('pull request actions send the desktop argv and answer in its words',async()=>{
 const dir=await repo();
 await fixtures([{args:['pr','view','5','--json','body'],stdout:'Body text\n'},{args:['pr','view','5','--json','state'],stdout:'merged\n'},{args:['pr'],stdout:''},{args:['api','user'],stdout:'ada'}]);
 assert.equal(await gh.gh_pr_body({repo:dir,number:5}),'Body text');
 assert.equal(await gh.gh_pr_state({repo:dir,number:5}),'MERGED');
 assert.equal(await gh.gh_pr_review({repo:dir,number:5,action:'approve'}),'Approved #5');
 assert.equal(await gh.gh_pr_review({repo:dir,number:5,action:'request-changes',body:'-rf please'}),'Requested changes on #5');
 await assert.rejects(gh.gh_pr_review({repo:dir,number:5,action:'comment',body:'  '}),/a comment is required for this review action/);
 await assert.rejects(gh.gh_pr_review({repo:dir,number:5,action:'dismiss'}),/unsupported review action: dismiss/);
 assert.deepEqual(await gh.gh_pr_merge({repo:dir,number:5,method:'squash'}),{message:'Squashed and merged #5',pending:false});
 await assert.rejects(gh.gh_pr_merge({repo:dir,number:5,method:'octopus'}),/unsupported merge method: octopus/);
 assert.equal(await gh.gh_pr_close({repo:dir,number:5,deleteBranch:true}),'Closed #5 and deleted its branch');
 assert.equal(await gh.gh_pr_close({repo:dir,number:5}),'Closed #5');
 assert.equal(await gh.gh_pr_ready({repo:dir,number:5}),'#5 is ready for review');
 assert.equal(await gh.gh_pr_update_branch({repo:dir,number:5}),'#5 updated from its base');
 assert.equal(await gh.gh_pr_request_review({repo:dir,number:5,reviewers:['bob','acme/core']}),'Asked bob, acme/core to review #5');
 await assert.rejects(gh.gh_pr_request_review({repo:dir,number:5,reviewers:[]}),/no reviewer to ask/);
 await assert.rejects(gh.gh_pr_request_review({repo:dir,number:5,reviewers:['--repo=x']}),/invalid reviewer/);
 assert.equal(await gh.gh_pr_retarget({repo:dir,number:5,base:' release '}),'Stacked #5 on release');
 await assert.rejects(gh.gh_pr_retarget({repo:dir,number:5,base:'--force'}),/choose a valid base branch/);
 assert.equal(await gh.gh_pr_auto_merge({repo:dir,number:5,method:'rebase',enable:true}),'#5 will merge automatically once its checks and reviews pass');
 assert.equal(await gh.gh_pr_auto_merge({repo:dir,number:5,method:'rebase',enable:false}),'Auto-merge off for #5');
 await assert.rejects(gh.gh_pr_ready({repo:dir,number:-1}),/invalid pull request or issue number/);
 assert.deepEqual((await calls()).map(c=>c.argv),[
  ['pr','view','5','--json','body','--jq','.body'],['pr','view','5','--json','state','--jq','.state'],
  ['pr','review','5','--approve'],['pr','review','5','--request-changes','--body','-rf please'],
  ['pr','merge','5','--squash'],['pr','close','5','--delete-branch'],['pr','close','5'],['pr','ready','5'],['pr','update-branch','5'],
  ['pr','edit','5','--add-reviewer','bob','--add-reviewer','acme/core'],['pr','edit','5','--base','release'],
  ['pr','merge','5','--auto','--rebase'],['pr','merge','5','--disable-auto']]);
});

test('a stacked PR merges through the asynchronous REST endpoint',async()=>{
 const dir=await repo();
 await fixtures([{args:['pr','merge'],stderr:'GraphQL: Pull request is part of a stack; use the asynchronous merge REST API',code:1},NWO,{args:['api','--method','PUT'],stdout:JSON.stringify({status:'enqueued'})}]);
 assert.deepEqual(await gh.gh_pr_merge({repo:dir,number:9,method:'merge'}),{message:'Merge started for #9 — GitHub is processing its PR stack',pending:true});
 assert.deepEqual((await calls())[2].argv,['api','--method','PUT','repos/acme/widgets/pulls/9/merge-async','-f','merge_method=merge','-f','merge_action=default']);
 await fixtures([{args:['pr','merge'],stderr:'part of a stack ... asynchronous merge REST API',code:1},NWO,{args:['api'],stdout:JSON.stringify({status:'failed',details:{message:'Conflicts'}})}]);
 await assert.rejects(gh.gh_pr_merge({repo:dir,number:9,method:'merge'}),/^Error: Conflicts$/);
});

test('the conversation survives GitHub failing to place an outdated thread line',async()=>{
 const dir=await repo();
 const pr={id:'PR_1',body:'B',isDraft:false,mergeable:'MERGEABLE',reviewDecision:'',state:'OPEN',headRefOid:'h2',autoMergeRequest:{enabledAt:'x'},
  comments:{nodes:[{id:'C1',author:{login:'bob'},body:'hi',createdAt:'t',url:'u',viewerDidAuthor:false,authorAssociation:'MEMBER'}]},
  reviews:{nodes:[{id:'R1',author:{login:'ada'},state:'COMMENTED',submittedAt:'2026-01-01',viewerDidAuthor:true,commit:{oid:'h0'}},{id:'R2',author:{login:'ada'},state:'APPROVED',submittedAt:'2026-02-01',viewerDidAuthor:true,commit:{oid:'h1'}},{id:'R3',state:'PENDING',submittedAt:'2026-03-01',viewerDidAuthor:true,commit:{oid:'h2'}}]},
  reviewThreads:{nodes:[{id:'T1',isResolved:true,isOutdated:true,path:'a.txt',line:null,startLine:null,diffSide:'RIGHT',comments:{nodes:[]}}]},
  files:{nodes:[{path:'a.txt',viewerViewedState:'VIEWED',additions:1,deletions:2}]},commits:{nodes:[{commit:{statusCheckRollup:{state:'FAILURE'}}}]}};
 const response={data:{viewer:{login:'ada'},repository:{pullRequest:pr}},errors:[{path:['repository','pullRequest','reviewThreads','nodes',0,'line'],message:'Line could not be resolved'}]};
 await fixtures([NWO,{args:['api','graphql'],stdout:JSON.stringify(response),stderr:'gh: Line could not be resolved',code:1}]);
 const c=await gh.gh_pr_conversation({repo:dir,number:7});
 assert.deepEqual(Object.keys(c),['node_id','body','head_sha','viewer','review_decision','mergeable','state','checks','auto_merge','draft','comments','reviews','threads','files','my_last_review_sha']);
 assert.equal(c.checks,'FAIL');assert.equal(c.auto_merge,true);assert.equal(c.my_last_review_sha,'h1');
 assert.deepEqual(c.threads[0],{id:'T1',path:'a.txt',line:0,start_line:0,side:'RIGHT',resolved:true,outdated:true,comments:[]});
 assert.deepEqual(c.comments[0],{id:'C1',author:'bob',body:'hi',created:'t',url:'u',mine:false,association:'MEMBER'});
 assert.deepEqual(c.files,[{path:'a.txt',viewed:true,additions:1,deletions:2}]);
 const argv=(await calls())[1].argv;
 assert.deepEqual([argv.slice(0,3),argv[3].startsWith('query=\nquery($owner:String!'),argv.slice(4)],[['api','graphql','-f'],true,['-f','owner=acme','-f','name=widgets','-F','number=7']]);
 await fixtures([NWO,{args:['api','graphql'],stdout:JSON.stringify({errors:[{message:'Bad credentials'},{message:'Again'}]}),code:1}]);
 await assert.rejects(gh.gh_pr_conversation({repo:dir,number:7}),/^Error: Bad credentials; Again$/);
 await fixtures([NWO,{args:['api','graphql'],stdout:JSON.stringify({data:{viewer:{login:'ada'},repository:{pullRequest:null}}})}]);
 await assert.rejects(gh.gh_pr_conversation({repo:dir,number:7}),/#7 not found on this repository/);
});

test('links go as JSON on stdin and are grouped once each',async()=>{
 const dir=await repo();
 const issue={number:12,title:'Bug',url:'https://x/12',state:'OPEN',repository:{nameWithOwner:'acme/widgets'}};
 const data={repository:{pullRequest:{closingIssuesReferences:{nodes:[issue]},timelineItems:{nodes:[{source:{__typename:'Issue',...issue}},{source:{__typename:'PullRequest',number:7,url:'https://x/7',repository:{nameWithOwner:'acme/widgets'}}},{source:{__typename:'PullRequest',number:3,title:'Other',url:'https://y/3',state:'MERGED',isDraft:false,repository:{nameWithOwner:'acme/other'}}},{source:{}}]}},children:{nodes:[{number:8,title:'On top',url:'https://x/8',state:'OPEN',isDraft:true,baseRefName:'42'}]},parents:{nodes:[]}}};
 await fixtures([NWO,{args:['api','graphql','--input','-'],stdout:JSON.stringify({data})}]);
 const links=await gh.gh_pr_links({repo:dir,number:7,head:'42',base:'main'});
 assert.deepEqual(links.closes,[{kind:'issue',number:12,title:'Bug',url:'https://x/12',state:'OPEN',draft:false,repo:'',base:''}]);
 assert.deepEqual(links.children.map(l=>[l.number,l.draft,l.base]),[[8,true,'42']]);
 assert.deepEqual(links.mentions.map(l=>[l.kind,l.number,l.repo]),[['pr',3,'acme/other']]);
 const body=JSON.parse((await calls())[1].stdin);
 assert.deepEqual(body.variables,{owner:'acme',name:'widgets',number:7,head:'42',base:'main'});assert.match(body.query,/children: pullRequests/);
});

test('thread, file and batch-review mutations',async()=>{
 const dir=await repo();
 await fixtures([{args:['api','graphql'],stdout:JSON.stringify({data:{}})}]);
 assert.equal(await gh.gh_pr_thread_reply({repo:dir,threadId:'PRRT_1',body:'@alice done'}),'Replied');
 await assert.rejects(gh.gh_pr_thread_reply({repo:dir,threadId:'PRRT_1',body:' '}),/a reply needs a body/);
 assert.equal(await gh.gh_pr_thread_resolved({repo:dir,threadId:'PRRT_1',resolved:true}),'Resolved');
 assert.equal(await gh.gh_pr_thread_resolved({repo:dir,threadId:'PRRT_1',resolved:false}),'Reopened');
 assert.equal(await gh.gh_pr_file_viewed({repo:dir,prId:'PR_1',path:'src/a.ts',viewed:true}),null);
 assert.equal(await gh.gh_pr_review_batch({repo:dir,prId:'PR_1',event:'request-changes',body:'',threads:[{path:'a.ts',line:9,start_line:4,side:'RIGHT',body:'x'},{path:'b.ts',line:2,start_line:5,side:'LEFT',body:'y'}]}),'Requested changes with 2 inline comments');
 assert.equal(await gh.gh_pr_review_batch({repo:dir,prId:'PR_1',event:'approve',threads:[]}),'Approved');
 await assert.rejects(gh.gh_pr_review_batch({repo:dir,prId:'PR_1',event:'comment',body:'',threads:[]}),/a comment is required/);
 const log=await calls();
 // String variables go raw (-f): an "@alice" reply is text, not a file to read.
 assert.deepEqual(log[0].argv.slice(4),['-f','t=PRRT_1','-f','b=@alice done']);
 assert.match(log[0].argv[3],/^query=mutation\(\$t:ID!,\$b:String!\)\{addPullRequestReviewThreadReply/);
 assert.match(log[1].argv[3],/resolveReviewThread/);assert.match(log[2].argv[3],/unresolveReviewThread/);
 assert.deepEqual(log[3].argv.slice(4),['-f','p=PR_1','-f','f=src/a.ts']);assert.match(log[3].argv[3],/markFileAsViewed/);
 const batch=JSON.parse(log[4].stdin);
 assert.deepEqual(log[4].argv,['api','graphql','--input','-']);
 assert.deepEqual(batch.variables,{p:'PR_1',e:'REQUEST_CHANGES',b:'',t:[{path:'a.ts',line:9,side:'RIGHT',startLine:4,startSide:'RIGHT',body:'x'},{path:'b.ts',line:2,side:'LEFT',body:'y'}]});
});

test('reviewer candidates, failing logs and the since-diff',async()=>{
 const dir=await repo();
 await fixtures([NWO,{args:['api','--paginate'],stdout:'ada\nbob\n'}]);
 assert.deepEqual(await gh.gh_pr_reviewer_candidates({repo:dir}),['ada','bob']);
 assert.deepEqual((await calls())[1].argv,['api','--paginate','--jq','.[].login','repos/acme/widgets/collaborators?per_page=100']);
 await fixtures([NWO,{args:['api'],stderr:'HTTP 403',code:1}]);
 assert.deepEqual(await gh.gh_pr_reviewer_candidates({repo:dir}),[]);
 const checks=[{name:'ok',state:'SUCCESS',link:'l'},{name:'test',state:'FAILURE',link:'https://github.com/acme/widgets/actions/runs/123/job/9'},{name:'ext',state:'ERROR',link:'https://ci.example/x'}];
 await fixtures([{args:['pr','checks','4','--json','name,state,link'],stdout:JSON.stringify(checks)},{args:['run','view','123','--log-failed'],stdout:Array.from({length:130},(_,i)=>`line ${i}`).join('\n')}]);
 const report=await gh.gh_pr_failing_logs({repo:dir,number:4});
 assert.ok(report.startsWith('=== test (https://github.com/acme/widgets/actions/runs/123/job/9)\nline 10\n'));
 assert.ok(report.endsWith("line 129\n\n=== ext (https://ci.example/x)\n(no run id in this check's link — open it on GitHub)\n\n"));
 await fixtures([{args:['pr','checks'],stdout:'[]'}]);
 assert.equal(await gh.gh_pr_failing_logs({repo:dir,number:4}),'');
 await fixtures([NWO,{args:['api','-H'],stdout:'diff --git a/a b/a\n'}]);
 assert.equal(await gh.gh_pr_diff_since({repo:dir,baseSha:'abc1234',headSha:'def5678'}),'diff --git a/a b/a');
 assert.deepEqual((await calls())[1].argv,['api','-H','Accept: application/vnd.github.v3.diff','repos/acme/widgets/compare/abc1234...def5678']);
 await assert.rejects(gh.gh_pr_diff_since({repo:dir,baseSha:'',headSha:'x'}),/need two commits to compare/);
 await assert.rejects(gh.gh_pr_diff_since({repo:dir,baseSha:'../../user',headSha:'x'}),/invalid commit id/);
});

test('issues list, detail, state and comment',async()=>{
 const dir=await repo();
 const rows=[{number:42,title:'Crash',state:'OPEN',url:'u',assignees:[{login:'bob'},{login:'ada'}],updatedAt:'t',body:'b',labels:[{name:'bug'},{name:'P1-high'}]},{number:43,state:'CLOSED',assignees:[],labels:[]}];
 await fixtures([{args:['issue','list'],stdout:JSON.stringify(rows)},{args:['api','user'],stdout:'ada'},{args:['issue','view'],stdout:JSON.stringify({author:{login:'bob'},createdAt:'c',updatedAt:'u',state:'CLOSED',comments:[{id:'IC_1',author:null,body:'x',createdAt:'t',url:'cu'}]})},{args:['issue'],stdout:''}]);
 const list=await gh.gh_issue_list({repo:dir});
 assert.deepEqual(list[0],{id:'#42',title:'Crash',state:'open',state_type:'open',assignee:'bob',mine:true,url:'u',branch:null,body:'b',priority:'P1-high',updated_at:'t'});
 assert.deepEqual([list[1].assignee,list[1].mine,list[1].state,list[1].priority],[null,false,'closed','']);
 assert.deepEqual(await gh.gh_issue_detail({repo:dir,number:42}),{internal_id:'',author:'bob',created_at:'c',updated_at:'u',state:'closed',state_id:'',states:[],comments:[{id:'IC_1',author:'ghost',body:'x',created_at:'t',url:'cu'}]});
 assert.equal(await gh.gh_issue_set_state({repo:dir,number:42,open:false}),null);
 assert.equal(await gh.gh_issue_set_state({repo:dir,number:42,open:true}),null);
 assert.equal(await gh.gh_issue_comment({repo:dir,number:42,body:'  thanks  '}),null);
 await assert.rejects(gh.gh_issue_comment({repo:dir,number:42,body:'  '}),/comment cannot be empty/);
 assert.deepEqual((await calls()).map(c=>c.argv),[
  ['issue','list','--state','all','--limit','80','--json','number,title,state,url,assignees,updatedAt,body,labels'],['api','user','--jq','.login'],
  ['issue','view','42','--json','author,createdAt,updatedAt,state,comments'],['issue','close','42'],['issue','reopen','42'],['issue','comment','42','--body','thanks']]);
});

// ---------- checkout, over real repositories ----------
async function prRepo(){
 const dir=await repo();
 await sh(dir,'switch','-q','-c','feature');await writeFile(join(dir,'a.txt'),'feature\n');await sh(dir,'commit','-qam','Feature');await sh(dir,'switch','-q','main');
 return dir;
}
const VIEW={args:['pr','view','6','--json','headRefName,isCrossRepository'],stdout:JSON.stringify({headRefName:'feature',isCrossRepository:false})};
const CHECKOUT={args:['pr','checkout','6'],git:['checkout','feature']};

test('gh_pr_checkout switches, and carries changes across',async()=>{
 const dir=await prRepo();
 await fixtures([VIEW,CHECKOUT]);
 assert.deepEqual(await gh.gh_pr_checkout({repo:dir,number:6,carry:false}),{kind:'switched',message:"Checked out #6 — you're on feature",path:null});
 assert.equal(await sh(dir,'branch','--show-current'),'feature');
 await sh(dir,'switch','-q','main');await writeFile(join(dir,'note.txt'),'mine\n');
 assert.deepEqual(await gh.gh_pr_checkout({repo:dir,number:6,carry:true}),{kind:'switched',message:"Checked out #6 — you're on feature, with your changes",path:null});
 assert.equal(await readFile(join(dir,'note.txt'),'utf8'),'mine\n');
 // A detached HEAD's own commits are reported, not silently left behind.
 await rm(join(dir,'note.txt'));await sh(dir,'switch','-q','--detach','main');await writeFile(join(dir,'b.txt'),'x');await sh(dir,'add','.');await sh(dir,'commit','-qm','Stray');
 const out=await gh.gh_pr_checkout({repo:dir,number:6,carry:false});
 assert.equal(out.kind,'switched_with_leftovers');assert.match(out.commits[0],/^[0-9a-f]+ Stray$/);assert.match(out.detail,/^git branch saved-[0-9a-f]+ [0-9a-f]+ — /);
});

test('gh_pr_checkout refuses the way a branch switch does',async()=>{
 const dir=await prRepo();
 await writeFile(join(dir,'a.txt'),'edited\n');
 await fixtures([VIEW,CHECKOUT]);
 const changes=await gh.gh_pr_checkout({repo:dir,number:6,carry:false});
 assert.equal(changes.kind,'local_changes');assert.deepEqual(changes.files,['a.txt']);assert.equal(changes.untracked,false);assert.doesNotMatch(changes.detail,/failed to run git/);
 await sh(dir,'checkout','--','a.txt');
 const other=join(root,`wt${repoCount++}`);await sh(dir,'worktree','add','-q',other,'feature');
 const held=await gh.gh_pr_checkout({repo:dir,number:6,carry:false});
 assert.deepEqual(Object.keys(held.holder),['branch','path','name','agent','is_main','dirty','locked','prunable','head']);
 assert.deepEqual([held.kind,held.holder.path,held.holder.is_main,held.holder.locked],['branch_in_worktree',other,false,null]);
 await sh(dir,'worktree','remove',other);
 await writeFile(join(dir,'.git','MERGE_HEAD'),SHA+'\n');
 assert.deepEqual(await gh.gh_pr_checkout({repo:dir,number:6,carry:false}),{kind:'repo_busy',operation:'merge',detail:'git merge --quit — the merge state is cleared; the working tree is untouched.'});
 await rm(join(dir,'.git','MERGE_HEAD'));
 await fixtures([{args:['pr','view'],stderr:'To get started with GitHub CLI, please run:  gh auth login\n',code:4}]);
 assert.deepEqual(await gh.gh_pr_checkout({repo:dir,number:6,carry:false}),{kind:'remote_unreachable',summary:"Canopy couldn't reach GitHub with the sign-in it has.",detail:'To get started with GitHub CLI, please run:  gh auth login'});
 await fixtures([{args:['pr','view'],stdout:'{}'}]);
 assert.deepEqual(await gh.gh_pr_checkout({repo:dir,number:6,carry:false}),{kind:'remote_unreachable',summary:"GitHub didn't say which branch #6 comes from.",detail:'gh pr view --json headRefName returned no head branch.'});
 await fixtures([VIEW,{args:['pr','checkout'],stderr:"fatal: couldn't find remote ref pull/6/head\nfailed to run git: exit status 128\n",code:1}]);
 assert.deepEqual(await gh.gh_pr_checkout({repo:dir,number:6,carry:false}),{kind:'remote_unreachable',summary:"GitHub doesn't have a copy of those changes to fetch. A private fork you can't read is the usual reason.",detail:"fatal: couldn't find remote ref pull/6/head"});
 assert.equal(await sh(dir,'branch','--show-current'),'main');
});

test('helpers match git.rs on the edges',()=>{
 assert.equal(stripGhNoise('error: x\nfailed to run git: exit status 1\n\n'),'error: x');
 const [main,linked]=parseWorktrees('worktree /w/repo\nHEAD 0123456789abcdef\nbranch refs/heads/main\n\nworktree /w/repo/.claude/worktrees/a\nHEAD fedcba9876543210\ndetached\nlocked\n');
 assert.deepEqual([main.is_main,main.head,main.branch,linked.name,linked.detached,linked.locked,linked.branch],[true,'01234567','main','a',true,'locked',null]);
});
