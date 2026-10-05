import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
function proofValue(proof,key,expected,now){
 if(typeof proof!=='string'||proof.length>4096)throw Error('Idle proof unavailable');
 const [payload,signature,extra]=proof.split('.');if(extra||!payload||!/^[A-Za-z0-9_-]+$/.test(payload)||!/^[A-Za-z0-9_-]{43}$/.test(signature??''))throw Error('Idle proof unavailable');
 const expectedSignature=createHmac('sha256',key).update(payload).digest(),actual=Buffer.from(signature,'base64url');if(actual.length!==expectedSignature.length||!timingSafeEqual(actual,expectedSignature))throw Error('Idle proof unavailable');
 const c=JSON.parse(Buffer.from(payload,'base64url').toString()),keys=['version','purpose','workspaceId','generation','instanceName','nonce','idle','expiresAt'];
 if(!c||Object.keys(c).length!==keys.length||keys.some(k=>!Object.hasOwn(c,k))||c.version!==1||c.purpose!==expected.purpose||c.idle!==true||c.workspaceId!==expected.workspaceId||c.generation!==expected.generation||c.instanceName!==expected.instanceName||c.nonce!==expected.nonce||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+35000)throw Error('Idle proof unavailable');
}
// An empty user-container activity reply is never a shutdown authority. Caller
// holds the workspace row lock; connection admission is ordered against it.
export async function trustedWorkspaceIdle(db,workspace,{provider,key,token,expectedEndpoint,request,ownerClosing=false,nonce=()=>randomBytes(32).toString('hex'),now=Date.now}){
 if(workspace.provider!=='lightsail'||workspace.state!=='ready'||workspace.desired_state!=='running'||workspace.deleted_at||workspace.endpoint!==expectedEndpoint||!workspace.instance_name||!Number.isSafeInteger(Number(workspace.generation)))return {accepted:false,reason:'Workspace status is not ready'};
 if((await db.query('SELECT 1 FROM connection_lease WHERE workspace_id=$1 AND expires_at>now() LIMIT 1',[workspace.id])).rows.length)return {accepted:false,reason:'An IDE is connected'};
 try{
  const instance=await provider.instance(workspace.instance_name);
  if(!instance||instance.name!==workspace.instance_name||instance.state?.name!=='running'||!instance.tags?.some(t=>t.key==='canopy-workspace'&&t.value===workspace.id)||!instance.tags?.some(t=>t.key==='managed-by'&&t.value==='canopy'))throw Error('Machine identity unavailable');
  const expected={purpose:ownerClosing?'workspace-owner-close':'workspace-idle',workspaceId:workspace.id,generation:Number(workspace.generation),instanceName:workspace.instance_name,nonce:nonce()};
  const response=await request(expectedEndpoint+'/v1/workspaces/'+workspace.id+(ownerClosing?'/close-attestation':'/idle-attestation'),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({nonce:expected.nonce,generation:expected.generation,instanceName:expected.instanceName}),signal:AbortSignal.timeout(8000)});
  if(!response.ok||response.headers.get('x-canopy-instance')!==expected.instanceName)throw Error('Idle status unavailable');
  const result=await response.json();if(result.idle!==true)return {accepted:false,reason:ownerClosing?'Shared jobs or sessions are still active. Use Stop workspace to interrupt them.':'Workspace activity remains'};
  proofValue(result.proof,key,expected,now());
  return {accepted:true};
 }catch{return {accepted:false,reason:'Automatic shutdown could not be confirmed. Use Stop workspace.'};}
}
