import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {listWorkspaceFiles,searchWorkspaceFiles} from './file-search.mjs';
test('search scopes multiple components, includes hidden source and Canopy artifacts, and honors ignore rules',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'canopy-search-test-'));
 try{
  const web=path.join(dir,'web'),api=path.join(dir,'api');await mkdir(web);await mkdir(api);await mkdir(path.join(web,'node_modules'));await mkdir(path.join(web,'.canopy'));
  await writeFile(path.join(web,'.gitignore'),'ignored.txt\n.canopy/\n');await writeFile(path.join(web,'ignored.txt'),'match');await writeFile(path.join(web,'.config'),'MATCH synthetic');await writeFile(path.join(web,'.canopy','brief.md'),'match artifact');await writeFile(path.join(web,'node_modules','vendor.js'),'match');await writeFile(path.join(api,'api.ts'),'match second');await symlink(path.join(api,'api.ts'),path.join(web,'linked.ts'));
  const files=await listWorkspaceFiles([web,api]);assert.ok(files.includes(path.join(web,'.config')));assert.ok(files.includes(path.join(web,'.canopy','brief.md')));assert.ok(files.includes(path.join(api,'api.ts')));assert.ok(!files.some(file=>file.endsWith('ignored.txt')||file.endsWith('linked.ts')||file.includes('node_modules')));
  const hits=await searchWorkspaceFiles([web,api],'match');assert.deepEqual(new Set(hits.map(hit=>path.basename(hit.path))),new Set(['.config','brief.md','api.ts']));assert.ok(hits.every(hit=>hit.line===1&&hit.text.length<=200));
  assert.ok((await listWorkspaceFiles([web])).every(file=>file.startsWith(web+'/')));assert.equal((await listWorkspaceFiles([web,api],1)).length,1);assert.equal((await searchWorkspaceFiles([web,api],'match',1)).length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
