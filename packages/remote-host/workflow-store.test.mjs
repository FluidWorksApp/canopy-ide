import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {rm,mkdtemp as makeTemp,realpath,cp,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workflowStoreCommands,WORKFLOW_STORE_READ_ONLY} from './workflow-store.mjs';

const temps=[];const mkdtemp=async prefix=>{const dir=await makeTemp(prefix);temps.push(dir);return dir;};
after(()=>Promise.all(temps.map(dir=>rm(dir,{recursive:true,force:true}))));

const create=(extra={})=>({projectId:'proj',definitionId:'review-loop',definitionVersion:'1',definitionHash:'sha256:abc',definition:{id:'review-loop',steps:[]},triggerKind:'manual',trigger:{kind:'manual',by:'me'},startStepId:'build',steps:[{id:'build',kind:'agent'},{id:'gate',kind:'verify'}],...extra});
async function setup(){
 const home=await realpath(await mkdtemp(join(tmpdir(),'workflow-store-')));
 const pulses=[];
 return {home,pulses,cmd:workflowStoreCommands({home,pulse:(...p)=>pulses.push(p)})};
}
// A host restart is a fresh process: a copy of the home gets a fresh store cache.
async function restart(home){const copy=await realpath(await mkdtemp(join(tmpdir(),'workflow-restart-')));await cp(join(home,'.canopy'),join(copy,'.canopy'),{recursive:true});return {home:copy,cmd:workflowStoreCommands({home:copy})};}

test('read-only list names reading commands only',async()=>{
 const {cmd}=await setup();
 assert.deepEqual(Object.keys(cmd).sort(),['workflow_run_advance','workflow_run_create','workflow_run_get','workflow_run_list','workflow_run_resume','workflow_step_record']);
 for(const name of WORKFLOW_STORE_READ_ONLY)assert.ok(cmd[name]);
});

test('create -> record -> advance -> loop -> complete',async()=>{
 const {cmd,pulses,home}=await setup();
 const run=await cmd.workflow_run_create({input:create()});
 assert.match(run.runId,/^workflow_[0-9a-f]{32}$/);
 assert.deepEqual([run.status,run.currentStepId,run.triggerKind,run.definitionHash],['running','build','manual','sha256:abc']);
 assert.deepEqual(run.steps.map(s=>[s.id,s.state,s.round,s.attemptIds]),[['build','running',0,[]],['gate','pending',0,[]]]);
 assert.deepEqual(run.trigger,{kind:'manual',by:'me'});assert.deepEqual(run.edges,[]);
 assert.deepEqual(pulses.at(-1),['workflows','proj',run.runId]);
 assert.equal((await stat(join(home,'.canopy/workflows',run.runId+'.json'))).mode&0o777,0o600);
 let d=await cmd.workflow_step_record({input:{runId:run.runId,stepId:'build',state:'running',attemptId:'attempt_1'}});
 assert.deepEqual(d.steps[0].attemptIds,['attempt_1']);
 d=await cmd.workflow_step_record({input:{runId:run.runId,stepId:'build',state:'waiting',attemptId:'attempt_2'}});
 assert.deepEqual([d.status,d.steps[0].state,d.steps[0].attemptIds],['waiting','waiting',['attempt_1','attempt_2']]);
 // Each attempt may be referenced once across the whole store.
 const other=await cmd.workflow_run_create({input:create()});
 await assert.rejects(cmd.workflow_step_record({input:{runId:other.runId,stepId:'build',state:'running',attemptId:'attempt_1'}}),/UNIQUE constraint failed: workflow_step_attempts.attempt_id/);
 await assert.rejects(cmd.workflow_step_record({input:{runId:run.runId,stepId:'gate',state:'running'}}),/workflow step is not the current active step/);
 d=await cmd.workflow_run_advance({input:{runId:run.runId,stepId:'build',stepState:'completed',outcome:'success',target:'gate'}});
 assert.deepEqual([d.status,d.currentStepId,d.steps[0].state,d.steps[1].state,d.steps[1].round],['running','gate','completed','running',1]);
 assert.deepEqual(d.edges.map(e=>[e.seq,e.fromStepId,e.outcome,e.target]),[[1,'build','success','gate']]);
 d=await cmd.workflow_run_advance({input:{runId:run.runId,stepId:'gate',stepState:'failed',outcome:'changes-requested',target:'build'}});
 assert.deepEqual([d.currentStepId,d.steps[0].state,d.steps[0].round,d.steps[1].state],['build','running',1,'failed']);
 d=await cmd.workflow_run_advance({input:{runId:run.runId,stepId:'build',stepState:'completed',outcome:'success',target:'$completed'}});
 assert.deepEqual([d.status,d.currentStepId,d.edges.length],['completed',null,3]);
 await assert.rejects(cmd.workflow_run_advance({input:{runId:run.runId,stepId:'build',stepState:'completed',outcome:'x',target:'gate'}}),/workflow step is not the current active step/);
 await assert.rejects(cmd.workflow_run_resume({runId:run.runId}),/only an interrupted workflow can resume/);
 assert.deepEqual(await cmd.workflow_run_get({runId:run.runId}),d);
 assert.equal(await cmd.workflow_run_get({runId:'workflow_missing'}),null);
 const listed=await cmd.workflow_run_list({projectId:'proj'});
 assert.equal(listed.length,2);assert.ok(!('definition' in listed[0]));
 assert.equal((await cmd.workflow_run_list({projectId:'proj',limit:1})).length,1);
 assert.deepEqual(await cmd.workflow_run_list({projectId:'nope'}),[]);
});

