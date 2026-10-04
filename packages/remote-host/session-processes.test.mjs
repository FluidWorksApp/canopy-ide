import test from 'node:test';import assert from 'node:assert/strict';
import {bindSessionProcesses,processAgentHint,parseProcessStat} from './session-processes.mjs';
test('identifies foreground agent binaries and runtime wrappers without matching agent names in arguments',()=>{
 assert.equal(processAgentHint(['claude','--resume'],'/usr/bin/claude','claude').bin,'claude');
 assert.equal(processAgentHint(['node','/usr/local/lib/node_modules/@openai/codex/bin/codex.js'],'/usr/bin/node','node').bin,'codex');
 assert.equal(processAgentHint(['bash','-lc','echo claude'],'/usr/bin/bash','bash'),null);
 assert.equal(processAgentHint(['node','server.js','--model=claude'],'/usr/bin/node','node'),null);
});
test('binds explicit PTY identity and rejects ambiguous legacy inventories and reused PIDs',()=>{
 const roots=[{pid:21,parent:10,tty:1,started:101},{pid:22,parent:10,tty:2,started:102}];
 const sessions=[{id:1,exitCode:0},{id:4,pid:21,exitCode:null},{id:6,pid:22,exitCode:null}],known=new Map();
 assert.equal(bindSessionProcesses(sessions,roots,10,known).get(4).pid,21);
 assert.equal(bindSessionProcesses(sessions,roots,10,known).get(6).pid,22);
 const legacy=sessions.map(({pid,...session})=>session);
 assert.equal(bindSessionProcesses(legacy,roots,10).size,0);
 assert.equal(bindSessionProcesses([legacy[1]],[roots[0]],10).get(4).pid,21);
 assert.equal(bindSessionProcesses(legacy,[{...roots[0],started:200},roots[1]],10,known).has(4),false);
});
test('correlates spawn markers even when concurrent agents start out of acceptance order',()=>{
 const sessions=[{id:1,requestId:'first',exitCode:null},{id:2,requestId:'second',exitCode:null}];
 const processes=[{pid:21,parent:10,tty:1,started:100,requestId:'second'},{pid:22,parent:10,tty:2,started:101,requestId:'first'}];
 const bindings=bindSessionProcesses(sessions,processes,10);assert.equal(bindings.get(1).pid,22);assert.equal(bindings.get(2).pid,21);
});
test('process-stat parser handles spaces in executable names',()=>{
 const tail=Array(22).fill('0');tail[0]='S';tail[1]='10';tail[4]='34816';tail[5]='23';tail[11]='100';tail[12]='5';tail[19]='42';tail[21]='20';
 assert.deepEqual(parseProcessStat('21 (name with spaces) '+tail.join(' ')),{pid:21,name:'name with spaces',parent:10,group:0,tty:34816,foreground:23,ticks:105,started:42,rss:20});
});
