import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,readdir,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeWorkspaceFile} from './file-write.mjs';
test('atomic saves preserve file mode and support empty documents',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'canopy-save-test-'));
 try{const file=path.join(dir,'private.env');await writeFile(file,'synthetic',{mode:0o600});await writeWorkspaceFile(file,'saved');assert.equal(await readFile(file,'utf8'),'saved');assert.equal((await stat(file)).mode&0o777,0o600);await writeWorkspaceFile(file,'');assert.equal((await stat(file)).size,0);assert.deepEqual(await readdir(dir),['private.env']);}finally{await rm(dir,{recursive:true,force:true});}
});
test('failed replacement cleans its temporary file and preserves the destination',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'canopy-save-test-'));
 try{const target=path.join(dir,'folder');await mkdir(target);await writeFile(path.join(target,'original'),'unchanged');await assert.rejects(writeWorkspaceFile(target,'replace'));assert.equal(await readFile(path.join(target,'original'),'utf8'),'unchanged');assert.deepEqual(await readdir(dir),['folder']);}finally{await rm(dir,{recursive:true,force:true});}
});
