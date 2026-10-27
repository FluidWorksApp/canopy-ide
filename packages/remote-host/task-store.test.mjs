import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {rm,mkdtemp as makeTemp,realpath,readdir,readFile,writeFile,symlink,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {taskStoreCommands,taskStoreFor,TASK_STORE_READ_ONLY} from './task-store.mjs';

const temps=[];const mkdtemp=async prefix=>{const dir=await makeTemp(prefix);temps.push(dir);return dir;};
after(()=>Promise.all(temps.map(dir=>rm(dir,{recursive:true,force:true}))));

const route=(cli='claude')=>({cli,profileId:'default',harnessVersion:'h1',promptVersion:'p1',toolPolicyVersion:'t1',executionMode:'structured',selection:{eligible:[cli]}});
const input=(extra={})=>({kind:'agent',projectId:'proj',componentId:'comp',worktreePath:'/workspace/proj',goal:'Fix the bug',acceptance:['tests pass'],route:route(),...extra});
// Each test gets its own home, so the per-home store cache never leaks between cases.
async function setup(){
 const home=await realpath(await mkdtemp(join(tmpdir(),'task-store-')));
 const pulses=[],released=[];
 const ctx={home,root:'/workspace',pulse:(...p)=>pulses.push(p),releaseClaimsForAttempt:async id=>released.push(id)};
 return {home,ctx,pulses,released,cmd:taskStoreCommands(ctx)};
}

test('read-only list names only reading commands that exist',async()=>{
 const {cmd}=await setup();
 for(const name of TASK_STORE_READ_ONLY)assert.ok(cmd[name],name);
 assert.equal(Object.keys(cmd).length,20);
 assert.ok(!TASK_STORE_READ_ONLY.includes('task_attempt_wait'));
});

test('reserve -> start -> wait -> settle lifecycle with pulses',async()=>{
 const {cmd,pulses,released,home}=await setup();
 const {envelope,attempt}=await cmd.task_reserve({input:input({title:'Bug',metadata:{history:true}})});
 assert.match(envelope.runId,/^run_[0-9a-f]{32}$/);assert.match(attempt.attemptId,/^attempt_[0-9a-f]{32}$/);
 assert.deepEqual({status:envelope.status,attemptCount:envelope.attemptCount,title:envelope.title,metadata:envelope.metadata},{status:'running',attemptCount:1,title:'Bug',metadata:{history:true}});
 assert.equal(attempt.state,'reserved');assert.equal(attempt.ordinal,1);assert.equal(attempt.startedAt,null);
 assert.equal(attempt.route.cliVersion,null);assert.deepEqual(attempt.route.selection,{eligible:['claude']});
 assert.deepEqual(pulses.at(-1),['tasks','proj',envelope.runId]);
 const started=await cmd.task_attempt_start({attemptId:attempt.attemptId});
 assert.equal(started.state,'running');assert.ok(started.startedAt);
 await assert.rejects(cmd.task_attempt_start({attemptId:attempt.attemptId}),/cannot start an attempt in state running/);
 const waiting=await cmd.task_attempt_wait({attemptId:attempt.attemptId});
 assert.equal(waiting.state,'waiting');
 assert.equal((await cmd.task_get({runId:envelope.runId})).envelope.status,'blocked');
 await assert.rejects(cmd.task_attempt_wait({attemptId:attempt.attemptId}),/only the current running attempt can wait/);
 await assert.rejects(cmd.task_delete({runId:envelope.runId}),/a live task cannot be removed from history/);
 const done=await cmd.task_attempt_settle({input:{attemptId:attempt.attemptId,state:'completed'}});
 assert.equal(done.state,'completed');assert.ok(done.endedAt);assert.deepEqual(released,[attempt.attemptId]);
 const detail=await cmd.task_get({runId:envelope.runId});
 assert.equal(detail.envelope.status,'completed');assert.equal(detail.envelope.goal,'Fix the bug');assert.equal(detail.envelope.riskClass,'unknown');
 assert.equal(detail.envelope.attemptCap,3);assert.equal(detail.envelope.schemaVersion,1);assert.equal(detail.envelope.contextSummary,'');
 assert.equal(detail.envelope.taskClasses,null);assert.equal(detail.envelope.baseBaselineId,null);assert.ok(!('settledAt' in detail.envelope));
 assert.deepEqual((await cmd.task_get_for_attempt({attemptId:attempt.attemptId})).envelope.runId,envelope.runId);
 assert.equal(await cmd.task_get_for_attempt({attemptId:'attempt_missing'}),null);
 assert.equal(await cmd.task_get({runId:'run_missing'}),null);
 // Terminal settlement is idempotently accepted; a different terminal state is not.
 assert.equal((await cmd.task_attempt_settle({input:{attemptId:attempt.attemptId,state:'completed'}})).state,'completed');
 await assert.rejects(cmd.task_attempt_settle({input:{attemptId:attempt.attemptId,state:'failed'}}),/attempt is already completed/);
 await assert.rejects(cmd.task_attempt_settle({input:{attemptId:attempt.attemptId,state:'running'}}),/attempt settlement state is not terminal/);
 await assert.rejects(cmd.task_attempt_reserve({input:{runId:envelope.runId,route:route()}}),/task is already completed/);
 // Persisted under the home store with private modes.
 const runDir=join(home,'.canopy/tasks/runs',envelope.runId);
 assert.equal((await stat(join(runDir,'envelope.json'))).mode&0o777,0o600);
 assert.equal((await stat(join(home,'.canopy/tasks/runs'))).mode&0o777,0o700);
});

test('attempt cap, active attempt and recovery parent are enforced',async()=>{
 const {cmd}=await setup();
 const {envelope,attempt}=await cmd.task_reserve({input:input({attemptCap:2})});
 await assert.rejects(cmd.task_attempt_reserve({input:{runId:envelope.runId,route:route()}}),/task already has an active attempt/);
 await cmd.task_attempt_start({attemptId:attempt.attemptId});
 await cmd.task_attempt_settle({input:{attemptId:attempt.attemptId,state:'failed',failureClass:'route',failureCode:'x'}});
 let detail=await cmd.task_get({runId:envelope.runId});
 assert.equal(detail.envelope.status,'ready');assert.equal(detail.attempts[0].failureClass,'route');
 const other=await cmd.task_reserve({input:input()});
 await assert.rejects(cmd.task_attempt_reserve({input:{runId:envelope.runId,route:route(),recoveryFromAttemptId:other.attempt.attemptId}}),/recovery attempt does not belong to this task/);
 const second=await cmd.task_attempt_reserve({input:{runId:envelope.runId,route:route('codex'),recoveryFromAttemptId:attempt.attemptId}});
 assert.equal(second.ordinal,2);assert.equal(second.recoveryFromAttemptId,attempt.attemptId);assert.equal(second.route.cli,'codex');
 // The first attempt is stale now.
 await assert.rejects(cmd.task_attempt_start({attemptId:attempt.attemptId}),/cannot start an attempt in state failed/);
 await cmd.task_attempt_start({attemptId:second.attemptId});
 await cmd.task_attempt_settle({input:{attemptId:second.attemptId,state:'interrupted'}});
 detail=await cmd.task_get({runId:envelope.runId});
 assert.equal(detail.envelope.status,'failed');assert.equal(detail.envelope.attemptCount,2);
 assert.deepEqual(detail.attempts.map(a=>a.ordinal),[1,2]);
 await assert.rejects(cmd.task_attempt_reserve({input:{runId:envelope.runId,route:route()}}),/task attempt cap \(2\) reached/);
 await assert.rejects(cmd.task_attempt_reserve({input:{runId:'run_nope',route:route()}}),/task envelope not found/);
});

test('a waiting attempt can later complete and a blocked task can retry',async()=>{
 const {cmd}=await setup();
 const {envelope,attempt}=await cmd.task_reserve({input:input()});
 await cmd.task_attempt_start({attemptId:attempt.attemptId});
 await cmd.task_attempt_wait({attemptId:attempt.attemptId});
 assert.equal((await cmd.task_attempt_settle({input:{attemptId:attempt.attemptId,state:'blocked'}})).state,'blocked');
 assert.equal((await cmd.task_get({runId:envelope.runId})).envelope.status,'blocked');
 const retry=await cmd.task_attempt_reserve({input:{runId:envelope.runId,route:route()}});
 await cmd.task_attempt_start({attemptId:retry.attemptId});
 await cmd.task_attempt_settle({input:{attemptId:retry.attemptId,state:'cancelled'}});
 assert.equal((await cmd.task_get({runId:envelope.runId})).envelope.status,'cancelled');
});

test('spawn binding claims only the current reserved attempt',async()=>{
 const {ctx,cmd}=await setup();
 const store=taskStoreFor(ctx);
 const {envelope,attempt}=await cmd.task_reserve({input:input()});
 assert.equal(await store.spawnBinding(null,null),null);
 await assert.rejects(store.spawnBinding(envelope.runId,null),/a task spawn needs both runId and attemptId/);
 const binding=await store.spawnBinding(envelope.runId,attempt.attemptId);
 assert.equal((await cmd.task_get({runId:envelope.runId})).attempts[0].state,'launching');
 await assert.rejects(store.spawnBinding(envelope.runId,attempt.attemptId),/task attempt is not the current reserved attempt/);
 assert.equal(await store.claimAttemptActive(attempt.attemptId),true);
 await store.markLaunchFailed(binding);
 const detail=await cmd.task_get({runId:envelope.runId});
 assert.deepEqual([detail.attempts[0].state,detail.attempts[0].failureCode],['failed','process-launch']);
 assert.equal(await store.claimAttemptActive(attempt.attemptId),false);
});

test('metadata, stale sweep, history list, delete and clear history',async()=>{
 const {cmd,home}=await setup();
 const mine=await cmd.task_reserve({input:input({metadata:{history:true,appInstance:'now'}})});
 const old=await cmd.task_reserve({input:input({metadata:{history:1,appInstance:'before'}})});
 const oldWaiting=await cmd.task_reserve({input:input({metadata:{history:true}})});
 const notHistory=await cmd.task_reserve({input:input({metadata:{appInstance:'before'}})});
 await cmd.task_attempt_start({attemptId:oldWaiting.attempt.attemptId});
 await cmd.task_attempt_wait({attemptId:oldWaiting.attempt.attemptId});
 assert.equal(await cmd.task_interrupt_stale({currentInstance:'now'}),2);
 let d=await cmd.task_get({runId:old.envelope.runId});
 assert.deepEqual([d.attempts[0].state,d.attempts[0].failureClass,d.attempts[0].failureCode,d.envelope.status],['interrupted','route','previous-app-ended','ready']);
 d=await cmd.task_get({runId:oldWaiting.envelope.runId});
 assert.deepEqual([d.attempts[0].state,d.attempts[0].failureClass,d.envelope.status],['blocked','human_required','blocked']);
 assert.equal((await cmd.task_get({runId:mine.envelope.runId})).attempts[0].state,'reserved');
 assert.equal((await cmd.task_get({runId:notHistory.envelope.runId})).attempts[0].state,'reserved');
 await assert.rejects(cmd.task_interrupt_stale({currentInstance:'  '}),/app instance is required/);
 // history lists only metadata.history true/1, newest first.
 const updated=await cmd.task_update_metadata({runId:notHistory.envelope.runId,metadata:{history:true,label:'x'}});
 assert.deepEqual(updated.metadata,{history:true,label:'x'});
 const history=await cmd.task_list_history({limit:200});
 assert.equal(history.length,4);assert.equal(history[0].runId,notHistory.envelope.runId);
 assert.equal((await cmd.task_list_history({limit:1})).length,1);
 assert.equal((await cmd.task_list({projectId:'proj'})).length,4);
 assert.equal((await cmd.task_list({projectId:'other'})).length,0);
 assert.equal((await cmd.task_list_all({})).length,4);
 await assert.rejects(cmd.task_update_metadata({runId:'run_nope',metadata:{}}),/task envelope not found/);
 await assert.rejects(cmd.task_update_metadata({runId:mine.envelope.runId,metadata:'x'.repeat(70000)}),/task metadata exceeds 65536 bytes/);
 await assert.rejects(cmd.task_update_metadata({runId:mine.envelope.runId}),/missing required key metadata/);
 // Ready (old) is removable; blocked/running are live. clear_history removes only finished history rows.
 await cmd.task_artifact_write({runId:old.envelope.runId,kind:'log',content:'abc'});
 assert.equal(await cmd.task_clear_history(),1);
 assert.equal(await cmd.task_get({runId:old.envelope.runId}),null);
 assert.ok(!(await readdir(join(home,'.canopy/tasks/runs'))).includes(old.envelope.runId));
 await assert.rejects(cmd.task_delete({runId:old.envelope.runId}),/task envelope not found/);
 await assert.rejects(cmd.task_delete({runId:'../x'}),/invalid run id/);
 await cmd.task_attempt_settle({input:{attemptId:mine.attempt.attemptId,state:'cancelled'}});
 assert.equal(await cmd.task_delete({runId:mine.envelope.runId}),null);
 assert.equal(await cmd.task_get_for_attempt({attemptId:mine.attempt.attemptId}),null);
});

test('transcript and events are task scoped, bounded and windowed newest-last',async()=>{
 const {cmd}=await setup();
 const {envelope,attempt}=await cmd.task_reserve({input:input()});
 const other=await cmd.task_reserve({input:input()});
 const before=(await cmd.task_get({runId:envelope.runId})).envelope.updatedAt;
 for(let i=1;i<=5;i++){const e=await cmd.task_transcript_append({runId:envelope.runId,attemptId:i%2?attempt.attemptId:null,kind:'assistant',body:`m${i}`});assert.equal(e.seq,i);}
 assert.ok((await cmd.task_get({runId:envelope.runId})).envelope.updatedAt>=before);
 const window=await cmd.task_transcript_list({runId:envelope.runId,limit:2});
 assert.deepEqual(window.map(e=>[e.seq,e.body]),[[4,'m4'],[5,'m5']]);
 assert.equal(window[0].attemptId,null);assert.equal(window[1].attemptId,attempt.attemptId);
 assert.equal((await cmd.task_transcript_list({runId:envelope.runId})).length,5);
 assert.deepEqual(await cmd.task_transcript_list({runId:'run_unknown'}),[]);
 await assert.rejects(cmd.task_transcript_append({runId:envelope.runId,kind:'robot',body:'x'}),/unknown transcript entry kind/);
 await assert.rejects(cmd.task_transcript_append({runId:envelope.runId,attemptId:other.attempt.attemptId,kind:'user',body:'x'}),/transcript attempt does not belong to this task/);
 await assert.rejects(cmd.task_transcript_append({runId:envelope.runId,kind:'user',body:'x'.repeat(16*1024+1)}),/transcript entry exceeds 16384 bytes/);
 await assert.rejects(cmd.task_transcript_append({runId:'run_nope',kind:'user',body:''}),/task envelope not found/);
 for(let i=0;i<3;i++)await cmd.task_event_append({input:{runId:envelope.runId,attemptId:attempt.attemptId,kind:'watchdog',source:'host',metadata:{i},occurredAt:1000-i}});
 const ev=await cmd.task_event_append({input:{runId:envelope.runId,kind:'verdict',source:'host',code:'ok'}});
 assert.match(ev.eventId,/^event_[0-9a-f]{32}$/);assert.equal(ev.attemptId,null);assert.equal(ev.metadata,null);assert.ok(ev.occurredAt>1000);
 // Insertion order, not occurredAt.
 assert.deepEqual((await cmd.task_event_list({runId:envelope.runId,limit:3})).map(e=>e.metadata?.i??e.kind),[1,2,'verdict']);
 await assert.rejects(cmd.task_event_append({input:{runId:envelope.runId,attemptId:other.attempt.attemptId,kind:'k',source:'s'}}),/event attempt does not belong to this task/);
 await assert.rejects(cmd.task_event_append({input:{runId:envelope.runId,kind:'k',source:'s',metadata:{x:'y'.repeat(16*1024)}}}),/event metadata exceeds 16384 bytes/);
 await assert.rejects(cmd.task_event_append({input:{runId:envelope.runId,kind:' ',source:'s'}}),/event kind is required/);
 await assert.rejects(cmd.task_event_append({input:{runId:envelope.runId,kind:'k',source:'s',occurredAt:1.5}}),/invalid args `input`/);
});

test('transcript entry cap and event caps',async()=>{
 const {cmd,home}=await setup();
 const {envelope,attempt}=await cmd.task_reserve({input:input()});
 // Seed the ledgers on disk to the cap, then reopen through a fresh home cache.
 const dir=join(home,'.canopy/tasks/runs',envelope.runId);
 await writeFile(join(dir,'transcript.jsonl'),Array.from({length:2000},(_,i)=>JSON.stringify({seq:i+1,runId:envelope.runId,attemptId:null,kind:'user',body:'b',createdAt:1})+'\n').join(''));
 await writeFile(join(dir,'events.jsonl'),Array.from({length:1000},(_,i)=>JSON.stringify({eventId:'e'+i,runId:envelope.runId,attemptId:attempt.attemptId,kind:'k',source:'s',metadata:null,occurredAt:1})+'\n').join('')+'{"torn');
 await assert.rejects(cmd.task_transcript_append({runId:envelope.runId,kind:'user',body:'x'}),/task transcript entry cap reached/);
 await assert.rejects(cmd.task_event_append({input:{runId:envelope.runId,attemptId:attempt.attemptId,kind:'k',source:'s'}}),/task attempt event cap reached/);
 await cmd.task_event_append({input:{runId:envelope.runId,kind:'k',source:'s'}});
 assert.equal((await cmd.task_transcript_list({runId:envelope.runId,limit:5000})).length,2000);
 assert.equal((await cmd.task_event_list({runId:envelope.runId,limit:5000})).length,1001);
});

test('artifacts are scoped, capped, reconciled and never follow symlinks',async()=>{
 const {cmd,home,ctx}=await setup();
 const {envelope,attempt}=await cmd.task_reserve({input:input()});
 const other=await cmd.task_reserve({input:input()});
 const a=await cmd.task_artifact_write({runId:envelope.runId,attemptId:attempt.attemptId,kind:'stdout',content:'héllo'});
 assert.match(a.id,/^artifact_[0-9a-f]{32}$/);assert.equal(a.bytes,6);assert.equal(a.attemptId,attempt.attemptId);
 assert.equal(await cmd.task_artifact_read({id:a.id}),'héllo');
 const env=await cmd.task_artifact_write({runId:envelope.runId,kind:'summary',content:''});
 assert.equal(env.attemptId,null);assert.equal(await cmd.task_artifact_read({id:env.id}),'');
 await assert.rejects(cmd.task_artifact_read({id:'artifact_missing'}),/task artifact not found/);
 await assert.rejects(cmd.task_artifact_read({id:'../../etc/passwd'}),/invalid artifact id/);
 await assert.rejects(cmd.task_artifact_write({runId:envelope.runId,attemptId:other.attempt.attemptId,kind:'k',content:'x'}),/artifact attempt does not belong to this task/);
 await assert.rejects(cmd.task_artifact_write({runId:envelope.runId,kind:'k',content:'x'.repeat(2*1024*1024+1)}),/artifact exceeds 2097152 bytes/);
 await assert.rejects(cmd.task_artifact_write({runId:envelope.runId,kind:'',content:'x'}),/artifact kind is required/);
 for(let i=0;i<31;i++)await cmd.task_artifact_write({runId:envelope.runId,attemptId:attempt.attemptId,kind:'k',content:'x'});
 await assert.rejects(cmd.task_artifact_write({runId:envelope.runId,attemptId:attempt.attemptId,kind:'k',content:'x'}),/task attempt artifact cap reached/);
 for(let i=0;i<67;i++)await cmd.task_artifact_write({runId:envelope.runId,kind:'k',content:'x'});
 await assert.rejects(cmd.task_artifact_write({runId:envelope.runId,kind:'k',content:'x'}),/task envelope artifact count cap reached/);
 // A symlinked leaf directory is refused without touching its target.
 const outside=await realpath(await mkdtemp(join(tmpdir(),'task-outside-')));
 const fresh=await cmd.task_reserve({input:input()});
 await mkdir(join(home,'.canopy/tasks/runs',fresh.envelope.runId,'artifacts'),{recursive:true});
 await symlink(outside,join(home,'.canopy/tasks/runs',fresh.envelope.runId,'artifacts','envelope'));
 await assert.rejects(cmd.task_artifact_write({runId:fresh.envelope.runId,kind:'k',content:'x'}),/artifact directory may not be a symlink/);
 assert.deepEqual(await readdir(outside),[]);
 // Reconcile on open: a row whose file vanished is dropped, an orphan file is removed.
 const runDir=join(home,'.canopy/tasks/runs',envelope.runId);
 const {unlink}=await import('node:fs/promises');
 await unlink(join(runDir,'artifacts',attempt.attemptId,a.id));
 await writeFile(join(runDir,'artifacts','envelope','orphan'),'x');
 const reopenedHome=await copyHome(home),reopened=taskStoreCommands({...ctx,home:reopenedHome});
 await assert.rejects(reopened.task_artifact_read({id:a.id}),/task artifact not found/);
 assert.equal(await reopened.task_artifact_read({id:env.id}),'');
 assert.ok(!(await readdir(join(reopenedHome,'.canopy/tasks/runs',envelope.runId,'artifacts','envelope'))).includes('orphan'));
 assert.ok(!(await readdir(join(reopenedHome,'.canopy/tasks/runs',fresh.envelope.runId,'artifacts'))).includes('envelope'));
 async function copyHome(src){const {cp}=await import('node:fs/promises');const dst=await realpath(await mkdtemp(join(tmpdir(),'task-reopen-')));await cp(join(src,'.canopy'),join(dst,'.canopy'),{recursive:true,verbatimSymlinks:true});return dst;}
});

test('state survives a reopen of the same home',async()=>{
 const {cmd,home}=await setup();
 const {envelope,attempt}=await cmd.task_reserve({input:input({metadata:{history:true}})});
 await cmd.task_attempt_start({attemptId:attempt.attemptId});
 await cmd.task_transcript_append({runId:envelope.runId,kind:'user',body:'hi'});
 const {cp}=await import('node:fs/promises');
 const copy=await realpath(await mkdtemp(join(tmpdir(),'task-reopen-')));
 await cp(join(home,'.canopy'),join(copy,'.canopy'),{recursive:true});
 const again=taskStoreCommands({home:copy});
 const d=await again.task_get_for_attempt({attemptId:attempt.attemptId});
 assert.equal(d.attempts[0].state,'running');
 const next=await again.task_transcript_append({runId:envelope.runId,kind:'assistant',body:'yo'});
 assert.equal(next.seq,2);
 assert.equal(JSON.parse(await readFile(join(copy,'.canopy/tasks/runs',envelope.runId,'envelope.json'),'utf8')).envelope.runId,envelope.runId);
});

test('concurrent calls serialize without losing writes',async()=>{
 const {cmd}=await setup();
 const {envelope}=await cmd.task_reserve({input:input()});
 const entries=await Promise.all(Array.from({length:40},(_,i)=>cmd.task_transcript_append({runId:envelope.runId,kind:'activity',body:String(i)})));
 assert.deepEqual(entries.map(e=>e.seq).sort((a,b)=>a-b),Array.from({length:40},(_,i)=>i+1));
 const reservations=await Promise.all(Array.from({length:10},()=>cmd.task_reserve({input:input()})));
 assert.equal(new Set(reservations.map(r=>r.envelope.runId)).size,10);
 assert.equal((await cmd.task_list_all({limit:500})).length,11);
});

test('rejects oversized, malformed and path-like inputs',async()=>{
 const {cmd,pulses}=await setup();
 const reject=(extra,pattern)=>assert.rejects(cmd.task_reserve({input:input(extra)}),pattern);
 await reject({goal:' '},/goal is required/);
 await reject({goal:'x'.repeat(16*1024+1)},/goal exceeds 16384 bytes/);
 await reject({kind:'k'.repeat(65)},/task kind exceeds 64 bytes/);
 await reject({attemptCap:9},/attempt cap must be between 1 and 8/);
 await reject({attemptCap:0},/attempt cap must be between 1 and 8/);
 await reject({acceptance:Array(33).fill('a')},/acceptance criteria exceed 32 items/);
 await reject({acceptance:['']},/acceptance criterion is required/);
 await reject({title:'t'.repeat(257)},/title exceeds 256 bytes/);
 await reject({authorityPolicy:{x:'y'.repeat(16*1024)}},/authority policy exceeds 16384 bytes/);
 await reject({metadata:{x:'y'.repeat(64*1024)}},/task metadata exceeds 65536 bytes/);
 await reject({route:{...route(),executionMode:'shell'}},/route execution mode must be structured, oneshot, or pty/);
 await reject({route:{...route(),requestedModel:'m'.repeat(513)}},/requested model exceeds 512 bytes/);
 await reject({route:{...route(),cli:''}},/route cli is required/);
 await reject({goal:42},/invalid args `input` for command `task_reserve`/);
 await reject({riskClass:null},/invalid args `input`/);
 await assert.rejects(cmd.task_reserve({input:{...input(),route:undefined}}),/missing field `route`/);
 await assert.rejects(cmd.task_reserve({}),/invalid args `input`/);
 await assert.rejects(cmd.task_attempt_start({attemptId:'a/b'}),/invalid attempt id/);
 await assert.rejects(cmd.task_attempt_start({attemptId:'x'.repeat(97)}),/invalid attempt id/);
 await assert.rejects(cmd.task_attempt_start({attemptId:'attempt_none'}),/task attempt not found/);
 await assert.rejects(cmd.task_attempt_settle({input:{attemptId:'attempt_none',state:'failed',failureClass:'c'.repeat(129)}}),/failure class exceeds 128 bytes/);
 await assert.rejects(cmd.task_get({runId:'run id'}),/invalid run id/);
 await assert.rejects(cmd.task_list({projectId:''}),/project id is required/);
 await assert.rejects(cmd.task_list({projectId:'p',limit:-1}),/invalid args `limit`/);
 assert.deepEqual(pulses,[]);
 // Reads never pulse.
 await cmd.task_list_all({});await cmd.task_list_history({});
 assert.deepEqual(pulses,[]);
});
