import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {writeFile,realpath} from 'node:fs/promises';
import {teleportTranscript,teleportGit,transcriptPath} from './teleport-transcript.mjs';

test('path follows Claude encoding and refuses unsafe input',()=>{
 assert.equal(transcriptPath('/h','/work/my app','abc-1'),'/h/.claude/projects/-work-my-app/abc-1.jsonl');
 assert.throws(()=>transcriptPath('/h','/w','../x'));
 assert.throws(()=>transcriptPath('/h','w','ok'));
 assert.throws(()=>transcriptPath('/h','/w\n','ok'));
});

test('write then read round-trips; a different existing file is kept',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'tp-'));
 try{
  const t=teleportTranscript(home);
  assert.equal(await t.read({cwd:'/w',sessionId:'s1'}),null);
  const file=await t.write({cwd:'/w',sessionId:'s1',text:'a\n'});
  assert.equal(await readFile(file,'utf8'),'a\n');
  assert.equal(await t.read({cwd:'/w',sessionId:'s1'}),'a\n');
  assert.equal(await t.write({cwd:'/w',sessionId:'s1',text:'a\n'}),file);
  await assert.rejects(t.write({cwd:'/w',sessionId:'s1',text:'b\n'}),/different version/);
  assert.equal(await t.read({cwd:'/w',sessionId:'s1'}),'a\n');
 }finally{await rm(home,{recursive:true,force:true});}
});

const git=(dir,...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8'}).trim();
async function repo(root,name){
 const dir=path.join(root,name);
 execFileSync('git',['init','-q','-b','main',dir]);
 git(dir,'config','user.email','t@t');git(dir,'config','user.name','t');
 return realpath(dir);
}
const commit=async(dir,file,text)=>{await writeFile(path.join(dir,file),text);git(dir,'add','-A');git(dir,'commit','-q','-m',text);return git(dir,'rev-parse','HEAD');};

test('commits and tracked changes carry fast-forward only; a dirty or diverged destination is refused',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'tpg-'));
 try{
  const g=teleportGit();
  const src=await repo(root,'src'),dst=await repo(root,'dst');
  const base=await commit(src,'a.txt','one');
  git(dst,'fetch','-q',src,'main');git(dst,'reset','-q','--hard','FETCH_HEAD');
  const head=await commit(src,'b.txt','two');
  await writeFile(path.join(src,'a.txt'),'edited');
  assert.equal(await g.relation({path:src,other:base}),'behind');
  assert.equal(await g.relation({path:dst,other:head}),'unknown');
  await assert.rejects(g.relation({path:src,other:'--upload-pack=x'}),/not a commit id/);
  const bundle=await g.bundleCreate({path:src,since:base});
  assert.equal(await g.bundleApply({path:dst,data:bundle}),head);
  assert.equal(await g.relation({path:dst,other:head}),'same');
  const patch=await g.patchCreate({path:src});
  await g.patchApply({path:dst,data:patch});
  assert.equal(await readFile(path.join(dst,'a.txt'),'utf8'),'edited');
  await assert.rejects(g.patchApply({path:dst,data:patch}),/uncommitted changes/);
  // diverged
  const other=await repo(root,'other');
  const b2=await commit(other,'a.txt','one');
  git(src,'checkout','-q','--',  '.');
  await commit(other,'c.txt','theirs');
  git(src,'fetch','-q',other,'main');
  await assert.rejects(g.bundleCreate({path:src,since:git(other,'rev-parse','HEAD')}),/not part of this history/);
  assert.ok(b2);
  await assert.rejects(g.relation({path:path.join(src,'..'),other:base}));
 }finally{await rm(root,{recursive:true,force:true});}
});
