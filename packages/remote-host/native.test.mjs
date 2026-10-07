import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeInvoke,scoped} from './native.mjs';

test('native workspace boundary refuses external and malformed paths',async()=>{
 for(const value of ['/etc/passwd','/home/agent/.codex/auth.json','../other-workspace','/workspace-other/file','/workspace/\0bad'])await assert.rejects(scoped(value));
});
test('native executable probes reject shell syntax before starting a child',async()=>{
 await assert.rejects(nativeInvoke('which_check',{commands:['git; cat /etc/passwd']}),/Invalid executable/);
});
test('account selection cannot reference an ungranted pool',async()=>{
 await assert.rejects(nativeInvoke('profile_env',{id:'pool-unauthorized'}),/not available/);
 // Default-profile behavior is covered with a temporary home in profiles.test.mjs
 // and against /home/agent in the real Linux image.
 for(const id of ['pool-../owner','pool-','pool-owner/other'])await assert.rejects(nativeInvoke('profile_env',{id}),/not available/);
});
test('unsupported remote commands fail explicitly',async()=>{
 await assert.rejects(nativeInvoke('companion_spawn',{}),/does not support companion_spawn/);
});
test('remote browser rejects unsafe sign-in schemes and embedded credentials',async()=>{
 for(const url of ['file:///etc/passwd','http://localhost:8787','https://user:synthetic@example.com'])await assert.rejects(nativeInvoke('workspace_browser_open',{url}),/HTTPS/);
});

test('workspace preview cannot launch arbitrary URLs or embedded credentials',async()=>{
 for(const url of ['file:///etc/passwd','https://example.com','http://localhost.evil.test:6001','http://user:secret@localhost:6001']) await assert.rejects(nativeInvoke('workspace_preview_open',{url}),/localhost HTTP/);
});

test('OpenCode footer handler is registered and rejects path-like session selectors before any store access',async()=>{await assert.rejects(nativeInvoke('opencode_session_stats',{sessionId:'../other-member'}),/Invalid OpenCode session/);});

test('Tools panel discovery is served by the workspace and keeps project roots inside it',async()=>{
 assert.ok(Array.isArray(await nativeInvoke('mcp_servers',{projectDirs:[]})));
 await assert.rejects(nativeInvoke('mcp_servers',{projectDirs:['/etc']}),/outside selected workspace/);
 await assert.rejects(nativeInvoke('mcp_update_sources',{projectDirs:[],changes:[{agent:'cursor',name:'x',configPath:'/etc/passwd',scope:'global',enabled:false}]}),/no longer configures/);
});
