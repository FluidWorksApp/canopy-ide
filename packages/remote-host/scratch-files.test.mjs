import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {credentialFileName,scratchFile,scratchRoots} from './scratch-files.mjs';
import {nativeInvoke} from './native.mjs';
import {viewerNativePayload} from './readonly-native.mjs';

async function world(){
 const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'scratch-files-')));
 const home=path.join(base,'home'),tmp=path.join(base,'tmp'),elsewhere=path.join(base,'elsewhere');
 await mkdir(path.join(home,'.canopy','sessions','s1'),{recursive:true});
 await mkdir(path.join(home,'.ssh'),{recursive:true});
 await mkdir(path.join(tmp,'claude-1000','-workspace-app','abc','scratchpad','audit'),{recursive:true});
 await mkdir(elsewhere,{recursive:true});
 const options={tmp,extra:[]};
 return {base,home,tmp,elsewhere,options,done:()=>rm(base,{recursive:true,force:true})};
}

test('an agent scratchpad file under the temp folder is readable',async()=>{
 const w=await world();
 try{
  const file=path.join(w.tmp,'claude-1000','-workspace-app','abc','scratchpad','audit','apps-crosscut.md');
  await writeFile(file,'# notes\n');
  assert.equal(await scratchFile(file,w.home,w.options),file);
  const session=path.join(w.home,'.canopy','sessions','s1','plan.md');
  await writeFile(session,'plan');
  assert.equal(await scratchFile(session,w.home,w.options),session);
 }finally{await w.done();}
});

test('everything else outside the workspace stays refused',async()=>{
 const w=await world();
 try{
  await writeFile(path.join(w.elsewhere,'notes.md'),'x');
  await writeFile(path.join(w.home,'.ssh','config'),'x');
  await writeFile(path.join(w.home,'notes.md'),'x');
  for(const bad of [path.join(w.elsewhere,'notes.md'),path.join(w.home,'.ssh','config'),path.join(w.home,'notes.md'),'relative.md','',null,w.tmp,path.join(w.tmp,'claude-1000')]){
   await assert.rejects(scratchFile(bad,w.home,w.options),/outside selected workspace/,String(bad));
  }
  // A missing file is reported as missing, so the IDE can say "deleted".
  await assert.rejects(scratchFile(path.join(w.tmp,'gone.md'),w.home,w.options),{code:'ENOENT'});
 }finally{await w.done();}
});

test('a link in the scratch folder cannot lead out of it',async()=>{
 const w=await world();
 try{
  await writeFile(path.join(w.elsewhere,'secret.md'),'x');
  await symlink(path.join(w.elsewhere,'secret.md'),path.join(w.tmp,'link.md'));
  await symlink(w.elsewhere,path.join(w.tmp,'dir'));
  await assert.rejects(scratchFile(path.join(w.tmp,'link.md'),w.home,w.options),/outside selected workspace/);
  await assert.rejects(scratchFile(path.join(w.tmp,'dir','secret.md'),w.home,w.options),/outside selected workspace/);
  await assert.rejects(scratchFile(path.join(w.tmp,'..','elsewhere','secret.md'),w.home,w.options),/outside selected workspace/);
 }finally{await w.done();}
});

test('credentials are refused even in a scratch folder',async()=>{
 const w=await world();
 try{
  for(const name of ['id_rsa','server.pem','.npmrc','credentials.json','auth.json']){
   const file=path.join(w.tmp,name);await writeFile(file,'x');
   await assert.rejects(scratchFile(file,w.home,w.options),/holds credentials/,name);
  }
  assert.equal(credentialFileName('notes.md'),false);
  assert.equal(credentialFileName('ID_ED25519.pub'),true);
 }finally{await w.done();}
});

test('roots that do not exist are left out, and none is listed twice',async()=>{
 const w=await world();
 try{
  const roots=await scratchRoots(w.home,{tmp:w.tmp,extra:[w.tmp,path.join(w.base,'nope')]});
  assert.deepEqual(roots,[path.join(w.home,'.canopy','sessions'),w.tmp]);
 }finally{await w.done();}
});

test('the host reads and stats a scratch file for the owner, and nothing is written there',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'scratch-native-'));
 try{
  const file=path.join(dir,'apps-crosscut.md');
  await writeFile(file,'# cross-cut\n');
  const read=await nativeInvoke('fs_read_file',{path:file});
  assert.equal(Buffer.from(read.b64,'base64').toString(),'# cross-cut\n');
  const info=await nativeInvoke('fs_stat',{path:file});
  assert.equal(info.size,12);assert.equal(info.is_dir,false);
  assert.equal((await nativeInvoke('fs_stat_many',{paths:[file]}))[0].size,12);
  // Reading is the whole of it: writing, listing and deleting stay refused.
  await assert.rejects(nativeInvoke('fs_write_file',{path:file,content:'x'}),/outside selected workspace/i);
  await assert.rejects(nativeInvoke('fs_read_dir',{path:dir}),/outside selected workspace/i);
  await assert.rejects(nativeInvoke('fs_trash',{path:file}),/outside selected workspace/i);
  await assert.rejects(nativeInvoke('fs_read_file',{path:'/etc/passwd'}),/outside selected workspace/i);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a viewer of a shared workspace is not shown the machine\'s scratch files',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'scratch-viewer-'));
 try{
  const file=path.join(dir,'notes.md');
  await writeFile(file,'private');
  // What the gateway forwards for a view-scope caller, whatever they sent.
  const stamped=viewerNativePayload({command:'fs_read_file',args:{path:file,workspaceOnly:false}});
  assert.deepEqual(stamped,{command:'fs_read_file',args:{path:file,workspaceOnly:true}});
  await assert.rejects(nativeInvoke(stamped.command,stamped.args),/outside selected workspace/i);
  for(const command of ['fs_stat','fs_stat_many']){
   const payload=viewerNativePayload({command,args:{path:file,paths:[file]}});
   assert.equal(payload.args.workspaceOnly,true);
   await assert.rejects(nativeInvoke(payload.command,payload.args),/outside selected workspace/i);
  }
  // Other read commands pass through untouched; anything else is still forbidden.
  const log={command:'git_log',args:{repo:'/workspace/app'}};
  assert.equal(viewerNativePayload(log),log);
  assert.throws(()=>viewerNativePayload({command:'fs_write_file',args:{}}),/Forbidden/);
  assert.throws(()=>viewerNativePayload(undefined),/Forbidden/);
  assert.deepEqual(viewerNativePayload({command:'fs_stat'}),{command:'fs_stat',args:{workspaceOnly:true}});
 }finally{await rm(dir,{recursive:true,force:true});}
});
