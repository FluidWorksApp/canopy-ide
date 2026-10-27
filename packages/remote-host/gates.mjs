// The Linux workspace's half of rules-as-gates. canopy-hook runs inside the VM
// (/usr/local/bin/canopy-hook) and reads ~/.canopy/policy/<hash>.json there,
// so the policy the desktop's Rules panel approves has to be written HERE, not
// on the computer showing the IDE. Same file format and same key as
// src-tauri/src/gates.rs (`policy_path`, `grant_once`); a test pins the hash.
import {mkdir,readFile,writeFile,rename,realpath} from 'node:fs/promises';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import path from 'node:path';

export const APPROVAL_TTL_MS=10*60*1000;
const GATE_TYPES=new Set(['deny-path-write','deny-command','require-confirm','protect-tests','package-allowlist','package-denylist','egress-allowlist']);
export const rootHash=canonical=>createHash('sha256').update(canonical).digest('hex').slice(0,32);
// Approve-once tokens are signed with a key the hook verifies (gates.rs
// `grant_once`/`consume_once`): same message, same key file, so a token minted
// here opens exactly what the desktop's would and a file dropped into the
// approvals folder by anything else opens nothing.
export const tokenMac=(secret,key,expiresAt)=>createHmac('sha256',secret).update(`canopy-approve-once\n${key}\n${expiresAt}`).digest('hex');

async function atomic(file,data){
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const temporary=file+'.'+randomUUID()+'.next';
 await writeFile(temporary,data,{mode:0o600,flag:'wx'});await rename(temporary,file);
}

export class WorkspaceGates{
 constructor({home,run}){this.home=home;this.run=run;this.dir=path.join(home,'.canopy','policy');this.keyFile=path.join(home,'.canopy','keys','gate-approval.key');}
 async signingKey(){
  try{const key=Buffer.from((await readFile(this.keyFile,'utf8')).trim(),'hex');if(key.length>=32)return key;}catch(e){if(e.code!=='ENOENT')throw e;}
  await mkdir(path.dirname(this.keyFile),{recursive:true,mode:0o700});
  try{await writeFile(this.keyFile,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  return Buffer.from((await readFile(this.keyFile,'utf8')).trim(),'hex');
 }
 // The ledger's canonical root: the parent of the repo's common git dir,
 // exactly as `ledger::canonical_root` computes it on the desktop.
 async canonicalRoot(cwd){
  try{const common=(await this.run('git',['rev-parse','--git-common-dir'],cwd)).trim();const absolute=path.isAbsolute(common)?common:path.join(cwd,common);return path.dirname(await realpath(absolute));}
  catch{try{return await realpath(cwd);}catch{return String(cwd).replace(/[\\/]+$/,'');}}
 }
 async policyFile(cwd){const root=await this.canonicalRoot(cwd);return {root,file:path.join(this.dir,rootHash(root)+'.json')};}
 async write(cwd,policy){
  if(!policy||typeof policy!=='object'||!Array.isArray(policy.gates))throw Error('Invalid policy');
  const {root,file}=await this.policyFile(cwd);
  // Only the enforceable DSL reaches the hook; anything else is dropped here
  // rather than trusted to the hook's parser.
  const gates=policy.gates.filter(g=>g&&typeof g.id==='string'&&typeof g.rule==='string'&&GATE_TYPES.has(g.gate?.type));
  const guidance=(Array.isArray(policy.guidance)?policy.guidance:[]).filter(g=>typeof g==='string').slice(0,50);
  const value={version:1,root,updatedAt:Date.now(),trifecta:policy.trifecta==='block'?'block':'warn',gates,guidance};
  const data=JSON.stringify(value,null,2);if(Buffer.byteLength(data)>262144)throw Error('Policy is too large');
  await atomic(file,data);return file;
 }
 async read(cwd){const {file}=await this.policyFile(cwd);try{return JSON.parse(await readFile(file,'utf8'));}catch{return null;}}
 async allowOnce(key){
  if(!/^[0-9a-f]{32}$/.test(String(key)))throw Error('Not an approval key');
  const expiresAt=Date.now()+APPROVAL_TTL_MS;
  await atomic(path.join(this.dir,'approvals',key+'.json'),JSON.stringify({expiresAt,mac:tokenMac(await this.signingKey(),key,expiresAt)}));
 }
 invoke(command,args){
  if(command==='gates_policy_write')return this.write(args.cwd,args.policy);
  if(command==='gates_policy_read')return this.read(args.cwd);
  if(command==='gates_allow_once')return this.allowOnce(args.key);
  throw Error('Unknown gates command');
 }
}
