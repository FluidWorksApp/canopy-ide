import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {sessionTranscriptTail,transcriptMessage} from './session-transcript.mjs';
import {createHash} from 'node:crypto';

test('a conversation tail keeps who said what and skips tool traffic',async()=>{
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-transcript-')));
 try{
  const dir=home+'/.claude/projects/app';await mkdir(dir,{recursive:true});
  await writeFile(dir+'/abc-123.jsonl',[
   {type:'user',sessionId:'abc-123',cwd:'/workspace/app',message:{content:'Add a login page'}},
   {type:'assistant',sessionId:'abc-123',cwd:'/workspace/app',message:{content:[{type:'text',text:'I will use Supabase auth.'},{type:'tool_use',name:'Edit'}]}},
   {type:'user',sessionId:'abc-123',cwd:'/workspace/app',message:{content:[{type:'tool_result',content:'ok'}]}},
   {type:'user',sessionId:'abc-123',cwd:'/workspace/app',message:{content:'<system-reminder>x</system-reminder>'}},
  ].map(JSON.stringify).join('\n')+'\n');
  const lines=await sessionTranscriptTail(home,{sessionId:'abc-123',agent:'claude'});
  assert.deepEqual(lines,[{role:'user',text:'Add a login page'},{role:'assistant',text:'I will use Supabase auth.'}]);
  // Unknown agents and path-shaped ids are no transcript, not an error.
  assert.deepEqual(await sessionTranscriptTail(home,{sessionId:'../x',agent:'claude'}),[]);
  assert.deepEqual(await sessionTranscriptTail(home,{sessionId:'abc-123',agent:'other'}),[]);
  assert.deepEqual(await sessionTranscriptTail(home,{sessionId:'missing',agent:'claude'}),[]);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('codex lines read the same way; the developer channel is not the user',()=>{
 assert.equal(transcriptMessage('codex',JSON.stringify({type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'rules'}]}})),null);
 assert.deepEqual(transcriptMessage('codex',JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Done'}]}})),{role:'assistant',text:'Done'});
 assert.equal(transcriptMessage('claude','not json'),null);
});

// Every other CLI whose store SpotSearch reads: one fixture per format, the
// same shapes stores.rs's transcript_formats tests pin on the desktop.
const sha=s=>createHash('sha256').update(s).digest('hex');
async function withHome(fn){const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'canopy-transcript-')));try{await fn(home);}finally{await rm(home,{recursive:true,force:true});}}

test('omp: an append store with the role one level down',()=>withHome(async home=>{
 const dir=home+'/.omp/agent/sessions/app';await mkdir(dir,{recursive:true});
 await writeFile(dir+'/2026-07-19T23-41-29-912Z_019f7cc1-aaaa-bbbb.jsonl',[
  {type:'session',id:'019f7cc1-aaaa-bbbb',cwd:'/workspace/app'},
  {type:'message',message:{role:'user',content:[{type:'text',text:'ship it'}]}},
  {type:'custom',customType:'tool_execution_start',data:{}},
  {type:'message',message:{role:'assistant',content:[{type:'text',text:'Shipped.'}]}},
 ].map(JSON.stringify).join('\n')+'\n');
 assert.deepEqual(await sessionTranscriptTail(home,{sessionId:'019f7cc1-aaaa-bbbb',agent:'omp'}),[{role:'user',text:'ship it'},{role:'assistant',text:'Shipped.'}]);
 assert.deepEqual(await sessionTranscriptTail(home,{sessionId:'../019f7cc1-aaaa-bbbb',agent:'omp'}),[]);
}));

