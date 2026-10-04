import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat,readdir,rm,symlink} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {WorkspaceUploads,UPLOAD_CHUNK_BYTES} from './file-upload.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(fn){const root=await mkdtemp(path.join(os.tmpdir(),'canopy-upload-test-'));try{await fn(new WorkspaceUploads(root),root);}finally{await rm(root,{recursive:true,force:true});}}
test('binary transfers stay chunked, preserve folders and modes, and publish only on completion',()=>fixture(async(u,root)=>{
 await u.invoke('fs_upload_dir',{path:root+'/project/empty'});
 const bytes=Buffer.alloc(2*1024*1024+19);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 const target=root+'/project/binary.dat',{id}=await u.invoke('fs_upload_begin',{path:target,size:bytes.length,mode:0o750});
 await assert.rejects(stat(target),{code:'ENOENT'});
 for(let offset=0;offset<bytes.length;offset+=UPLOAD_CHUNK_BYTES){const chunk=bytes.subarray(offset,offset+UPLOAD_CHUNK_BYTES);assert.equal((await u.invoke('fs_upload_chunk',{id,offset,b64:chunk.toString('base64')})).written,offset+chunk.length);}
 await u.invoke('fs_upload_finish',{id,sha256:digest(bytes)});assert.deepEqual(await readFile(target),bytes);assert.equal((await stat(target)).mode&0o777,0o750);
 assert.ok((await stat(root+'/project/empty')).isDirectory());assert.deepEqual(await readdir(root+'/.canopy-uploads'),[]);
 const zero=await u.invoke('fs_upload_begin',{path:root+'/project/.env',size:0});await u.invoke('fs_upload_finish',{id:zero.id,sha256:digest(Buffer.alloc(0))});assert.equal((await stat(root+'/project/.env')).size,0);
}));
test('invalid offsets, oversized chunks, integrity errors and collisions never replace existing files',()=>fixture(async(u,root)=>{
 const {id}=await u.invoke('fs_upload_begin',{path:root+'/file',size:1});
 await assert.rejects(u.invoke('fs_upload_chunk',{id,offset:1,b64:'YQ=='}),/Invalid upload chunk/);
 await assert.rejects(u.invoke('fs_upload_chunk',{id,offset:0,b64:Buffer.alloc(UPLOAD_CHUNK_BYTES+1).toString('base64')}),/Invalid upload chunk/);
 await u.invoke('fs_upload_chunk',{id,offset:0,b64:'YQ=='});
 await writeFile(root+'/file','original');await assert.rejects(u.invoke('fs_upload_finish',{id,sha256:digest(Buffer.from('a'))}),/already exists/);assert.equal(await readFile(root+'/file','utf8'),'original');
 await assert.rejects(u.invoke('fs_upload_begin',{path:root+'/file',size:1}),/already exists/);
 const next=await u.invoke('fs_upload_begin',{path:root+'/corrupt',size:0});await assert.rejects(u.invoke('fs_upload_finish',{id:next.id,sha256:'incorrect'}),/integrity/);await assert.rejects(stat(root+'/corrupt'),{code:'ENOENT'});assert.deepEqual(await readdir(root+'/.canopy-uploads'),[]);
}));
test('uploads cannot traverse roots or use symlinks as files, folders or staging directories',()=>fixture(async(u,root)=>{
 await assert.rejects(u.invoke('fs_upload_begin',{path:root+'/../escape',size:0}),/outside/);
 await symlink(os.tmpdir(),root+'/link');await assert.rejects(u.invoke('fs_upload_dir',{path:root+'/link/sub'}),/symlink/);
 await assert.rejects(u.invoke('fs_upload_begin',{path:root+'/link/file',size:0}),/symlink/);
 await symlink(os.tmpdir(),root+'/.canopy-uploads');await assert.rejects(u.invoke('fs_upload_begin',{path:root+'/file',size:0}),/symlink/);
}));
test('cancellation, expiry and concurrent admission bound staging files and open handles',()=>fixture(async(u,root)=>{
 const results=await Promise.allSettled(Array.from({length:8},(_,i)=>u.invoke('fs_upload_begin',{path:root+'/file'+i,size:1})));
 const ids=results.filter(r=>r.status==='fulfilled').map(r=>r.value.id);assert.equal(ids.length,4);assert.equal(u.active.size,4);assert.equal(u.pending,0);
 await u.invoke('fs_upload_abort',{id:ids[0]});assert.equal(u.active.size,3);
 u.now=()=>Date.now()+16*60*1000;await u.sweep();assert.equal(u.active.size,0);assert.deepEqual(await readdir(root+'/.canopy-uploads'),[]);
 await assert.rejects(u.invoke('fs_upload_chunk',{id:ids[1],offset:0,b64:'YQ=='}),/expired/);
}));
