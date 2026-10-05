import {mkdir,lstat,open,readdir,unlink} from 'node:fs/promises';import {constants} from 'node:fs';import {randomBytes,createHmac,createHash,timingSafeEqual} from 'node:crypto';import path from 'node:path';import {privateRead} from './credential-vault.mjs';
const operations=new Set(['git:fetch','git:push','agents:claude','agents:codex']);
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
function validate(c,now){
 if(!c||Object.keys(c).sort().join(',')!=='accessVersion,accountId,advertise,bodySha256,expires,kind,memberId,nonce,operation,projectId,scope,version,workspaceId'||c.version!==1||c.kind!=='credential-execution'||!/^ws-[a-f0-9-]{36}$/.test(c.workspaceId??'')||typeof c.memberId!=='string'||!c.memberId||c.memberId.length>256||!Number.isSafeInteger(c.accessVersion)||c.accessVersion<1||!['drive','view'].includes(c.scope)||!id(c.projectId)||!id(c.accountId)||!operations.has(c.operation)||typeof c.advertise!=='boolean'||! /^[a-f0-9]{64}$/.test(c.bodySha256??'')||! /^[a-f0-9]{32}$/.test(c.nonce??'')||!Number.isSafeInteger(c.expires)||c.expires<=now||c.expires>now+30000)throw Error('Invalid credential ticket');
}
export class CredentialTickets {
 static async initialize(directory,key,options={}){
  if(typeof key!=='string'||key.length<32)throw Error('Invalid credential ticket key');await mkdir(directory,{recursive:true,mode:0o700});const s=await lstat(directory);
  if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid())throw Error('Credential ticket journal is not private');return new CredentialTickets(directory,key,options);
 }
 constructor(directory,key,{now=Date.now}={}){this.directory=directory;this.key=key;this.now=now;this.tail=Promise.resolve();}
 issue(principal,grant,{bodySha256,advertise=false}){
  const now=this.now();if(!Number.isFinite(principal?.expiresAt)||principal.expiresAt<=now||grant?.workspaceId!==principal.workspaceId||grant.memberId!==principal.memberId)throw Error('Forbidden');
  const claims={version:1,kind:'credential-execution',workspaceId:principal.workspaceId,memberId:principal.memberId,accessVersion:principal.accessVersion,scope:principal.scope,projectId:grant.projectId,operation:grant.operation,accountId:grant.accountId,bodySha256,advertise,nonce:randomBytes(16).toString('hex'),expires:Math.min(principal.expiresAt,now+30000)};validate(claims,now);
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return payload+'.'+createHmac('sha256',this.key).update(payload).digest('base64url');
 }
 async consume(token,principal,body,{advertise=false}={}){
  if(typeof token!=='string'||token.length>2048||!(body instanceof Uint8Array)||body.byteLength>4*1024*1024)throw Error('Invalid credential ticket');
  const [payload,signature,extra]=token.split('.');if(!payload||! /^[a-zA-Z0-9_-]{43}$/.test(signature??'')||extra)throw Error('Invalid credential ticket');
  const expected=createHmac('sha256',this.key).update(payload).digest();if(!timingSafeEqual(expected,Buffer.from(signature,'base64url')))throw Error('Invalid credential ticket');
  let claims;try{claims=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{throw Error('Invalid credential ticket');}validate(claims,this.now());
  if(!principal||!Number.isFinite(principal.expiresAt)||principal.expiresAt<=this.now()||['workspaceId','memberId','accessVersion','scope'].some(k=>principal[k]!==claims[k])||claims.bodySha256!==hash(body)||claims.advertise!==advertise)throw Error('Credential ticket context differs');
  const operation=this.tail.catch(()=>{}).then(async()=>{
   validate(claims,this.now());
   const entries=await readdir(this.directory);let count=0;
   for(const name of entries){if(!/^[a-f0-9]{32}\.json$/.test(name))throw Error('Credential ticket journal requires recovery');const file=path.join(this.directory,name);const saved=JSON.parse((await privateRead(file,128)).toString());if(!Number.isSafeInteger(saved.expires))throw Error('Credential ticket journal requires recovery');if(saved.expires<=this.now())await unlink(file);else count++;}
   if(count>=4096)throw Error('Credential ticket capacity reached');
   const file=path.join(this.directory,claims.nonce+'.json');let handle;
   try{handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(JSON.stringify({expires:claims.expires}));await handle.sync();}catch{throw Error('Credential ticket already used or unavailable');}finally{await handle?.close();}
   const directory=await open(this.directory,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
   return claims;
  });this.tail=operation;return operation;
 }
}