test('gemini: saved chats and unsaved prompt logs, found by the project root',()=>withHome(async home=>{
 const root='/workspace/app',bucket=home+'/.gemini/tmp/'+sha(root);await mkdir(bucket+'/chats',{recursive:true});
 await writeFile(bucket+'/chats/session-1.json',JSON.stringify({sessionId:'g-1',messages:[{type:'user',content:'rename the button'},{type:'info',content:'tool ran'},{type:'gemini',content:'Renamed it to Save.'}]}));
 await writeFile(bucket+'/logs.json',JSON.stringify([{type:'user',sessionId:'g-2',message:'what does main do'}]));
 assert.deepEqual(await sessionTranscriptTail(home,{sessionId:'g-1',agent:'gemini',roots:[root]}),[{role:'user',text:'rename the button'},{role:'assistant',text:'Renamed it to Save.'}]);
 assert.deepEqual(await sessionTranscriptTail(home,{sessionId:'g-2',agent:'gemini',roots:[root]}),[{role:'user',text:'what does main do'}]);
 // Without the root there is no bucket to look in.
 assert.deepEqual(await sessionTranscriptTail(home,{sessionId:'g-1',agent:'gemini'}),[]);
}));

test('opencode: parts attributed through their message',()=>withHome(async home=>{
 const {DatabaseSync}=await import('node:sqlite');
 const dir=home+'/.local/share/opencode';await mkdir(dir,{recursive:true});
 const db=new DatabaseSync(dir+'/opencode.db');
 db.exec(`CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_updated INTEGER);
  CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  INSERT INTO session VALUES ('ses_1','/workspace/app','login',1760000000000);
  INSERT INTO message VALUES ('m1','ses_1',1,'{"role":"user"}');
  INSERT INTO message VALUES ('m2','ses_1',2,'{"role":"assistant"}');
  INSERT INTO part VALUES ('p1','m1','ses_1',1,'{"type":"text","text":"add a login page"}');
  INSERT INTO part VALUES ('p2','m2','ses_1',2,'{"type":"tool","tool":"edit"}');
  INSERT INTO part VALUES ('p3','m2','ses_1',3,'{"type":"text","text":"Added /login."}');`);
 db.close();
 assert.deepEqual(await sessionTranscriptTail(home,{sessionId:'ses_1',agent:'opencode'}),[{role:'user',text:'add a login page'},{role:'assistant',text:'Added /login.'}]);
}));

test('agy: prose out of protobuf steps, with no author to claim',()=>withHome(async home=>{
 const {DatabaseSync}=await import('node:sqlite');
 const dir=home+'/.gemini/antigravity-cli/conversations';await mkdir(dir,{recursive:true});
 const db=new DatabaseSync(dir+'/c0ffee00-1111-2222-3333-444455556666.db');
 db.exec('CREATE TABLE trajectory_metadata_blob (data BLOB); CREATE TABLE steps (idx INTEGER, step_payload BLOB);');
 db.prepare('INSERT INTO steps VALUES (1, ?)').run(Buffer.concat([Buffer.from([0x0a,0x0c,0x08,0x01]),Buffer.from('Run the website and browse all pages')]));
 db.close();
 assert.deepEqual(await sessionTranscriptTail(home,{sessionId:'c0ffee00-1111-2222-3333-444455556666',agent:'agy'}),[{role:'message',text:'Run the website and browse all pages'}]);
}));

test('aider: prompts and replies from the history in a workspace root only',()=>withHome(async home=>{
 const project=home+'/project';await mkdir(project,{recursive:true});
 const file=project+'/.aider.chat.history.md';
 await writeFile(file,'# aider chat started at 2026-07-23 04:30:16\n> Aider v0.86.2\n#### add a retry\nSure — adding a retry to the client.\n');
 const id=file+'#2026-07-23T04:30:16';
 const scoped=async p=>{if(!p.startsWith(home))throw Error('outside the workspace');return p;};
 assert.deepEqual(await sessionTranscriptTail(home,{sessionId:id,agent:'aider',roots:[project]},{scoped}),[{role:'user',text:'add a retry'},{role:'assistant',text:'Sure — adding a retry to the client.'}]);
 // A root the workspace does not own is never read.
 assert.deepEqual(await sessionTranscriptTail(home,{sessionId:id,agent:'aider',roots:[project]},{scoped:async()=>{throw Error('no');}}),[]);
}));
