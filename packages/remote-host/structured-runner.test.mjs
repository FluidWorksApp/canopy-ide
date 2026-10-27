import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {structuredRunnerCommands,lineSplitter} from './structured-runner.mjs';
import {ChannelHub} from './channels.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function setup(authorize=async()=>{}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'runner-')));const hub=new ChannelHub();
 return {root,hub,commands:structuredRunnerCommands({home:root,scoped:async p=>p,authorize})};
}
async function drain(hub,channel){const got=[];for(let i=0;i<100;i++){const r=(await hub.poll([channel],200))[channel];got.push(...r.messages);if(r.closed)break;}return got;}
test('an attempt streams lines, keeps stdin for follow-ups, and reports its exit',async()=>{
 const {root,hub,commands}=await setup();
 // Line by line: two writes may arrive in one chunk on a slow start.
 const script="require('readline').createInterface({input:process.stdin}).on('line',t=>{if(t==='bye'){console.error('done');process.exit(3);}console.log(JSON.stringify({echo:t}));});console.log('{\"ready\":true}');";
 await commands.structured_runner_spawn({attemptId:'a1',controlToken:'t1',command:process.execPath,args:['-e',script],cwd:root,env:[['X','1']],onData:hub.open(id(1))});
 await assert.rejects(commands.structured_runner_spawn({attemptId:'a1',controlToken:'t1',command:process.execPath,args:[],cwd:root,onData:hub.open(id(9))}),/already active: a1/);
 await assert.rejects(commands.structured_runner_write({attemptId:'a1',controlToken:'wrong',line:'x'}),/control token does not match/);
 await commands.structured_runner_write({attemptId:'a1',controlToken:'t1',line:'hi'});
 await commands.structured_runner_write({attemptId:'a1',controlToken:'t1',line:'bye'});
 assert.deepEqual(await drain(hub,id(1)),[{kind:'line',text:'{"ready":true}'},{kind:'line',text:'{"echo":"hi"}'},{kind:'stderr',text:'done'},{kind:'exit',code:3}]);
 await assert.rejects(commands.structured_runner_write({attemptId:'a1',controlToken:'t1',line:'x'}),/not running: a1/);
});
test('the task store authorizes attempts, ids are pathless, and a killed attempt reports no exit',async()=>{
 const {root,hub,commands}=await setup(async attempt=>{if(attempt==='denied')throw Error('structured runner attempt is settled, not running');});
 await assert.rejects(commands.structured_runner_spawn({attemptId:'../x',controlToken:'t',command:'node',cwd:root}),/valid attempt id/);
 await assert.rejects(commands.structured_runner_spawn({attemptId:'denied',controlToken:'t',command:'node',cwd:root}),/settled, not running/);
 await assert.rejects(commands.structured_runner_spawn({attemptId:'a2',controlToken:'t',command:'/no/such/bin',cwd:root}),/could not start/);
 await commands.structured_runner_spawn({attemptId:'a3',controlToken:'t',command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:root,keepStdin:false,onData:hub.open(id(2))});
 await assert.rejects(commands.structured_runner_write({attemptId:'a3',controlToken:'t',line:'x'}),/takes its prompt at launch/);
 await commands.structured_runner_kill({attemptId:'a3',controlToken:'t'});
 assert.deepEqual(await drain(hub,id(2)),[]);
});
test('long lines are cut at the limit and marked',()=>{
 const lines=[];const split=lineSplitter(4,(line,truncated)=>lines.push([line,truncated]));
 split.push(Buffer.from('abcdefg\nhi'));split.push(Buffer.from('\n'));split.end();
 assert.deepEqual(lines,[['abcd',true],['hi\n',false]]);
});
test('a runner gets the context-bridge credential the gateway minted, and is listed while it runs',async()=>{
 const {root,hub,commands}=await setup();
 const token='k'.repeat(24);
 const script="console.log(JSON.stringify({socket:process.env.CANOPY_CTX_SOCKET,token:process.env.CANOPY_CTX_TOKEN}));setInterval(()=>{},1000);";
 const started=await commands.structured_runner_spawn({attemptId:'a4',controlToken:'t',command:process.execPath,args:['-e',script],cwd:root,keepStdin:false,onData:hub.open(id(4)),harness:{token}});
 assert.ok(Number.isSafeInteger(started.pid));
 assert.deepEqual(await commands.structured_runner_live(),['a4']);
 const first=(await hub.poll([id(4)],3000))[id(4)].messages[0];
 assert.deepEqual(JSON.parse(first.text),{socket:'/run/canopy-ctx/ctx.sock',token});
 await commands.structured_runner_kill({attemptId:'a4',controlToken:'t'});
 assert.deepEqual(await commands.structured_runner_live(),[]);
 await assert.rejects(commands.structured_runner_spawn({attemptId:'a5',controlToken:'t',command:process.execPath,args:[],cwd:root,harness:{token:'short'}}),/Invalid harness credential/);
});
