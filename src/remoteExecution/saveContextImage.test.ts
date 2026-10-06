import {it,expect,vi} from 'vitest';
import {createHash,webcrypto} from 'node:crypto';
import {saveRemoteContextImage} from './saveContextImage';
import {mkdtemp,readFile,stat,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error The production Linux receiver is a JavaScript module.
import {WorkspaceUploads} from '../../packages/remote-host/file-upload.mjs';

it('saves byte-identical private PNG files through the production receiver',async()=>{
 vi.stubGlobal('crypto',webcrypto);
 const root=await mkdtemp(join(tmpdir(),'canopy-context-image-'));
 const receiver=new WorkspaceUploads(root);
 const bytes=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(800000,23)]);
 const invoke=async<T,>(command:string,args:Record<string,unknown>):Promise<T>=>{
  const local={...args};
  if(typeof local.path==='string')local.path=root+local.path.slice('/workspace'.length);
  const result=await receiver.invoke(command,local);
  if(result?.path)result.path='/workspace'+result.path.slice(root.length);
  return result as T;
 };
 try{
  const path=await saveRemoteContextImage(invoke,'/workspace/project',bytes.toString('base64'));
  const file=root+path.slice('/workspace'.length);
  expect(await readFile(file)).toEqual(bytes);
  expect((await stat(file)).mode&0o777).toBe(0o600);
  expect(await readdir(root+'/.canopy-uploads')).toEqual([]);
 }finally{vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});}
});

it('uploads a large screenshot in bounded chunks and verifies its saved path',async()=>{
 vi.stubGlobal('crypto',webcrypto);
 const bytes=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(600000,7)]);
 let destination='';let written=0;const parts:Buffer[]=[];
 const invoke=vi.fn(async(command:string,args:Record<string,unknown>):Promise<any>=>{
  if(command==='fs_upload_begin'){destination=String(args.path);expect(args.size).toBe(bytes.length);expect(args.mode).toBe(0o600);return {id:'upload'};}
  if(command==='fs_upload_chunk'){expect(args.offset).toBe(written);const chunk=Buffer.from(String(args.b64),'base64');expect(chunk.length).toBeLessThanOrEqual(256*1024);parts.push(chunk);written+=chunk.length;return {written};}
  if(command==='fs_upload_finish'){expect(args.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));return {path:destination,size:written};}
 });
 try{expect(await saveRemoteContextImage(invoke,'/workspace/project',bytes.toString('base64'))).toMatch(/^\/workspace\/project\/\.canopy\/attachments\/screenshot-.*\.png$/);expect(Buffer.concat(parts)).toEqual(bytes);}finally{vi.unstubAllGlobals();}
});
it('rejects invalid paths and images before making requests',async()=>{
 const invoke=vi.fn();const png=Buffer.from('89504e470d0a1a0a','hex').toString('base64');
 await expect(saveRemoteContextImage(invoke,'/workspace/../private',png)).rejects.toThrow();
 await expect(saveRemoteContextImage(invoke,'/workspace','not png')).rejects.toThrow();
 expect(invoke).not.toHaveBeenCalled();
});
it('aborts an upload when the receiver does not confirm a chunk',async()=>{
 vi.stubGlobal('crypto',webcrypto);
 const invoke=vi.fn(async(command:string):Promise<any>=>command==='fs_upload_begin'?{id:'upload'}:{written:0});
 try{await expect(saveRemoteContextImage(invoke,'/workspace',Buffer.from('89504e470d0a1a0a','hex').toString('base64'))).rejects.toThrow('not confirmed');expect(invoke).toHaveBeenLastCalledWith('fs_upload_abort',{id:'upload'});}finally{vi.unstubAllGlobals();}
});
