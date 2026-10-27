import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {compactArgv,compactOutcome,sessionCompactCommand} from './session-compact.mjs';

const L=v=>JSON.stringify(v);
const BOUNDARY=L({type:'system',subtype:'compact_boundary',compact_metadata:{trigger:'manual',pre_tokens:23221,post_tokens:7305}});
const RESULT=L({type:'result',subtype:'success',result:'',modelUsage:{'model-x':{contextWindow:1000000}}});

test('the verified argv: resume, read-only, the command last after --',()=>{
 const argv=compactArgv('claude','sess-1','keep\nthe schema');
 assert.deepEqual(argv.slice(0,7),['-p','--output-format','stream-json','--verbose','--strict-mcp-config','--resume','sess-1']);
 assert.ok(argv.includes('plan'));assert.equal(argv.at(-2),'--');assert.equal(argv.at(-1),'/compact keep the schema');
 assert.equal(compactArgv('claude','s','').at(-1),'/compact');
 assert.equal(compactArgv('codex','s',''),null);
});

test('the outcome is the CLI\'s own record, not the exit code',()=>{
 assert.deepEqual(compactOutcome([BOUNDARY,RESULT]),{ok:true,preTokens:23221,postTokens:7305,contextWindows:{'model-x':1000000}});
 assert.equal(compactOutcome([RESULT]).ok,false);
 assert.equal(compactOutcome([L({type:'result',subtype:'error_during_execution',is_error:true,result:'No conversation found'})]).message,'No conversation found');
 assert.match(compactOutcome([]).message,/exited before compacting/);
});

function fakeRun(lines,seen){
 return (cmd,argv,opts)=>{
  seen.push({cmd,argv,opts});
  const child=new EventEmitter();child.pid=999999;child.stdout=new PassThrough();child.stderr=new PassThrough();
  setImmediate(()=>{for(const l of lines)child.stdout.write(l+'\n');child.stdout.end();child.emit('close',0);});
  return child;
 };
}

test('runs in the session\'s workspace folder, as its account, without Canopy\'s hooks',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-compact-')));
 const before=process.env.CANOPY_CTX_TOKEN;process.env.CANOPY_CTX_TOKEN='x';
 try{
  const seen=[];
  const compact=sessionCompactCommand({home,scoped:async p=>{if(!p.startsWith(home))throw Error('outside');return p;},profileEnv:async(agent,id)=>id==='work'?[['CLAUDE_CONFIG_DIR',home+'/.canopy/profiles/work/.claude'],['CANOPY_PROFILE','work']]:[],run:fakeRun([BOUNDARY,RESULT],seen)});
  const r=await compact({agent:'claude',sessionId:'sess-1',cwd:home,instructions:'keep it',profile:'work'});
  assert.equal(r.ok,true);assert.equal(r.postTokens,7305);
  assert.equal(seen[0].cmd,'claude');assert.equal(seen[0].opts.cwd,home);assert.equal(seen[0].argv.at(-1),'/compact keep it');
  assert.equal(seen[0].opts.env.CLAUDE_CONFIG_DIR,home+'/.canopy/profiles/work/.claude');
  assert.equal(seen[0].opts.env.CANOPY_CTX_TOKEN,undefined);assert.equal(seen[0].opts.env.CANOPY_PROFILE,undefined);
  assert.equal(seen[0].opts.env.HOME,home);
  // Outside the workspace, a bad id, or a CLI without compaction: refused, nothing run.
  assert.equal((await compact({agent:'claude',sessionId:'s',cwd:'/etc'})).ok,false);
  await assert.rejects(compact({agent:'claude',sessionId:'../x',cwd:home}));
  assert.equal((await compact({agent:'codex',sessionId:'s',cwd:home})).ok,false);
  assert.equal(seen.length,1);
 }finally{if(before===undefined)delete process.env.CANOPY_CTX_TOKEN;else process.env.CANOPY_CTX_TOKEN=before;await rm(home,{recursive:true,force:true});}
});
