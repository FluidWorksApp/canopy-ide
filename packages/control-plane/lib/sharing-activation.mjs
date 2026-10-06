import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
const reject=message=>{throw Object.assign(Error(message),{code:409});};
export function verifySharingProof(proof,key,expected,now=Date.now()){
 if(typeof proof!=='string'||proof.length>4096||typeof key!=='string'||key.length<32)reject('Sharing readiness proof is invalid');
 const [payload,signature,extra]=proof.split('.');
 if(extra||!payload||!signature||!/^[A-Za-z0-9_-]+$/.test(payload)||!/^[A-Za-z0-9_-]{43}$/.test(signature))reject('Sharing readiness proof is invalid');
 const actual=Buffer.from(signature,'base64url'),wanted=createHmac('sha256',key).update(payload).digest();
 if(actual.length!==wanted.length||!timingSafeEqual(actual,wanted))reject('Sharing readiness proof is invalid');
 let value;try{value=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{reject('Sharing readiness proof is invalid');}
 const keys=['version','purpose','workspaceId','generation','instanceName','nonce','catalogHash','expiresAt'];
 if(!value||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))||value.version!==1||value.purpose!=='sharing-ready'||
 value.workspaceId!==expected.workspaceId||value.generation!==expected.generation||value.instanceName!==expected.instanceName||value.nonce!==expected.nonce||
 !/^[a-f0-9]{64}$/.test(value.catalogHash)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+35000)reject('Sharing readiness proof is stale or belongs to another workspace');
 return value;
}
function safeProjects(projects){
 const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v),name=v=>typeof v==='string'&&v.trim()&&v.length<=200&&!/[\x00-\x1f]/.test(v);
 if(!Array.isArray(projects)||!projects.length||projects.length>128)reject('Shared project catalog is invalid');
 const seen=new Set();
 return projects.map(p=>{if(!id(p?.id)||seen.has(p.id)||!name(p.name)||!Array.isArray(p.components)||!p.components.length||p.components.length>64)reject('Shared project catalog is invalid');seen.add(p.id);const components=new Set();return {id:p.id,name:p.name,components:p.components.map(c=>{if(!id(c?.id)||components.has(c.id)||!name(c.name))reject('Shared project catalog is invalid');components.add(c.id);return {id:c.id,name:c.name};})};});
}
// Caller holds the owner-authorized row lock. The proof is fetched by the
// server with a fresh nonce, never accepted from a browser or user container.
export async function activateWorkspaceSharing(db,userId,workspace,{key,expectedEndpoint,provider,request,token,now=Date.now,nonce=()=>randomBytes(32).toString('hex')}){
 const generation=Number(workspace.generation);
 if(workspace.owner_id!==userId||workspace.provider!=='lightsail'||workspace.state!=='ready'||workspace.desired_state!=='running'||workspace.deleted_at||
 !Number.isSafeInteger(generation)||generation<0||workspace.endpoint!==expectedEndpoint||!workspace.instance_name)reject('Start the workspace before enabling sharing');
 const instance=await provider.instance(workspace.instance_name);
 if(!instance||instance.name!==workspace.instance_name||instance.state?.name!=='running'||!instance.tags?.some(t=>t.key==='canopy-workspace'&&t.value===workspace.id)||!instance.tags?.some(t=>t.key==='managed-by'&&t.value==='canopy'))reject('Workspace machine identity could not be confirmed');
 const expected={workspaceId:workspace.id,generation,instanceName:workspace.instance_name,nonce:nonce()};
 const response=await request(`${expectedEndpoint}/v1/workspaces/${workspace.id}/sharing-setup`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({action:'attest',nonce:expected.nonce,generation,instanceName:expected.instanceName}),signal:AbortSignal.timeout(8000)});
 if(!response.ok||response.headers.get('x-canopy-instance')!==expected.instanceName)reject('Shared workspace setup is not ready');
 const result=await response.json(),proof=verifySharingProof(result.proof,key,expected,now()),projects=safeProjects(result.projects);
 const changed=await db.query("UPDATE workspace SET sharing_generation=$2 WHERE id=$1 AND owner_id=$3 AND generation=$2 AND state='ready' AND desired_state='running' AND instance_name=$4 AND endpoint=$5 AND provider='lightsail' AND deleted_at IS NULL RETURNING id",[workspace.id,generation,userId,expected.instanceName,expectedEndpoint]);
 if(changed.rows.length!==1)reject('Workspace changed while sharing was being enabled');
 return {activated:true,projects,catalogHash:proof.catalogHash};
}
