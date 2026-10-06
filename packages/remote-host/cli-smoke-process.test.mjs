import test from 'node:test';import assert from 'node:assert/strict';import {runSmokeCli} from './cli-smoke-process.mjs';
test('headless subprocess receives stdin EOF and completes instead of waiting until its timeout',async()=>{
 const result=await runSmokeCli(process.execPath,['-e','let data="";process.stdin.on("data",value=>data+=value);process.stdin.on("end",()=>console.log(JSON.stringify({prompt:"argument",stdin:data})));'],{timeout:1000});assert.deepEqual(JSON.parse(result.stdout),{prompt:'argument',stdin:''});
});
test('graceful exit zero after a timeout is rejected rather than accepted as an empty CLI result',async()=>{
 await assert.rejects(runSmokeCli(process.execPath,['-e','process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);'],{timeout:100}),/timed out|Command failed/);
});
