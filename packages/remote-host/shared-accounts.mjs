import {open,rename,unlink} from 'node:fs/promises';import {constants} from 'node:fs';import {createHash,randomUUID} from 'node:crypto';import path from 'node:path';import {privateRead} from './credential-vault.mjs';
const valid=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const providers={git:'github',claude:'anthropic',codex:'openai'};
function validate(rows){
 if(!Array.isArray(rows)||rows.length>384)throw Error('Invalid shared account bindings');const seen=new Set();
 for(const row of rows){if(!row||Object.keys(row).some(k=>!['projectId','slot','accountId'].includes(k))||!valid(row.projectId)||!Object.hasOwn(providers,row.slot)||!valid(row.accountId)||seen.has(row.projectId+':'+row.slot))throw Error('Invalid shared account binding');seen.add(row.projectId+':'+row.slot);}
 return rows;
}
export class SharedAccounts {
 constructor(vault){this.vault=vault;this.pending=new Map();}
 file(workspaceId){this.vault.location(workspaceId,'binding-validation');return path.join(this.vault.root,createHash('sha256').update(JSON.stringify(['bindings',workspaceId])).digest('hex')+'.bindings.json');}
 async list(workspaceId){try{return validate(JSON.parse((await privateRead(this.file(workspaceId),65536)).toString()));}catch(error){if(error.code==='ENOENT')return [];throw Error('Shared account bindings are unavailable');}}
 async resolve(workspaceId,projectId,slot){return (await this.list(workspaceId)).find(row=>row.projectId===projectId&&row.slot===slot)?.accountId;}
 async mutate(workspaceId,change){
  const previous=this.pending.get(workspaceId)??Promise.resolve();const operation=previous.catch(()=>{}).then(async()=>{
   const file=this.file(workspaceId),rows=validate(await change(await this.list(workspaceId))),temporary=path.join(this.vault.root,'.bindings-'+randomUUID());let handle;
   try{handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(JSON.stringify(rows));await handle.sync();await handle.close();handle=null;await rename(temporary,file);const directory=await open(this.vault.root,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}return rows;}
   finally{await handle?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  });this.pending.set(workspaceId,operation);try{return await operation;}finally{if(this.pending.get(workspaceId)===operation)this.pending.delete(workspaceId);}
 }
 async bind(workspaceId,projectId,slot,accountId){
  validate([{projectId,slot,accountId}]);const credential=await this.vault.load(accountId,{workspaceId});if(credential.provider!==providers[slot])throw Error('Shared account provider does not match');
  return this.mutate(workspaceId,rows=>[...rows.filter(row=>row.projectId!==projectId||row.slot!==slot),{projectId,slot,accountId}]);
 }
 async unbind(workspaceId,projectId,slot){if(!valid(projectId)||!Object.hasOwn(providers,slot))throw Error('Invalid shared account binding');return this.mutate(workspaceId,rows=>rows.filter(row=>row.projectId!==projectId||row.slot!==slot));}
 async remove(workspaceId,accountId){if(!valid(accountId))throw Error('Invalid shared account');await this.mutate(workspaceId,rows=>rows.filter(row=>row.accountId!==accountId));await this.vault.remove(workspaceId,accountId);}
}
