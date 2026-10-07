import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {prepareSharedAgentLaunch} from './shared-agent-launch.mjs';
const exec=promisify(execFile);
test('actual executable wrappers force scoped API facade while preserving arguments and member HOME',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'shared-cli-launch-'));
 try{
  const executable=path.join(home,'fake-cli');await writeFile(executable,'#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,base:process.env.ANTHROPIC_BASE_URL,auth:process.env.ANTHROPIC_AUTH_TOKEN,key:process.env.ANTHROPIC_API_KEY,codex:process.env.CANOPY_SHARED_CODEX_TOKEN}));\n',{mode:0o700});
  const accounts={claude:{url:'https://workspace.example/v1/agent-sessions/synthetic/claude',token:'c'.repeat(43)},codex:{url:'https://workspace.example/v1/agent-sessions/synthetic/codex',token:'d'.repeat(43)}};
  const directory=await prepareSharedAgentLaunch(home,'session-123',accounts,{binaries:{claude:executable,codex:executable}});
  const options={env:{...process.env,HOME:home,ANTHROPIC_API_KEY:'prior-private-key',ANTHROPIC_AUTH_TOKEN:'prior-private-auth'}};
  const claude=JSON.parse((await exec(path.join(directory,'claude'),['--resume','session with spaces'],options)).stdout);
  assert.deepEqual(claude.args,['--resume','session with spaces']);assert.equal(claude.home,home);assert.equal(claude.auth,accounts.claude.token);assert.equal(claude.key,'');assert.equal(claude.base,accounts.claude.url);
  const codex=JSON.parse((await exec(path.join(directory,'codex'),['resume','history'],options)).stdout);
  assert.equal(codex.codex,accounts.codex.token);assert.ok(codex.args.includes('model_provider="canopy_shared"'));assert.ok(codex.args.includes('model_providers.canopy_shared.requires_openai_auth=false'));assert.deepEqual(codex.args.slice(-2),['resume','history']);assert.equal(codex.home,home);
 }finally{await rm(home,{recursive:true,force:true});}
});
