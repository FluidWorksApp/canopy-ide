import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {receiptRunCheck,capture} from './receipt-check.mjs';

const dir=await mkdtemp(path.join(tmpdir(),'receipt-'));
const scoped=async value=>{if(!value.startsWith(dir))throw Error('Path outside selected workspace');return value;};

test('a failing check returns its exit code and output, not an error',async()=>{
 const r=await receiptRunCheck({cwd:dir,argv:['/bin/sh','-c','echo out; echo err >&2; exit 3']},{scoped});
 assert.equal(r.code,3);assert.equal(r.stdout.trim(),'out');assert.equal(r.stderr.trim(),'err');
 assert.equal(r.timedOut,false);assert.equal(r.spawnError,null);
});

test('a hung check is timed out, not failed, and its process group is killed',async()=>{
 const r=await receiptRunCheck({cwd:dir,argv:['/bin/sh','-c','sleep 30 & wait'],timeoutMs:300},{scoped});
 assert.equal(r.timedOut,true);assert.equal(r.code,null);assert.ok(r.durationMs<10000);
});

test('the check env is scrubbed of CANOPY* and forced non-interactive',async()=>{
 const r=await receiptRunCheck({cwd:dir,argv:['/bin/sh','-c','echo "$CANOPY_PTY|$CI"']},{scoped,env:{...process.env,CANOPY_PTY:'7'}});
 assert.equal(r.stdout.trim(),'|1');
});

test('a missing program is a spawn error',async()=>{
 const r=await receiptRunCheck({cwd:dir,argv:['/definitely/not/here']},{scoped});
 assert.match(r.spawnError,/could not start/);assert.equal(r.code,null);
});

test('cwd outside the workspace and bad argv are refused',async()=>{
 await assert.rejects(receiptRunCheck({cwd:'/etc',argv:['true']},{scoped}),/outside/);
 await assert.rejects(receiptRunCheck({cwd:dir,argv:[]},{scoped}),/Invalid check command/);
 await assert.rejects(receiptRunCheck({cwd:dir,argv:[1]},{scoped}),/Invalid check command/);
});

test('capture keeps the tail by default and the head on request',()=>{
 const t=capture(4,true);t.push(Buffer.from('abcdef'));t.push(Buffer.from('ghij'));
 assert.deepEqual(t.done(),{text:'ghij',truncated:true});
 const h=capture(4,false);h.push(Buffer.from('abcdef'));h.push(Buffer.from('gh'));
 assert.deepEqual(h.done(),{text:'abcd',truncated:true});
});

test('isolate exports the working tree under the git dir, links dependencies, and release removes only the copy',async()=>{
 const {execFileSync}=await import('node:child_process');
 const {mkdir,readFile,writeFile,stat}=await import('node:fs/promises');
 const repo=path.join(dir,'repo');await mkdir(repo,{recursive:true});
 const git=(...a)=>execFileSync('git',['-C',repo,'-c','user.name=T','-c','user.email=t@t','-c','commit.gpgSign=false',...a]).toString().trim();
 git('init','-q');await writeFile(path.join(repo,'.gitignore'),'node_modules/\n');await writeFile(path.join(repo,'a.txt'),'committed\n');git('add','-A');git('commit','-q','-m','init');
 const head=git('rev-parse','HEAD');
 await writeFile(path.join(repo,'a.txt'),'edited\n');await writeFile(path.join(repo,'new.txt'),'untracked\n');
 await mkdir(path.join(repo,'node_modules/dep'),{recursive:true});await writeFile(path.join(repo,'node_modules/dep/index.js'),'x');
 const {receiptIsolate,receiptRelease}=await import('./receipt-check.mjs');
 const copy=await receiptIsolate({cwd:repo},{scoped});
 assert.ok(copy.dir.startsWith(path.join(repo,'.git','canopy-receipts')));
 assert.equal(await readFile(path.join(copy.dir,'a.txt'),'utf8'),'edited\n');
 assert.equal(await readFile(path.join(copy.dir,'new.txt'),'utf8'),'untracked\n');
 assert.deepEqual(copy.linked,['node_modules']);
 assert.equal(await readFile(path.join(copy.dir,'node_modules/dep/index.js'),'utf8'),'x');
 assert.doesNotMatch(git('status','--porcelain'),/canopy-receipts/);
 const atHead=await receiptIsolate({cwd:repo,rev:head},{scoped});
 assert.equal(await readFile(path.join(atHead.dir,'a.txt'),'utf8'),'committed\n');
 await assert.rejects(receiptIsolate({cwd:repo,rev:'--output=x'},{scoped}),/snapshot id/);
 await assert.rejects(receiptRelease({dir:repo},{scoped}),/not a receipt copy/);
 await receiptRelease({dir:copy.dir},{scoped});await receiptRelease({dir:atHead.dir},{scoped});
 await assert.rejects(stat(copy.dir));
 assert.equal(await readFile(path.join(repo,'node_modules/dep/index.js'),'utf8'),'x');
});

test('a check gets the env the isolated copy asks for, never a CANOPY key',async()=>{
 const r=await receiptRunCheck({cwd:dir,argv:['/bin/sh','-c','echo "$CARGO_TARGET_DIR|$CANOPY_X"'],env:[['CARGO_TARGET_DIR','/t'],['CANOPY_X','1']]},{scoped});
 assert.equal(r.stdout.trim(),'/t|');
});
