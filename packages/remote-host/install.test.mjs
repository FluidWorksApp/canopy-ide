import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

test('Linux installer includes the complete gateway and provisioning dependency graph',async()=>{
 const script=await readFile(new URL('./install.sh',import.meta.url),'utf8');
 execFileSync('bash',['-n',new URL('./install.sh',import.meta.url).pathname]);
 const files=new Set(script.match(/for file in ([^;]+); do/)[1].trim().split(/\s+/));
 const visited=new Set();
 async function visit(name){
  if(visited.has(name))return;visited.add(name);
  assert.ok(files.has(name),`Installer omits runtime dependency ${name}`);
  const source=await readFile(new URL(name,import.meta.url),'utf8');
  for(const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"]\.\/([^'"]+)['"]/g))await visit(match[1]);
 }
 for(const entry of ['gateway.mjs','init.mjs','provision-capacity.mjs','accounts.mjs','migrate-workspace.mjs','migration-recovery.mjs','inspect-migration.mjs','recover-migration.mjs'])await visit(entry);
 assert.ok(visited.has('member-leases.mjs'));
 assert.ok(visited.has('project-mounts.mjs'));
});

test('workspace image includes every runner and native command dependency',async()=>{
 const dockerfile=await readFile(new URL('./Dockerfile',import.meta.url),'utf8');
 const files=new Set([...dockerfile.matchAll(/^COPY (.+) \.\/$/gm)].flatMap(match=>match[1].split(/\s+/)));
 const visited=new Set();
 async function visit(name){
  if(visited.has(name))return;visited.add(name);
  assert.ok(files.has(name),`Workspace image omits runtime dependency ${name}`);
  const source=await readFile(new URL(name,import.meta.url),'utf8');
  for(const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"]\.\/([^'"]+)['"]/g))await visit(match[1]);
 }
 await visit('runner.mjs');
 assert.ok(visited.has('session-digests.mjs'));
 assert.ok(visited.has('session-transfer.mjs'));
});

test('deployment stages the hook source allowlist into a fresh standalone bundle',async()=>{
 const {mkdtemp,readdir,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const path=await import('node:path');
 const directory=await mkdtemp(path.join(tmpdir(),'canopy-deploy-inputs-'));
 try{
  const stage=path.join(directory,'hook-build');
  execFileSync(process.execPath,[new URL('./prepare-hook-build.mjs',import.meta.url).pathname,stage]);
  const manifest=JSON.parse(await readFile(path.join(stage,'sources.json'),'utf8'));
  const files=[];async function walk(dir,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())await walk(path.join(dir,entry.name),name+'/');else files.push(name);}}
  await walk(stage);assert.deepEqual(files.sort(),[...manifest,'sources.json'].sort());
  assert.ok(manifest.includes('packages/agent-hook/Cargo.lock'));
  const script=await readFile(new URL('./deploy.sh',import.meta.url),'utf8');
  assert.ok(script.includes('"$source_dir/prepare-hook-build.mjs" "$bundle/hook-build"'));
  execFileSync('bash',['-n',new URL('./deploy.sh',import.meta.url).pathname]);
 }finally{await rm(directory,{recursive:true,force:true});}
});
