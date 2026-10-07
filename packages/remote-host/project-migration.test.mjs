import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink,lstat,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {copyProjectComponents,validateMigrationComponents} from './project-migration.mjs';
const component={id:'web',label:'Web',source:'web',relativePath:'web'};
test('migration preserves grouped components and originals and refuses overwrite',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'canopy-migration-'));
 try{
  const sourceRoot=path.join(root,'source'),destinationRoot=path.join(root,'destination');
  await mkdir(sourceRoot);await mkdir(destinationRoot);await mkdir(path.join(sourceRoot,'web'));await mkdir(path.join(sourceRoot,'api'));
  await writeFile(path.join(sourceRoot,'web','file.txt'),'original');await writeFile(path.join(sourceRoot,'api','server.js'),'server');await symlink('file.txt',path.join(sourceRoot,'web','link'));
  const result=await copyProjectComponents({sourceRoot,destinationRoot,components:[component,{id:'api',label:'API',source:'api',relativePath:'services/api'}]});
  assert.deepEqual(result.map(c=>c.relativePath),['content/web','content/services/api']);
  assert.equal(await readFile(path.join(destinationRoot,'content/web/file.txt'),'utf8'),'original');
  assert.equal(await readFile(path.join(sourceRoot,'web/file.txt'),'utf8'),'original');
  assert.equal((await lstat(path.join(destinationRoot,'content/web/link'))).isSymbolicLink(),true);
  assert.deepEqual(await readdir(destinationRoot),['content']);
  await assert.rejects(copyProjectComponents({sourceRoot,destinationRoot,components:[component]}),/not empty/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('migration preflights missing and escaping components without publishing partial data',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'canopy-migration-'));
 try{
  const sourceRoot=path.join(root,'source'),destinationRoot=path.join(root,'destination');await mkdir(sourceRoot);await mkdir(destinationRoot);await symlink(root,path.join(sourceRoot,'escape'));
  for(const source of ['missing','escape'])await assert.rejects(copyProjectComponents({sourceRoot,destinationRoot,components:[{...component,source}]}));
  assert.deepEqual(await readdir(destinationRoot),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('migration rejects traversal and overlapping component destinations',()=>{
 for(const invalid of ['/home/agent','../private','web/../private','web\\private','web//private'])for(const key of ['source','relativePath'])assert.throws(()=>validateMigrationComponents([{...component,[key]:invalid}]));
 for(const relativePath of ['web','web/nested','.'])assert.throws(()=>validateMigrationComponents([component,{...component,id:'two',relativePath}]),/Overlapping/);
});
