import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {hostPaths,hostUnchanged,pathMatcher,previousTag,withoutAppVersion} from './workspace-host-fingerprint.mjs';

const WORKFLOW=`on:
  push:
    branches: [main]
    paths:
      - 'packages/remote-host/**'
      - 'src-tauri/Cargo.lock'
      - 'scripts/workspace-host-release*.mjs'
      # A comment inside the list.
      - 'package.json'
  workflow_dispatch:
`;
const LOCK=version=>`[[package]]\nname = "aho"\nversion = "1.0.0"\n\n[[package]]\nname = "canopy"\nversion = "${version}"\n`;

function repository(t){
 const cwd=mkdtempSync(join(tmpdir(),'host-fingerprint-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'});
 git('init','-q');git('config','user.email','test@example.com');git('config','user.name','Test');
 const write=(file,text)=>{mkdirSync(dirname(join(cwd,file)),{recursive:true});writeFileSync(join(cwd,file),text);};
 const release=(tag,files)=>{for(const [file,text] of Object.entries(files))write(file,text);git('add','-A');git('commit','-qm',tag);git('tag',tag);};
 release('v1.0.0',{'.github/workflows/workspace-image.yml':WORKFLOW,'package.json':'{"name":"app","version":"1.0.0"}\n','src-tauri/Cargo.lock':LOCK('1.0.0'),'packages/remote-host/host.mjs':'one\n','src/app.ts':'one\n'});
 return {cwd,release};
}
const bump=version=>({'package.json':`{"name":"app","version":"${version}"}\n`,'src-tauri/Cargo.lock':LOCK(version)});

test('reads the paths the host is built from',()=>{
 assert.deepEqual(hostPaths(WORKFLOW),['packages/remote-host/**','src-tauri/Cargo.lock','scripts/workspace-host-release*.mjs','package.json']);
 assert.ok(hostPaths(readFileSync('.github/workflows/workspace-image.yml','utf8')).includes('packages/remote-host/**'));
});

test('matches globs the way the workflow does',()=>{
 const matches=pathMatcher(hostPaths(WORKFLOW));
 assert.ok(matches('packages/remote-host/deep/file.mjs'));
 assert.ok(matches('scripts/workspace-host-release.test.mjs'));
 assert.ok(!matches('scripts/other.mjs'));
 assert.ok(!matches('packages/remote-host-other/file.mjs'));
});

test('ignores only the version',()=>{
 assert.equal(withoutAppVersion('src-tauri/Cargo.lock',LOCK('1.0.0')),withoutAppVersion('src-tauri/Cargo.lock',LOCK('2.0.0')));
 assert.ok(withoutAppVersion('src-tauri/Cargo.lock',LOCK('1.0.0')).includes('name = "aho"\nversion = "1.0.0"'));
 assert.notEqual(withoutAppVersion('package.json','{"version":"1","a":1}'),withoutAppVersion('package.json','{"version":"1","a":2}'));
});

test('a version bump and an app change leave the host alone',t=>{
 const {cwd,release}=repository(t);
 release('v1.0.1',{...bump('1.0.1'),'src/app.ts':'two\n'});
 assert.deepEqual(hostUnchanged('v1.0.1',cwd),{unchanged:true,previous:'v1.0.0'});
});

test('host code, dependencies and manifests count as host changes',t=>{
 for(const change of [{'packages/remote-host/host.mjs':'two\n'},{'src-tauri/Cargo.lock':LOCK('1.0.1').replace('name = "aho"\nversion = "1.0.0"','name = "aho"\nversion = "1.0.1"')},{'package.json':'{"name":"renamed","version":"1.0.1"}\n'}]){
  const {cwd,release}=repository(t);
  release('v1.0.1',{...bump('1.0.1'),...change});
  assert.equal(hostUnchanged('v1.0.1',cwd).unchanged,false);
 }
});

test('a deleted host file counts as a host change',t=>{
 const {cwd,release}=repository(t);
 release('v1.0.1',{'packages/remote-host/extra.mjs':'extra\n'});
 rmSync(join(cwd,'packages/remote-host/extra.mjs'));
 release('v1.0.2',{});
 assert.equal(hostUnchanged('v1.0.2',cwd).unchanged,false);
});

test('compares against the newest earlier tag, by version',t=>{
 const {cwd,release}=repository(t);
 release('v1.0.9',{'src/app.ts':'nine\n'});
 release('v1.0.10',{'src/app.ts':'ten\n'});
 release('v1.0.11-rc.1',{'src/app.ts':'candidate\n'});
 release('v1.0.11',{'src/app.ts':'eleven\n'});
 assert.equal(previousTag('v1.0.11',cwd),'v1.0.10');
});

test('the first release has nothing to match',t=>{
 const {cwd}=repository(t);
 assert.deepEqual(hostUnchanged('v1.0.0',cwd),{unchanged:false,previous:null});
});