test('terminal targets map to run status',async()=>{
 const {cmd}=await setup();
 for(const [target,status] of [['$failed','failed'],['$cancelled','cancelled']]){
  const run=await cmd.workflow_run_create({input:create()});
  const d=await cmd.workflow_run_advance({input:{runId:run.runId,stepId:'build',stepState:'failed',outcome:'boom',target}});
  assert.equal(d.status,status);assert.equal(d.currentStepId,null);
 }
});

test('a restart interrupts running runs, which resume explicitly',async()=>{
 const {cmd,home}=await setup();
 const running=await cmd.workflow_run_create({input:create()});
 await cmd.workflow_step_record({input:{runId:running.runId,stepId:'build',state:'running',attemptId:'attempt_reserved'}});
 const waiting=await cmd.workflow_run_create({input:create()});
 await cmd.workflow_step_record({input:{runId:waiting.runId,stepId:'build',state:'waiting'}});
 const after=await restart(home);
 const restored=await after.cmd.workflow_run_get({runId:running.runId});
 assert.deepEqual([restored.status,restored.steps[0].state,restored.steps[0].attemptIds,restored.definitionVersion,restored.trigger.kind],['interrupted','interrupted',['attempt_reserved'],'1','manual']);
 assert.equal((await after.cmd.workflow_run_get({runId:waiting.runId})).status,'waiting');
 await assert.rejects(after.cmd.workflow_run_advance({input:{runId:running.runId,stepId:'build',stepState:'completed',outcome:'ok',target:'gate'}}),/workflow step is not the current active step/);
 // Attempt references survive the restart too.
 await assert.rejects(after.cmd.workflow_step_record({input:{runId:waiting.runId,stepId:'build',state:'running',attemptId:'attempt_reserved'}}),/UNIQUE constraint failed/);
 const resumed=await after.cmd.workflow_run_resume({runId:running.runId});
 assert.deepEqual([resumed.status,resumed.steps[0].state],['running','running']);
 await assert.rejects(after.cmd.workflow_run_resume({runId:'workflow_none'}),/workflow run not found/);
 const done=await after.cmd.workflow_run_advance({input:{runId:running.runId,stepId:'build',stepState:'completed',outcome:'ok',target:'$completed'}});
 assert.equal(done.status,'completed');
 assert.ok((await readdir(join(after.home,'.canopy/workflows'))).every(name=>name.endsWith('.json')));
});

test('concurrent records serialize',async()=>{
 const {cmd}=await setup();
 const run=await cmd.workflow_run_create({input:create()});
 await Promise.all(Array.from({length:20},(_,i)=>cmd.workflow_step_record({input:{runId:run.runId,stepId:'build',state:'running',attemptId:'attempt_'+i}})));
 assert.equal((await cmd.workflow_run_get({runId:run.runId})).steps[0].attemptIds.length,20);
});

test('validation mirrors workflow.rs',async()=>{
 const {cmd,pulses}=await setup();
 const reject=(extra,pattern)=>assert.rejects(cmd.workflow_run_create({input:create(extra)}),pattern);
 await reject({projectId:' '},/project id is required/);
 await reject({definitionId:'a b'},/invalid workflow definition id/);
 await reject({definitionVersion:''},/workflow definition version is required/);
 await reject({steps:[]},/workflow must contain between 1 and 128 steps/);
 await reject({steps:Array.from({length:129},(_,i)=>({id:'s'+i,kind:'k'}))},/workflow must contain between 1 and 128 steps/);
 await reject({steps:[{id:'build',kind:'a'},{id:'build',kind:'b'}]},/workflow step ids must be unique/);
 await reject({steps:[{id:'other',kind:'a'}]},/workflow start step does not exist/);
 await reject({steps:[{id:'build',kind:'k'.repeat(65)}]},/workflow step kind exceeds 64 bytes/);
 await reject({definition:{x:'y'.repeat(256*1024)}},/workflow definition is too large/);
 await reject({trigger:{x:'y'.repeat(32*1024)}},/workflow trigger provenance is too large/);
 await reject({startStepId:'../x'},/invalid workflow start step id/);
 await reject({steps:'build'},/invalid args `input`/);
 await reject({triggerKind:undefined},/missing field `triggerKind`/);
 const run=await cmd.workflow_run_create({input:create()});
 await assert.rejects(cmd.workflow_step_record({input:{runId:run.runId,stepId:'build',state:'completed'}}),/workflow step record state must be running or waiting/);
 await assert.rejects(cmd.workflow_step_record({input:{runId:run.runId,stepId:'build',state:'running',attemptId:'a/b'}}),/invalid task attempt id/);
 await assert.rejects(cmd.workflow_run_advance({input:{runId:run.runId,stepId:'build',stepState:'waiting',outcome:'x',target:'gate'}}),/workflow step must settle completed or failed/);
 await assert.rejects(cmd.workflow_run_advance({input:{runId:run.runId,stepId:'build',stepState:'completed',outcome:'',target:'gate'}}),/workflow outcome is required/);
 await assert.rejects(cmd.workflow_run_advance({input:{runId:run.runId,stepId:'build',stepState:'completed',outcome:'x',target:'$done'}}),/invalid workflow edge target/);
 await assert.rejects(cmd.workflow_run_advance({input:{runId:run.runId,stepId:'build',stepState:'completed',outcome:'x',target:'ghost'}}),/workflow edge target does not exist/);
 await assert.rejects(cmd.workflow_run_get({runId:'../etc'}),/invalid workflow run id/);
 await assert.rejects(cmd.workflow_run_list({projectId:''}),/project id is required/);
 assert.equal(pulses.length,1);
});
