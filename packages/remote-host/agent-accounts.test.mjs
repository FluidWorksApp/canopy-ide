import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm,mkdir,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {importAgentAccounts} from './agent-accounts.mjs';
const accounts={claude:{claudeAiOauth:{accessToken:'synthetic-access',refreshToken:'synthetic-refresh'}},codex:{tokens:{access_token:'synthetic-codex'}}};
test('copies only selected agent logins with private file modes',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'canopy-accounts-'));try{
  assert.deepEqual(await importAgentAccounts(accounts,home),{imported:['claude','codex']});
  assert.deepEqual(JSON.parse(await readFile(home+'/.codex/auth.json','utf8')),accounts.codex);
  assert.equal((await stat(home+'/.claude/.credentials.json')).mode&0o777,0o600);
  assert.equal((await stat(home+'/.codex')).mode&0o777,0o700);
  assert.equal(JSON.parse(await readFile(home+'/.claude/.claude.json','utf8')).hasCompletedOnboarding,true);
 }finally{await rm(home,{recursive:true,force:true});}
});
test('Claude import completes onboarding and preserves remote settings',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'canopy-accounts-'));try{
  await mkdir(home+'/.claude');
  const settings={hasCompletedOnboarding:false,theme:'dark',projects:{'/workspace':{hasTrustDialogAccepted:false}},oauthAccount:{accountUuid:'synthetic-id'}};
  await writeFile(home+'/.claude/.claude.json',JSON.stringify(settings));
  await importAgentAccounts({claude:accounts.claude},home);
  assert.deepEqual(JSON.parse(await readFile(home+'/.claude/.claude.json','utf8')),{...settings,hasCompletedOnboarding:true});
  assert.equal((await stat(home+'/.claude/.claude.json')).mode&0o777,0o600);
 }finally{await rm(home,{recursive:true,force:true});}
});
test('Claude setup refuses a settings symlink',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'canopy-accounts-'));try{
  await mkdir(home+'/.claude');await writeFile(home+'/outside','{}');await symlink(home+'/outside',home+'/.claude/.claude.json');
  await assert.rejects(importAgentAccounts({claude:accounts.claude},home),/regular file/);
  assert.equal(await readFile(home+'/outside','utf8'),'{}');
 }finally{await rm(home,{recursive:true,force:true});}
});
test('invalid accounts are rejected before altering credentials',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'canopy-accounts-'));try{
  await assert.rejects(importAgentAccounts({...accounts,other:{token:'synthetic'}},home),/Invalid agent/);
  await assert.rejects(stat(home+'/.codex/auth.json'));
  await mkdir(home+'/elsewhere');await symlink(home+'/elsewhere',home+'/.codex');
  await assert.rejects(importAgentAccounts({codex:accounts.codex},home),/symlink/);
 }finally{await rm(home,{recursive:true,force:true});}
});
test('default Claude import records only the whitelisted account identity',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'canopy-accounts-'));try{
  await mkdir(home+'/.claude');await writeFile(home+'/.claude/.claude.json',JSON.stringify({theme:'dark'}));
  await importAgentAccounts({claude:accounts.claude},home,{claudeIdentity:{emailAddress:'me@example.com',displayName:'Me',accountUuid:'synthetic-id',accessToken:'leak'}});
  assert.deepEqual(JSON.parse(await readFile(home+'/.claude/.claude.json','utf8')),{theme:'dark',hasCompletedOnboarding:true,oauthAccount:{emailAddress:'me@example.com',displayName:'Me',accountUuid:'synthetic-id'}});
 }finally{await rm(home,{recursive:true,force:true});}
});
