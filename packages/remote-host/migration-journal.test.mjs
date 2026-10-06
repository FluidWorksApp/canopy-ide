import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMigrationJournal,readMigrationJournal} from './migration-journal.mjs';
test('journal preserves ordered recovery evidence and refuses a duplicate migration',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'canopy-journal-'));
 try{
  const journal=await createMigrationJournal(directory,'owner');
  await Promise.all([journal.append({phase:'prepared',originalContainerId:'original'}),journal.append({phase:'renaming',preservedContainer:'preserved'})]);
  await journal.close();
  const records=(await readFile(journal.path,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(r=>r.sequence),[1,2,3]);
  assert.equal(records[2].preservedContainer,'preserved');
  assert.equal((await stat(journal.path)).mode&0o777,0o600);
  await assert.rejects(createMigrationJournal(directory,'owner'),{code:'EEXIST'});
  await assert.rejects(journal.append({phase:'late'}),/closed/);
  await assert.rejects(createMigrationJournal(directory,'../owner'),/Invalid/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('recovery reads durable records, identifies torn tail, and rejects corrupt records and symlinks',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'canopy-journal-read-'));
 try{
  const path=join(directory,'journal');
  const record=JSON.stringify({workspaceId:'owner',sequence:1,phase:'created'})+'\n';
  await writeFile(path,record+'{"phase":');
  assert.equal((await readMigrationJournal(path)).incompleteTail,true);
  assert.equal((await readMigrationJournal(path)).records.length,1);
  await writeFile(path,record+'broken\n');
  await assert.rejects(readMigrationJournal(path));
  await symlink(path,join(directory,'link'));
  await assert.rejects(readMigrationJournal(join(directory,'link')));
 }finally{await rm(directory,{recursive:true,force:true});}
});
