type Invoke = <T>(command:string,args:Record<string,unknown>)=>Promise<T>;

export async function saveRemoteContextImage(invoke:Invoke,dir:unknown,png:unknown):Promise<string>{
 if(typeof dir!=='string'||(dir!=='/workspace'&&!dir.startsWith('/workspace/'))||dir.split('/').includes('..')||dir.includes('\0'))throw Error('Choose a directory in the remote workspace');
 if(typeof png!=='string'||png.length>24*1024*1024||png.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(png))throw Error('Invalid screenshot PNG');
 const raw=atob(png);
 if(btoa(raw)!==png||!raw.startsWith('\x89PNG\r\n\x1a\n'))throw Error('Invalid screenshot PNG');
 const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 const folder=dir.replace(/\/+$/,'')+'/.canopy/attachments';
 const path=folder+'/screenshot-'+crypto.randomUUID()+'.png';
 await invoke('fs_upload_dir',{path:folder});
 const {id}=await invoke<{id:string}>('fs_upload_begin',{path,size:bytes.length,mode:0o600});
 try{
  for(let offset=0;offset<raw.length;offset+=256*1024){
   const chunk=raw.slice(offset,offset+256*1024);
   const ack=await invoke<{written:number}>('fs_upload_chunk',{id,offset,b64:btoa(chunk)});
   if(ack.written!==offset+chunk.length)throw Error('Screenshot upload was not confirmed');
  }
  const result=await invoke<{path:string;size:number}>('fs_upload_finish',{id,sha256:hash});
  if(result.path!==path||result.size!==bytes.length)throw Error('Screenshot save was not confirmed');
  return path;
 }catch(error){await invoke('fs_upload_abort',{id}).catch(()=>{});throw error;}
}
