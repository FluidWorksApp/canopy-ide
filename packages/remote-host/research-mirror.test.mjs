import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {researchMirrorCommands} from './research-mirror.mjs';

test('a research entry gets a directory in the VM, and its prose is listed for the IDE to copy in',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'research-mirror-'));
 try{
  const c=researchMirrorCommands({home});
  assert.deepEqual(await c.research_entry_files({id:'0001-a'}),[]);
  const dir=await c.research_entry_dir({id:'0001-a'});
  assert.equal(dir,path.join(home,'.canopy','research','0001-a'));
  await writeFile(path.join(dir,'progress.txt'),'orient');
  await writeFile(path.join(dir,'findings.md'),'# Found');
  await writeFile(path.join(dir,'empty.md'),'');
  await writeFile(path.join(dir,'image.png'),'x');
  const files=await c.research_entry_files({id:'0001-a'});
  assert.deepEqual(files.map(f=>[f.name,f.text]),[['findings.md','# Found']]);
  await assert.rejects(c.research_entry_dir({id:'../../etc'}),/not a research id/);
 }finally{await rm(home,{recursive:true,force:true});}
});
