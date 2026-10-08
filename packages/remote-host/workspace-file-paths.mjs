import path from 'node:path';
import {realpath} from 'node:fs/promises';

// File-editor access can include private runtime scratch; project execution,
// repository operations and configured component roots remain workspace-only.
export async function resolveWorkspacePath(value,{workspace='/workspace',scratch,create=false}={}){
 if(typeof value!=='string'||value.includes('\0'))throw Error('Invalid workspace path');
 const roots=[workspace,...(scratch?[scratch]:[])];
 const inside=target=>roots.some(root=>target===root||target.startsWith(root+'/'));
 const candidate=path.resolve(workspace,value);
 if(!inside(candidate))throw Error('Path outside selected workspace');
 let resolved;
 try{resolved=await realpath(candidate);}catch(error){if(!create||error.code!=='ENOENT')throw error;resolved=path.join(await realpath(path.dirname(candidate)),path.basename(candidate));}
 if(!inside(resolved))throw Error('Symlink outside selected workspace');
 return resolved;
}
