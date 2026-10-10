import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('workflow accepts static and static PIE service binaries and rejects dynamic linking',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/workspace-image.yml',import.meta.url),'utf8');
 const guard=workflow.split('\n').find(line=>line.trim().startsWith('file "service-bin/'));
 assert.ok(guard,'Missing static service release check');
 const command=guard.trim().replace(/"service-bin\/[^"]+"/,'"$1"');
 const directory=mkdtempSync(join(tmpdir(),'canopy-service-linking-'));
 try{
  const source=join(directory,'main.c');writeFileSync(source,'int main(void) { return 0; }\n');
  for(const [name,flags,accepted] of [['static',['-static'],true],['static-pie',['-static-pie'],true],['dynamic',[],false]]){
   const binary=join(directory,name);execFileSync('cc',[source,...flags,'-o',binary]);
   const result=spawnSync('sh',['-c',command,'service-linking-test',binary],{encoding:'utf8'});
   assert.equal(result.status===0,accepted,`${name}: ${result.stderr}`);
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});
