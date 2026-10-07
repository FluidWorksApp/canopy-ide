// This root-only bootstrap migration does not relax the runtime's generic
// retained-file reader. It adopts exactly private management metadata after
// validating its workspace identity, then the normal service handoff follows.
export async function adoptRetainedManagementOwner({open,constants,merge,incoming}){
 const handles=[];const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
 const reject=()=>{throw Error('Unsafe retained management metadata');};
 const privateRootDirectory=info=>info.isDirectory()&&info.uid===0&&(info.mode&0o022)===0;
 try{
  const srv=await open('/srv',directoryFlags);handles.push(srv);if(!privateRootDirectory(await srv.stat()))reject();
  const mount=await open(`/proc/self/fd/${srv.fd}/canopy`,directoryFlags);handles.push(mount);if(!privateRootDirectory(await mount.stat()))reject();
  const directory=await open(`/proc/self/fd/${mount.fd}/host-state`,directoryFlags);handles.push(directory);const owner=await directory.stat();
  if(!owner.isDirectory()||(owner.mode&0o077)!==0||!Number.isSafeInteger(owner.uid)||owner.uid<0||owner.uid>=1000)reject();
  let file;try{file=await open(`/proc/self/fd/${directory.fd}/host-config.json`,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!file){await directory.chown(0,0);await directory.sync();return;}
  handles.push(file);const info=await file.stat();
  const managementOwner=info.uid===0||info.uid===owner.uid||(owner.uid===0&&Number.isSafeInteger(info.uid)&&info.uid>0&&info.uid<1000);
  if(!info.isFile()||info.nlink!==1||info.size>1024*1024||(info.mode&0o077)!==0||!managementOwner)reject();
  // Existing validation rejects cross-workspace/member metadata and regressed
  // generations before any ownership changes. Preserve the original bytes.
  merge(incoming,JSON.parse(await file.readFile('utf8')));
  await directory.chown(0,0);await file.chown(0,0);
  // Holding the directory fd and checking its named inode prevents a replaced
  // file from becoming the configuration consumed by the strict normal reader.
  const named=await open(`/proc/self/fd/${directory.fd}/host-config.json`,constants.O_RDONLY|constants.O_NOFOLLOW);handles.push(named);const current=await named.stat();
  if(current.dev!==info.dev||current.ino!==info.ino||current.uid!==0||current.nlink!==1)reject();
  await file.sync();await directory.sync();
 }finally{for(const handle of handles.reverse())await handle.close();}
}
export const RETAINED_OWNER_MIGRATION_SCRIPT=`import {open} from 'node:fs/promises';import {constants} from 'node:fs';import {mergeRetainedHostConfig as merge} from '/opt/canopy-host/retained-host-config.mjs';
if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Retained ownership migration requires management root');
const incoming=JSON.parse(Buffer.from(process.argv[1]??'','base64').toString('utf8'));
await (${adoptRetainedManagementOwner.toString()})({open,constants,merge,incoming});`;
