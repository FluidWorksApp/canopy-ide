import {open,mkdir,lstat,readdir,unlink,link} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export const UPLOAD_CHUNK_BYTES=256*1024;
const MAX_FILE_BYTES=16*1024**3, IDLE_MS=15*60*1000;

export class WorkspaceUploads {
  constructor(root,now=Date.now) { this.root=path.resolve(root);this.now=now;this.active=new Map();this.pending=0; }
  async destination(value,createDirectory=false) {
    if(typeof value!=='string'||value.includes('\0'))throw Error('Invalid upload path');
    const candidate=path.resolve(this.root,value);
    if(candidate!==this.root&&!candidate.startsWith(this.root+'/'))throw Error('Upload outside selected workspace');
    const parts=path.relative(this.root,candidate).split('/').filter(Boolean);
    if(parts.includes('.canopy-uploads'))throw Error('Reserved upload directory');
    let current=this.root;
    if((await lstat(current)).isSymbolicLink())throw Error('Upload directory must not be a symlink');
    for(let i=0;i<parts.length;i++){
      current=path.join(current,parts[i]);let metadata;
      try{metadata=await lstat(current);}catch(error){
        if(error.code!=='ENOENT')throw error;
        if(createDirectory){await mkdir(current,{mode:0o700});metadata=await lstat(current);}
        else if(i===parts.length-1)return current;
        else throw Error('Choose an existing upload directory');
      }
      if(metadata.isSymbolicLink())throw Error('Upload path must not be a symlink');
      if((createDirectory||i<parts.length-1)&&!metadata.isDirectory())throw Error('Upload directory is not a folder');
    }
    return candidate;
  }
  async sweep() {
    for(const [id,entry] of this.active)if(!entry.busy&&this.now()-entry.touched> IDLE_MS)await this.abort(id);
    const folder=path.join(this.root,'.canopy-uploads');
    let files;try{files=await readdir(folder);}catch(e){if(e.code==='ENOENT')return;throw e;}
    if((await lstat(folder)).isSymbolicLink())throw Error('Upload directory must not be a symlink');
    const live=new Set([...this.active.values()].map(e=>path.basename(e.temporary)));
    for(const name of files.slice(0,4096))if(/^[a-f0-9-]{36}\.part$/.test(name)&&!live.has(name)){
      const file=path.join(folder,name);const info=await lstat(file);
      if(this.now()-info.mtimeMs>IDLE_MS)await unlink(file);
    }
  }
  async abort(id) {
    const entry=this.active.get(id);if(!entry)return;
    if(entry.busy)throw Error('Upload operation still in progress');
    this.active.delete(id);await entry.handle.close();await unlink(entry.temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
  async invoke(command,args) {
    await this.sweep();
    if(command==='fs_upload_dir'){await this.destination(args.path,true);return;}
    if(command==='fs_upload_begin'){
      if(this.active.size+this.pending>=4)throw Error('Too many active uploads');
      this.pending++;
      try{
      if(!Number.isSafeInteger(args.size)||args.size<0||args.size>MAX_FILE_BYTES)throw Error('Upload file exceeds 16 GiB limit');
      const destination=await this.destination(args.path);
      try{await lstat(destination);throw Error('File already exists; existing file was kept');}catch(e){if(e.code!=='ENOENT')throw e;}
      const folder=path.join(this.root,'.canopy-uploads');await mkdir(folder,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
      if(!(await lstat(folder)).isDirectory()||(await lstat(folder)).isSymbolicLink())throw Error('Upload directory must not be a symlink');
      const id=randomUUID(),temporary=path.join(folder,id+'.part');
      const handle=await open(temporary,'wx',0o600);
      this.active.set(id,{handle,temporary,destination,size:args.size,mode:Number.isInteger(args.mode)?args.mode&0o777:0o600,written:0,hash:createHash('sha256'),touched:this.now(),busy:false});
      return {id};
      }finally{this.pending--;}
    }
    if(command==='fs_upload_abort'){await this.abort(args.id);return;}
    const entry=this.active.get(args.id);if(!entry)throw Error('Upload expired or unavailable');
    if(entry.busy)throw Error('Upload operation still in progress');
    entry.busy=true;entry.touched=this.now();
    try{
      if(command==='fs_upload_chunk'){
        if(args.offset!==entry.written||typeof args.b64!=='string'||args.b64.length>Math.ceil(UPLOAD_CHUNK_BYTES/3)*4||args.b64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(args.b64))throw Error('Invalid upload chunk');
        const bytes=Buffer.from(args.b64,'base64');
        if(bytes.toString('base64')!==args.b64||!bytes.length||bytes.length>UPLOAD_CHUNK_BYTES||entry.written+bytes.length>entry.size)throw Error('Invalid upload chunk');
        let written=0;while(written<bytes.length){const result=await entry.handle.write(bytes,written,bytes.length-written,entry.written+written);if(!result.bytesWritten)throw Error('Upload write failed');written+=result.bytesWritten;}
        entry.hash.update(bytes);entry.written+=bytes.length;return {written:entry.written};
      }
      if(command!=='fs_upload_finish')throw Error('Unknown upload operation');
      if(entry.written!==entry.size||typeof args.sha256!=='string'||entry.hash.digest('hex')!==args.sha256)throw Error('Upload integrity check failed');
      if(await this.destination(entry.destination)!==entry.destination)throw Error('Upload directory changed');
      await entry.handle.chmod(entry.mode);await entry.handle.sync();
      try{await link(entry.temporary,entry.destination);}catch(e){if(e.code==='EEXIST')throw Error('File already exists; existing file was kept');throw e;}
      this.active.delete(args.id);await entry.handle.close();await unlink(entry.temporary);
      return {path:entry.destination,size:entry.size};
    }catch(error){
      if(command==='fs_upload_finish') {this.active.delete(args.id);await entry.handle.close().catch(()=>{});await unlink(entry.temporary).catch(()=>{});}
      throw error;
    }finally{entry.busy=false;}
  }
}
