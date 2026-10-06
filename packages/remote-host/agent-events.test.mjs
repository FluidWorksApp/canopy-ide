import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {readAgentEvents} from './agent-events.mjs';
test('independent IDE cursors deliver complete new events without replaying old prompts',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'canopy-events-')),file=dir+'/events';try{
 await writeFile(file,'{"old":true}\n');const initial=await readAgentEvents(file,null);assert.deepEqual(initial.lines,[]);
 await appendFile(file,'{"hook_event_name":"Stop"}\n{"partial":');const a=await readAgentEvents(file,initial.cursor),b=await readAgentEvents(file,initial.cursor);assert.deepEqual(a,b);assert.equal(a.lines.length,1);
 await appendFile(file,'true}\n');const next=await readAgentEvents(file,a.cursor);assert.deepEqual(next.lines,['{"partial":true}']);assert.deepEqual((await readAgentEvents(file,next.cursor)).lines,[]);
 await writeFile(file,'{}\n');assert.deepEqual((await readAgentEvents(file,next.cursor)).lines,['{}']);
 }finally{await rm(dir,{recursive:true,force:true});}});
test('first event after hook installation is delivered to an already listening IDE',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'canopy-first-event-')),file=dir+'/events';try{const before=await readAgentEvents(file,null);await writeFile(file,'{"hook_event_name":"SessionStart"}\n');assert.equal((await readAgentEvents(file,before.cursor)).lines.length,1);}finally{await rm(dir,{recursive:true,force:true});}});
