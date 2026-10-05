import {mkdir,lstat,open,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomBytes,randomUUID,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import path from 'node:path';
const accountId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
function binding(workspaceId,account){
 if(typeof workspaceId!=='string'||!/^ws-[a-f0-9-]{36}$/.test(workspaceId)||!accountId(account))throw Error('Invalid vault binding');
 return JSON.stringify([workspaceId,account]);
}
export async function privateRead(file,max){
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await handle.stat();if(!s.isFile()||(s.mode&0o077)||s.uid!==process.getuid()||s.size>max)throw Error('Vault file is not private');return await handle.readFile();}finally{await handle.close();}
}
export class CredentialVault {
 static async initialize(root){
  await mkdir(root,{recursive:true,mode:0o700});
  const s=await lstat(root);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid())throw Error('Vault directory is not private');
  const keyPath=path.join(root,'vault.key');let handle;
  try{handle=await open(keyPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(randomBytes(32));await handle.sync();}
  catch(error){if(error.code!=='EEXIST')throw error;}finally{await handle?.close();}
  const key=await privateRead(keyPath,32);if(key.length!==32)throw Error('Invalid vault key');return new CredentialVault(root,key);
 }
 constructor(root,key){this.root=root;this.key=key;this.pending=new Map();}
 serialize(workspaceId,account,action){const key=binding(workspaceId,account),prior=this.pending.get(key)??Promise.resolve();const next=prior.catch(()=>{}).then(action);this.pending.set(key,next);void next.finally(()=>{if(this.pending.get(key)===next)this.pending.delete(key);}).catch(()=>{});return next;}
 location(workspaceId,account){const aad=binding(workspaceId,account);return {aad,file:path.join(this.root,createHash('sha256').update(aad).digest('hex')+'.json')};}
 async store(workspaceId,account,credential){return this.serialize(workspaceId,account,()=>this.writeCredential(workspaceId,account,credential));}
 async renew(workspaceId,account,refresh){return this.serialize(workspaceId,account,async()=>{const saved=await this.load(account,{workspaceId});const next=await refresh(saved);if(next===saved)return saved;const {workspaceId:_,accountId:__,...credential}=next;await this.writeCredential(workspaceId,account,credential);return {...credential,workspaceId,accountId:account};});}
 async writeCredential(workspaceId,account,credential){
  if(!credential||!['github','anthropic','openai'].includes(credential.provider)||typeof credential.token!=='string'||!credential.token||credential.token.length>8192||/[\r\n]/.test(credential.token))throw Error('Invalid shared credential');
  if(credential.provider==='github'&&(! /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[-\w.]{1,100}$/.test(credential.repository??'')||['.','..'].includes(credential.repository?.split('/')[1])))throw Error('Invalid Git repository');
  if(credential.provider!=='github'&&credential.repository!==undefined)throw Error('Invalid agent credential fields');
  if(credential.authType!==undefined&&credential.authType!=='oauth')throw Error('Invalid authentication type');
  if(credential.authType==='oauth'){if(credential.provider==='github'||typeof credential.refreshToken!=='string'||!credential.refreshToken||credential.refreshToken.length>8192||/[\r\n]/.test(credential.refreshToken)||!Number.isSafeInteger(credential.expiresAt)||credential.expiresAt<1||credential.provider==='openai'&&(typeof credential.providerAccountId!=='string'||!/^[\w-]{1,128}$/.test(credential.providerAccountId)))throw Error('Invalid subscription credential');}
  else if(['refreshToken','expiresAt','providerAccountId'].some(k=>credential[k]!==undefined))throw Error('Invalid API credential fields');
  if(Object.keys(credential).some(k=>!['provider','token','repository','authType','refreshToken','expiresAt','providerAccountId'].includes(k)))throw Error('Invalid shared credential fields');
  const {aad,file}=this.location(workspaceId,account),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(aad));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(credential)),cipher.final()]);
  const value=JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')});
  const temporary=path.join(this.root,'.'+randomUUID());let handle;
  try{handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(value);await handle.sync();await handle.close();handle=null;await rename(temporary,file);const directory=await open(this.root,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}
  finally{await handle?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 }
 async load(account,context){
  const {aad,file}=this.location(context.workspaceId,account);
  try{const envelope=JSON.parse((await privateRead(file,32768)).toString());if(envelope.version!==1)throw Error('Invalid envelope');
   const iv=Buffer.from(envelope.iv,'base64'),tag=Buffer.from(envelope.tag,'base64');if(iv.length!==12||tag.length!==16)throw Error('Invalid envelope');
   const decipher=createDecipheriv('aes-256-gcm',this.key,iv);decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(tag);
   const credential=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString());
   return {...credential,workspaceId:context.workspaceId,accountId:account};
  }catch{throw Error('Shared credential is unavailable');}
 }
 async remove(workspaceId,account){return this.serialize(workspaceId,account,async()=>{const {file}=this.location(workspaceId,account);await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});});}
}
