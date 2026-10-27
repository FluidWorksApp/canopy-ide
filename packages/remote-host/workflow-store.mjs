// Durable workflow-run authority for a Linux workspace. Mirrors
// src-tauri/src/workflow.rs (SQLite on the desktop): the definition snapshot
// and trigger provenance a run was created from, the current step, edges taken
// and referenced TaskEnvelope attempt ids, with the same validation and error
// strings. Each run is one JSON file under ~/.canopy/workflows/<runId>.json,
// rewritten atomically per mutation (one file = one Rust transaction). Only
// summaries and the global attempt-id set stay in memory; definitions can be
// 256 KiB, so details are read from disk.
import {mkdir,readdir,rm} from 'node:fs/promises';
import {mutex,validId,bytes,now,randomId,encode,atomicWrite,readJson,arg,struct,clampLimit} from './task-store.mjs';

const DEFAULT_LIST=50,MAX_LIST=200,MAX_STEPS=128,MAX_DEFINITION_BYTES=256*1024,MAX_TRIGGER_BYTES=32*1024;
const TERMINAL_TARGETS=['$completed','$failed','$cancelled'];

export const WORKFLOW_STORE_READ_ONLY=['workflow_run_get','workflow_run_list'];

// workflow.rs validate_text has no empty-ok variant.
function validText(value,max,label){if(!value.trim())throw Error(`${label} is required`);if(bytes(value)>max)throw Error(`${label} exceeds ${max} bytes`);}

const summaryOf=r=>({runId:r.runId,projectId:r.projectId,definitionId:r.definitionId,definitionVersion:r.definitionVersion,definitionHash:r.definitionHash,triggerKind:r.triggerKind,status:r.status,currentStepId:r.currentStepId,createdAt:r.createdAt,updatedAt:r.updatedAt});
const detailOf=doc=>({...summaryOf(doc.run),definition:doc.run.definition,trigger:doc.run.trigger,steps:doc.steps.map(s=>({id:s.id,kind:s.kind,state:s.state,attemptIds:[...s.attemptIds],round:s.round,updatedAt:s.updatedAt})),edges:doc.edges.map(e=>({...e}))});

function validateCreate(i){
 validText(i.projectId,256,'project id');validId(i.definitionId,'workflow definition id');
 validText(i.definitionVersion,128,'workflow definition version');validText(i.definitionHash,128,'workflow definition hash');
 validText(i.triggerKind,128,'workflow trigger kind');validId(i.startStepId,'workflow start step id');
 if(!i.steps.length||i.steps.length>MAX_STEPS)throw Error(`workflow must contain between 1 and ${MAX_STEPS} steps`);
 if(bytes(encode(i.definition))>MAX_DEFINITION_BYTES)throw Error('workflow definition is too large');
 if(bytes(encode(i.trigger))>MAX_TRIGGER_BYTES)throw Error('workflow trigger provenance is too large');
 const ids=new Set();
 for(const step of i.steps){
  validId(step.id,'workflow step id');validText(step.kind,64,'workflow step kind');
  if(ids.has(step.id))throw Error('workflow step ids must be unique');
  ids.add(step.id);
 }
 if(!ids.has(i.startStepId))throw Error('workflow start step does not exist');
}

const stores=new Map();
export function workflowStoreFor(ctx){
 const dir=ctx.home+'/.canopy/workflows';
 let store=stores.get(dir);
 if(!store){store=createWorkflowStore(dir);stores.set(dir,store);}
 store.pulse=ctx.pulse??store.pulse;
 return store;
}

