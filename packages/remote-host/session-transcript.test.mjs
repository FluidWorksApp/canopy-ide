import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {sessionTranscriptTail,transcriptMessage} from './session-transcript.mjs';

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
