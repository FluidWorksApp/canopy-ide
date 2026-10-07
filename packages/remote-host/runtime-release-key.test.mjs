import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {runtimeReleaseKey} from './runtime-release-key.mjs';
test('runtime publication uses the existing managed-compute IAM releases prefix',()=>{
 const revision='2b90d9cc5a90f5041d54f9fe34126082d7cc38b4';assert.equal(runtimeReleaseKey(revision),`releases/${revision}/workspace-host.tar.gz`);
});
test('release keys reject shortened, noncanonical and path-injected revisions',()=>{
 for(const revision of ['',null,undefined,'2b90d9c','a'.repeat(39),'A'.repeat(40),'a'.repeat(41),'../'+ 'a'.repeat(40),'a'.repeat(40)+'/other','a'.repeat(40)+'\n'])assert.throws(()=>runtimeReleaseKey(revision));
});
test('the multi-architecture workflow emits the same canonical private runtime key',async()=>{
 const workflow=await readFile(new URL('../../.github/workflows/workspace-image.yml',import.meta.url),'utf8');
 assert.match(workflow,/import \{runtimeReleaseKey\} from "\.\/packages\/remote-host\/runtime-release-key\.mjs"/);
 assert.match(workflow,/runtimeKey:runtimeReleaseKey\(process\.env\.REVISION\)/);
 assert.doesNotMatch(workflow,/runtime-releases\//);
});
test('a reviewed hotfix archive retains its exact release prefix and canonical default',()=>{
 const revision='a'.repeat(40),key=`releases/${revision}/workspace-host-startup-reliability-20261006.tar.gz`;assert.equal(runtimeReleaseKey(revision,key),key);assert.equal(runtimeReleaseKey(revision),`releases/${revision}/workspace-host.tar.gz`);
 for(const invalid of [`releases/${'b'.repeat(40)}/workspace-host.tar.gz`,`runtime-releases/${revision}/workspace-host.tar.gz`,`releases/${revision}/../workspace-host.tar.gz`,`releases/${revision}/nested/workspace-host.tar.gz`,`releases/${revision}/archive.tar.gz?token=x`,`releases/${revision}/archive..tar.gz`,`releases/${revision}/archive.zip`,''])assert.throws(()=>runtimeReleaseKey(revision,invalid));
});
