import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {resolveWorkspacePath} from './workspace-file-paths.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'canopy-file-links-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const workspace=path.join(root,'workspace'),scratch=path.join(root,'scratch'),outside=path.join(root,'outside');
 for(const dir of [workspace,scratch,outside])await mkdir(dir);
 return {workspace,scratch,outside};
}
test('scratch log links resolve to their original file and can be edited without staging a copy',async t=>{
 const options=await fixture(t),file=path.join(options.scratch,'build-fix.log');await writeFile(file,'BUILD SUCCESSFUL');
 const resolved=await resolveWorkspacePath(file,options);assert.equal(resolved,file);assert.equal(await readFile(resolved,'utf8'),'BUILD SUCCESSFUL');
 await writeFile(await resolveWorkspacePath(file,{...options,create:true}),'updated');assert.equal(await readFile(file,'utf8'),'updated');
 assert.equal(await resolveWorkspacePath(path.join(options.scratch,'new.log'),{...options,create:true}),path.join(options.scratch,'new.log'));
});
test('project execution remains workspace-only and file access rejects traversal, near-miss roots, and outside symlinks',async t=>{
 const options=await fixture(t),file=path.join(options.scratch,'build.log');await writeFile(file,'log');
 await assert.rejects(resolveWorkspacePath(file,{workspace:options.workspace}),/outside selected workspace/);
 for(const value of [path.join(options.outside,'secret'),options.scratch+'-other/file',path.join(options.scratch,'../outside/secret'),'\0bad'])await assert.rejects(resolveWorkspacePath(value,options));
 await writeFile(path.join(options.outside,'secret'),'private');await symlink(path.join(options.outside,'secret'),path.join(options.scratch,'escape'));
 await assert.rejects(resolveWorkspacePath(path.join(options.scratch,'escape'),options),/Symlink outside/);
 await symlink(options.outside,path.join(options.scratch,'parent-escape'));
 await assert.rejects(resolveWorkspacePath(path.join(options.scratch,'parent-escape/new.log'),{...options,create:true}),/Symlink outside/);
 await writeFile(path.join(options.workspace,'source.ts'),'source');
 assert.equal(await resolveWorkspacePath('source.ts',options),path.join(options.workspace,'source.ts'));
});
