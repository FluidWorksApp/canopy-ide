import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,appendFile,rm,readlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {linkSharedCanopyState,accountHomes} from './account-homes.mjs';

test('a shared-account session writes its hook output where the host reads it, and keeps its own plan usage',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'account-homes-'));
 try{
  const account=path.join(home,'.canopy','accounts','a1');
  await mkdir(path.join(account,'.canopy','sessions'),{recursive:true});
  await writeFile(path.join(account,'.canopy','sessions','stale.json'),'{}');
  await linkSharedCanopyState(account,home);
  await appendFile(path.join(account,'.canopy','agent-events.jsonl'),'{"hook_event_name":"Stop"}\n');
  await writeFile(path.join(account,'.canopy','sessions','s1.json'),'{"session_id":"s1"}');
  await writeFile(path.join(account,'.canopy','plan-usage'),'mine');
  assert.equal(await readFile(path.join(home,'.canopy','agent-events.jsonl'),'utf8'),'{"hook_event_name":"Stop"}\n');
  assert.equal(await readFile(path.join(home,'.canopy','sessions','s1.json'),'utf8'),'{"session_id":"s1"}');
  await assert.rejects(readFile(path.join(home,'.canopy','sessions','stale.json')),'the template\'s own copy is replaced, not merged');
  await assert.rejects(readFile(path.join(home,'.canopy','plan-usage')));
  assert.equal(await readlink(path.join(account,'.canopy','policy')),path.join(home,'.canopy','policy'));
  assert.deepEqual(await accountHomes(home),[account]);
 }finally{await rm(home,{recursive:true,force:true});}
});