function createWorkflowStore(dir){
 const lock=mutex(),file=runId=>`${dir}/${runId}.json`;
 let summaries=null;const attemptIds=new Set();
 const self={pulse:null};
 const changed=(projectId,runId)=>{try{self.pulse?.('workflows',projectId,runId);}catch{}};
 const save=async doc=>{await atomicWrite(file(doc.run.runId),JSON.stringify(doc));summaries.set(doc.run.runId,summaryOf(doc.run));};

 // workflow.rs reconciles on the first open per process: whatever was running
 // when the previous process ended can only be resumed explicitly.
 async function load(){
  if(summaries)return;
  await mkdir(dir,{recursive:true,mode:0o700});
  const loaded=new Map(),at=now();
  for(const name of await readdir(dir)){
   if(name.endsWith('.tmp')){await rm(`${dir}/${name}`,{force:true});continue;}
   const match=/^([A-Za-z0-9_-]{1,96})\.json$/.exec(name);
   if(!match)continue;
   let doc;
   try{doc=await readJson(`${dir}/${name}`);}catch(error){throw Error(`workflow store is unreadable (${name}): ${error.message}`);}
   if(doc.run.status==='running'){
    for(const step of doc.steps)if(step.state==='running'&&step.id===doc.run.currentStepId)Object.assign(step,{state:'interrupted',updatedAt:at});
    Object.assign(doc.run,{status:'interrupted',updatedAt:at});
    await atomicWrite(`${dir}/${name}`,JSON.stringify(doc));
   }
   loaded.set(doc.run.runId,summaryOf(doc.run));
   for(const step of doc.steps)for(const id of step.attemptIds)attemptIds.add(id);
  }
  summaries=loaded;
 }
 const withLock=fn=>lock(async()=>{await load();return fn();});
 const read=async runId=>summaries.has(runId)?readJson(file(runId)):null;
 // current_project: the step must be the run's current step while it is active.
 async function current(runId,stepId){
  const doc=await read(runId);
  if(!doc||doc.run.currentStepId!==stepId||!['running','waiting'].includes(doc.run.status))throw Error('workflow step is not the current active step');
  return doc;
 }

 async function create(input){
  validateCreate(input);
  const runId=randomId('workflow'),at=now();
  const doc={run:{runId,schemaVersion:1,projectId:input.projectId,definitionId:input.definitionId,definitionVersion:input.definitionVersion,definitionHash:input.definitionHash,definition:input.definition,triggerKind:input.triggerKind,trigger:input.trigger,status:'running',currentStepId:input.startStepId,createdAt:at,updatedAt:at},
   steps:input.steps.map(s=>({id:s.id,kind:s.kind,state:s.id===input.startStepId?'running':'pending',round:0,attemptIds:[],createdAt:at,updatedAt:at})),edges:[]};
  await save(doc);changed(input.projectId,runId);
  return detailOf(doc);
 }
 async function recordStep(input){
  validId(input.runId,'workflow run id');validId(input.stepId,'workflow step id');
  if(!['running','waiting'].includes(input.state))throw Error('workflow step record state must be running or waiting');
  if(input.attemptId!=null)validId(input.attemptId,'task attempt id');
  const doc=await current(input.runId,input.stepId),step=doc.steps.find(s=>s.id===input.stepId),at=now();
  if(input.attemptId!=null){
   // workflow_step_attempts has UNIQUE(attempt_id) across every run.
   if(attemptIds.has(input.attemptId))throw Error('UNIQUE constraint failed: workflow_step_attempts.attempt_id');
   step.attemptIds.push(input.attemptId);
  }
  Object.assign(step,{state:input.state,updatedAt:at});
  Object.assign(doc.run,{status:input.state==='waiting'?'waiting':'running',updatedAt:at});
  await save(doc);
  if(input.attemptId!=null)attemptIds.add(input.attemptId);
  changed(doc.run.projectId,input.runId);
  return detailOf(doc);
 }
 async function advance(input){
  validId(input.runId,'workflow run id');validId(input.stepId,'workflow step id');validText(input.outcome,128,'workflow outcome');
  if(!['completed','failed'].includes(input.stepState))throw Error('workflow step must settle completed or failed');
  const terminal=TERMINAL_TARGETS.includes(input.target);
  if(!terminal)validId(input.target,'workflow edge target');
  const doc=await current(input.runId,input.stepId),at=now();
  const target=terminal?null:doc.steps.find(s=>s.id===input.target);
  if(!terminal&&!target)throw Error('workflow edge target does not exist');
  Object.assign(doc.steps.find(s=>s.id===input.stepId),{state:input.stepState,updatedAt:at});
  doc.edges.push({seq:doc.edges.reduce((max,e)=>Math.max(max,e.seq),0)+1,fromStepId:input.stepId,outcome:input.outcome,target:input.target,takenAt:at});
  if(terminal)Object.assign(doc.run,{status:input.target.slice(1),currentStepId:null,updatedAt:at});
  else{Object.assign(target,{state:'running',round:target.round+1,updatedAt:at});Object.assign(doc.run,{status:'running',currentStepId:input.target,updatedAt:at});}
  await save(doc);changed(doc.run.projectId,input.runId);
  return detailOf(doc);
 }
 async function resume(runId){
  validId(runId,'workflow run id');
  const doc=await read(runId);
  if(!doc)throw Error('workflow run not found');
  if(doc.run.status!=='interrupted')throw Error('only an interrupted workflow can resume');
  if(doc.run.currentStepId==null)throw Error('interrupted workflow has no current step');
  const at=now(),step=doc.steps.find(s=>s.id===doc.run.currentStepId);
  if(step)Object.assign(step,{state:'running',updatedAt:at});
  Object.assign(doc.run,{status:'running',updatedAt:at});
  await save(doc);changed(doc.run.projectId,runId);
  return detailOf(doc);
 }

 return Object.assign(self,{
  create:input=>withLock(()=>create(input)),
  recordStep:input=>withLock(()=>recordStep(input)),
  advance:input=>withLock(()=>advance(input)),
  resume:runId=>withLock(()=>resume(runId)),
  list:(projectId,limit)=>withLock(()=>{validText(projectId,256,'project id');return [...summaries.values()].filter(s=>s.projectId===projectId).sort((a,b)=>b.updatedAt-a.updatedAt||b.createdAt-a.createdAt).slice(0,limit).map(s=>({...s}));}),
  get:runId=>withLock(async()=>{validId(runId,'workflow run id');const doc=await read(runId);return doc&&detailOf(doc);}),
 });
}

export function workflowStoreCommands(ctx){
 const store=workflowStoreFor(ctx);
 const step=c=>value=>struct(c,'input',value,{id:'string',kind:'string'});
 const steps=c=>value=>{if(!Array.isArray(value))throw Error(`invalid args \`input\` for command \`${c}\`: invalid type: expected a sequence`);return value.map(step(c));};
 return {
  workflow_run_create:async args=>{const c='workflow_run_create';return store.create(struct(c,'input',args?.input,{projectId:'string',definitionId:'string',definitionVersion:'string',definitionHash:'string',definition:'value',triggerKind:'string',trigger:'value',startStepId:'string',steps:steps(c)}));},
  workflow_step_record:async args=>store.recordStep(struct('workflow_step_record','input',args?.input,{runId:'string',stepId:'string',state:'string',attemptId:'string?'})),
  workflow_run_advance:async args=>store.advance(struct('workflow_run_advance','input',args?.input,{runId:'string',stepId:'string',stepState:'string',outcome:'string',target:'string'})),
  workflow_run_resume:async args=>store.resume(arg('workflow_run_resume',args,'runId','string')),
  workflow_run_list:async args=>store.list(arg('workflow_run_list',args,'projectId','string'),clampLimit('workflow_run_list',args,DEFAULT_LIST,MAX_LIST)),
  workflow_run_get:async args=>store.get(arg('workflow_run_get',args,'runId','string')),
 };
}
