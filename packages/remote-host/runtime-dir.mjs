// Root-side publishing into /run/canopy for the unprivileged gateway to read.
// The directory is created by systemd-tmpfiles (canopy-runtime.tmpfiles.conf);
// a root service that starts first only repairs it to the same mode. Modes are
// set explicitly because a caller's umask (the bootstrap runs with 077) would
// otherwise make a published file or the directory unreadable to the gateway.
import {chmod,mkdir,rename,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
export const RUNTIME_DIR='/run/canopy';
export async function ensureRuntimeDir({dir=RUNTIME_DIR,fs={mkdir,chmod}}={}){
 await fs.mkdir(dir,{recursive:true,mode:0o755});
 await fs.chmod(dir,0o755);
}
// Atomic, world-readable (0644) status file. Holds no secrets by contract.
export async function publishRuntimeFile(file,value,{dir=dirname(file),fs={mkdir,chmod,writeFile,rename}}={}){
 await ensureRuntimeDir({dir,fs});
 const temp=`${file}.${process.pid}.tmp`;
 await fs.writeFile(temp,typeof value==='string'?value:JSON.stringify(value),{mode:0o644});
 await fs.chmod(temp,0o644);
 await fs.rename(temp,file);
}
