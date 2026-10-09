// Canopy Slack hub: the only place a Slack token or a Slack request is handled.
// Protocol: canopy-ide docs/slack-hub-protocol.md. Mirrored byte-identical into
// canopy-ide packages/control-plane/lib/slack-hub.mjs.
import {createHmac,createCipheriv,createDecipheriv,randomBytes,timingSafeEqual} from 'node:crypto';
import {workspaceAccess,allowsWorkspaceAccess} from './workspace-access.mjs';

const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
export const NOT_CONFIGURED='Slack is not configured';
export const BOT_SCOPES=['app_mentions:read','chat:write','im:history','im:read','im:write','users:read'];
export const SIGNATURE_WINDOW_S=300,STATE_TTL_MS=10*60*1000,LEASE_SECONDS=120,APPROVAL_MINUTES=15,MAX_UNDELIVERED=200,POLL_LIMIT=20,MAX_TEXT=8000,MAX_REPLY=39000,UNLINKED_NOTICE_HOURS=6;
export const UNLINKED_TEXT='Link your Slack in Canopy (Settings → Companion → Slack) to talk to your companion here.';
const ITEM_ID=/^[A-Za-z0-9_-]{8,64}$/,SLACK_USER=/^[UW][A-Z0-9]{2,32}$/,SLACK_TEAM=/^[A-Z0-9]{2,32}$/,SLACK_CHANNEL=/^[CDG][A-Z0-9]{2,32}$/,SLACK_TS=/^\d{1,12}\.\d{1,8}$/,NONCE=/^[A-Za-z0-9_-]{22,64}$/;
const newId=()=>randomBytes(16).toString('base64url');

// CANOPY_SLACK_TOKEN_KEY never leaves the control plane, so the OAuth state
// key is derived from it rather than from the signing secret Slack also holds.
export function slackConfig(env=process.env){
 const clientId=env.CANOPY_SLACK_CLIENT_ID,clientSecret=env.CANOPY_SLACK_CLIENT_SECRET,signingSecret=env.CANOPY_SLACK_SIGNING_SECRET,rawKey=env.CANOPY_SLACK_TOKEN_KEY;
 if(!clientId||!clientSecret||!signingSecret||!rawKey)return null;
 const tokenKey=Buffer.from(rawKey,'base64');
 if(tokenKey.length!==32)return null;
 return {clientId,clientSecret,signingSecret,tokenKey,stateKey:createHmac('sha256',tokenKey).update('canopy-slack-oauth-state:v1').digest()};
}

// ---- Request signatures (v0) ----
export function slackSignature(signingSecret,timestamp,rawBody){
 return 'v0='+createHmac('sha256',signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest('hex');
}
export function verifySlackSignature({signingSecret,timestamp,signature,rawBody,now=Date.now()}){
 if(typeof timestamp!=='string'||!/^\d{1,12}$/.test(timestamp))return false;
 if(Math.abs(Math.floor(now/1000)-Number(timestamp))>SIGNATURE_WINDOW_S)return false;
 if(typeof signature!=='string'||!/^v0=[a-f0-9]{64}$/.test(signature))return false;
 const expected=Buffer.from(slackSignature(signingSecret,timestamp,rawBody).slice(3),'hex');
 return timingSafeEqual(Buffer.from(signature.slice(3),'hex'),expected);
}
// Vercel replays the request stream to data/end listeners, so this works with
// or without its body parser; the bytes must be exactly what Slack signed.
export function readRawBody(req,limit=1<<20){
 return new Promise((resolve,reject)=>{
  const chunks=[];let size=0,done=false;
  req.on('data',chunk=>{if(done)return;const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=b.length;if(size>limit){done=true;reject(Object.assign(Error('Request is too large'),{code:413}));}else chunks.push(b);});
  req.on('end',()=>{if(!done){done=true;resolve(Buffer.concat(chunks));}});
  req.on('error',error=>{if(!done){done=true;reject(error);}});
 });
}

// ---- OAuth state ----
const STATE_INVALID='This Slack link is invalid or has expired. Start again from Canopy.';
export function issueState(config,{kind,userId,now=Date.now(),nonce=newId()}){
 if(!['install','link'].includes(kind)||typeof userId!=='string'||!userId||userId.length>128)fail(400,'Invalid Slack request');
 const claims={kind,userId,nonce,expires:now+STATE_TTL_MS};
 const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
 return {state:payload+'.'+createHmac('sha256',config.stateKey).update(payload).digest('base64url'),claims};
}
export function verifyState(config,state,now=Date.now()){
 if(typeof state!=='string'||state.length>1024)fail(400,STATE_INVALID);
 const [payload,signature,extra]=state.split('.');
 if(extra!==undefined||!/^[A-Za-z0-9_-]+$/.test(payload??'')||!/^[A-Za-z0-9_-]{43}$/.test(signature??''))fail(400,STATE_INVALID);
 const actual=Buffer.from(signature,'base64url'),expected=createHmac('sha256',config.stateKey).update(payload).digest();
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))fail(400,STATE_INVALID);
 let c;try{c=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{fail(400,STATE_INVALID);}
 const keys=['kind','userId','nonce','expires'];
 if(!c||typeof c!=='object'||Object.keys(c).length!==keys.length||keys.some(k=>!Object.hasOwn(c,k))||!['install','link'].includes(c.kind)||typeof c.userId!=='string'||!c.userId||typeof c.nonce!=='string'||!NONCE.test(c.nonce)||!Number.isSafeInteger(c.expires)||c.expires<=now||c.expires>now+STATE_TTL_MS+5000)fail(400,STATE_INVALID);
 return c;
}
export function authorizeUrl(config,{kind,state,nonce,redirectUri}){
 if(kind==='install'){
  const q=new URLSearchParams({client_id:config.clientId,scope:BOT_SCOPES.join(','),redirect_uri:redirectUri,state});
  return 'https://slack.com/oauth/v2/authorize?'+q;
 }
 const q=new URLSearchParams({response_type:'code',scope:'openid profile',client_id:config.clientId,redirect_uri:redirectUri,state,nonce});
 return 'https://slack.com/openid/connect/authorize?'+q;
}
// Transaction optional. The nonce row makes the signed state single-use.
export async function startOAuth(db,config,userId,kind,{redirectUri,now=Date.now()}){
 const {state,claims}=issueState(config,{kind,userId,now});
 await db.query('DELETE FROM slack_oauth_state WHERE expires_at<now()');
 await db.query('INSERT INTO slack_oauth_state(nonce,user_id,kind,expires_at) VALUES($1,$2,$3,to_timestamp($4/1000.0))',[claims.nonce,userId,kind,claims.expires]);
 return {url:authorizeUrl(config,{kind,state,nonce:claims.nonce,redirectUri})};
}
async function consumeState(db,claims){
 const row=(await db.query('DELETE FROM slack_oauth_state WHERE nonce=$1 AND user_id=$2 AND kind=$3 AND expires_at>now() RETURNING nonce',[claims.nonce,claims.userId,claims.kind])).rows[0];
 if(!row)fail(400,STATE_INVALID);
}
function idTokenClaims(idToken){
 const part=typeof idToken==='string'?idToken.split('.')[1]:null;
 try{return JSON.parse(Buffer.from(part,'base64url').toString('utf8'));}catch{fail(502,'Slack sign-in returned an unreadable identity');}
}
export async function inTransaction(db,fn){await db.query('BEGIN');try{const r=await fn();await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}}
// Autocommit client (not inside a caller transaction): the state is consumed
// before the code exchange so a replayed callback can never link twice.
export async function completeOAuth(db,config,{state,code,error},{slack,redirectUri,now=Date.now(),transaction=inTransaction}){
 const claims=verifyState(config,state,now);
 await consumeState(db,claims);
 if(error||typeof code!=='string'||!code||code.length>512)fail(400,'Slack connection was cancelled.');
 const form={client_id:config.clientId,client_secret:config.clientSecret,code,redirect_uri:redirectUri};
 if(claims.kind==='install'){
  const r=await slack.api('oauth.v2.access',{form});
  const team=r.team?.id,teamName=r.team?.name,bot=r.bot_user_id,token=r.access_token,installer=r.authed_user?.id;
  if(!team)fail(400,'Enterprise-wide Slack installs are not supported. Install Canopy in a single workspace.');
  if(!SLACK_TEAM.test(team)||!SLACK_USER.test(bot??'')||typeof token!=='string'||!token.startsWith('xoxb-')||!SLACK_USER.test(installer??''))fail(502,'Slack returned an unexpected install response');
  const sealed=encryptToken(config.tokenKey,token,team);
  await db.query(`INSERT INTO slack_installation(team_id,team_name,bot_user_id,bot_token_ciphertext,bot_token_iv,bot_token_tag,installed_by) VALUES($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT(team_id) DO UPDATE SET team_name=EXCLUDED.team_name,bot_user_id=EXCLUDED.bot_user_id,bot_token_ciphertext=EXCLUDED.bot_token_ciphertext,bot_token_iv=EXCLUDED.bot_token_iv,bot_token_tag=EXCLUDED.bot_token_tag,installed_by=EXCLUDED.installed_by,updated_at=now()`,
  [team,String(teamName??team).slice(0,200),bot,sealed.ciphertext,sealed.iv,sealed.tag,claims.userId]);
  try{await transaction(db,()=>linkIdentity(db,claims.userId,team,installer));}
  catch(e){if(e.code===409)fail(409,`Canopy was added to ${String(teamName??team).slice(0,200)}, but ${e.message.charAt(0).toLowerCase()+e.message.slice(1)}`);throw e;}
  return {kind:'install',team,teamName:teamName??team};
 }
 const r=await slack.api('openid.connect.token',{form});
 const c=idTokenClaims(r.id_token);
 const team=c['https://slack.com/team_id'],user=c['https://slack.com/user_id'];
 if(c.iss!=='https://slack.com'||c.aud!==config.clientId||c.nonce!==claims.nonce||!Number.isFinite(c.exp)||c.exp*1000<now-60000||!SLACK_TEAM.test(team??'')||!SLACK_USER.test(user??''))fail(502,'Slack sign-in returned an unexpected identity');
 const install=(await db.query('SELECT team_name FROM slack_installation WHERE team_id=$1',[team])).rows[0];
 if(!install)fail(409,'Canopy is not installed in that Slack workspace yet. Install it from Canopy first.');
 await transaction(db,()=>linkIdentity(db,claims.userId,team,user));
 return {kind:'link',team,teamName:install.team_name};
}
// Transaction required.
async function linkIdentity(db,userId,team,slackUser){
 const existing=(await db.query('SELECT user_id FROM slack_identity WHERE team_id=$1 AND slack_user_id=$2 FOR UPDATE',[team,slackUser])).rows[0];
 if(existing&&existing.user_id!==userId)fail(409,'That Slack account is already linked to another Canopy account.');
 await db.query('DELETE FROM slack_identity WHERE user_id=$1 AND team_id=$2 AND slack_user_id<>$3',[userId,team,slackUser]);
 await db.query('INSERT INTO slack_identity(team_id,slack_user_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[team,slackUser,userId]);
}

// ---- Bot token storage (AES-256-GCM, bound to its team) ----
export function encryptToken(key,token,teamId){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('canopy-slack-bot-token:'+teamId));
 const ciphertext=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
 return {ciphertext:ciphertext.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
export function decryptToken(key,{ciphertext,iv,tag},teamId){
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));decipher.setAAD(Buffer.from('canopy-slack-bot-token:'+teamId));decipher.setAuthTag(Buffer.from(tag,'base64'));
 return Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64')),decipher.final()]).toString('utf8');
}
async function installation(db,config,team){
 const row=(await db.query('SELECT team_id,team_name,bot_user_id,bot_token_ciphertext,bot_token_iv,bot_token_tag FROM slack_installation WHERE team_id=$1',[team])).rows[0];
 if(!row)return null;
 return {team:row.team_id,teamName:row.team_name,botUserId:row.bot_user_id,token:decryptToken(config.tokenKey,{ciphertext:row.bot_token_ciphertext,iv:row.bot_token_iv,tag:row.bot_token_tag},row.team_id)};
}

// ---- Slack Web API transport (injectable; tests never touch the network) ----
export function slackTransport({fetch:send=globalThis.fetch,timeoutMs=2500}={}){
 return {
  async api(method,{token,body,form}={}){
   const headers={};let payload;
   if(form){headers['content-type']='application/x-www-form-urlencoded';payload=new URLSearchParams(form).toString();}
   else{headers['content-type']='application/json; charset=utf-8';payload=JSON.stringify(body??{});}
   if(token)headers.authorization='Bearer '+token;
   const res=await send('https://slack.com/api/'+method,{method:'POST',headers,body:payload,signal:AbortSignal.timeout(timeoutMs)});
   const data=await res.json().catch(()=>null);
   if(!data?.ok)throw Object.assign(Error(`Slack ${method} failed: ${data?.error??res.status}`),{slackError:String(data?.error??res.status)});
   return data;
  },
  async respond(url,body){
   if(!isResponseUrl(url))throw Error('Refusing a non-Slack response_url');
   const res=await send(url,{method:'POST',headers:{'content-type':'application/json; charset=utf-8'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
   if(!res.ok)throw Error(`Slack response_url failed: ${res.status}`);
  },
 };
}
export const isResponseUrl=url=>typeof url==='string'&&url.length<=1024&&/^https:\/\/hooks\.slack\.com\/[A-Za-z0-9/_.-]+$/.test(url);
// Effects run after the webhook's transaction commits; failures are logged, never retried.
export async function runEffects(slack,effects,log=console.error){
 for(const e of effects){
  try{
   if(e.type==='notify'){
    const thread=e.threadTs?{thread_ts:e.threadTs}:{};
    if(e.channelType==='im')await slack.api('chat.postMessage',{token:e.token,body:{channel:e.channel,text:e.text,...thread}});
    else await slack.api('chat.postEphemeral',{token:e.token,body:{channel:e.channel,user:e.user,text:e.text,...thread}});
   }else if(e.type==='update')await slack.api('chat.update',{token:e.token,body:{channel:e.channel,ts:e.ts,text:e.text,blocks:e.blocks}});
   else if(e.type==='respond')await slack.respond(e.url,{response_type:'ephemeral',replace_original:false,text:e.text});
  }catch(error){log('Slack hub effect failed',e.type,error?.slackError??error?.message);}
 }
}

// ---- Routing (§3) ----
export const escapeSlack=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const MENTION=/<@([UW][A-Z0-9]{2,32})(?:\|[^>]*)?>/g;
// Pure: which Slack events reach a companion. Bots, edits, joins and the bot's
// own posts never do; app_mention in a DM would double message.im.
export function classifyEvent(body,botUserId){
 const e=body?.event;
 if(!e||typeof e!=='object'||e.bot_id||e.bot_profile||e.subtype!==undefined)return null;
 const team=body.team_id??e.team,user=e.user,channel=e.channel,ts=e.ts;
 if(typeof team!=='string'||!SLACK_TEAM.test(team)||typeof user!=='string'||!SLACK_USER.test(user)||user===botUserId)return null;
 if(typeof channel!=='string'||!SLACK_CHANNEL.test(channel)||typeof ts!=='string'||!SLACK_TS.test(ts))return null;
 const raw=typeof e.text==='string'?e.text:'';
 if(e.type==='message'){
  if(e.channel_type!=='im')return null;
  return {team,user,channel,channelType:'im',ts,threadTs:null,raw,mentions:[]};
 }
 if(e.type==='app_mention'){
  if(e.channel_type==='im'||channel.startsWith('D'))return null;
  const threadTs=typeof e.thread_ts==='string'&&SLACK_TS.test(e.thread_ts)?e.thread_ts:ts;
  const mentions=[...new Set([...raw.matchAll(MENTION)].map(m=>m[1]))].filter(id=>id!==botUserId&&id!==user);
  return {team,user,channel,channelType:'channel',ts,threadTs,raw,mentions};
 }
 return null;
}
export function cleanText(raw,botUserId,names={}){
 return raw.replace(MENTION,(whole,id)=>id===botUserId?'':names[id]?'@'+names[id]:whole).replace(/^\s+/,'').replace(/\s+$/,'').slice(0,MAX_TEXT);
}
// Complete per-grant evaluation: one grant must itself allow connect with
// session interaction on a workspace the target owns with teammate delivery on.
export async function mayMessageCompanion(db,senderId,targetId){
 const workspaces=(await db.query('SELECT id FROM workspace WHERE owner_id=$1 AND team_delivery=true AND deleted_at IS NULL ORDER BY id LIMIT 200',[targetId])).rows;
 for(const {id} of workspaces){
  try{if(allowsWorkspaceAccess(await workspaceAccess(db,id,senderId),{action:'connect',resource:'sessions:interact'}))return true;}catch{}
 }
 return false;
}
const label=row=>String(row?.name||'').trim().slice(0,120)||'A teammate';
async function purge(db){
 await db.query('DELETE FROM slack_event_seen WHERE event_id IN (SELECT event_id FROM slack_event_seen WHERE expires_at<now() LIMIT 200)');
 await db.query('DELETE FROM slack_inbox WHERE id IN (SELECT id FROM slack_inbox WHERE expires_at<now() LIMIT 200)');
 await db.query("DELETE FROM slack_approval WHERE id IN (SELECT id FROM slack_approval WHERE expires_at<now()-interval '1 day' LIMIT 200)");
}
// Transaction required. Caps undelivered rows per target; dropped messages
// are reported to whoever sent them.
async function enqueue(db,config,row,effects){
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['slack_inbox:'+row.target]);
 const waiting=(await db.query('SELECT count(*)::int n FROM slack_inbox WHERE target_user_id=$1 AND acked_at IS NULL AND expires_at>now()',[row.target])).rows[0].n;
 if(waiting>=MAX_UNDELIVERED){
  const dropped=(await db.query(`DELETE FROM slack_inbox WHERE id IN (SELECT id FROM slack_inbox WHERE target_user_id=$1 AND acked_at IS NULL AND kind='message' ORDER BY created_at,id LIMIT $2)
  RETURNING team_id,channel_id,channel_type,thread_ts,sender_slack_user_id`,[row.target,waiting-MAX_UNDELIVERED+1])).rows;
  const tokens={};
  for(const d of dropped){
   tokens[d.team_id]??=(await installation(db,config,d.team_id))?.token??null;
   if(tokens[d.team_id])effects.push({type:'notify',token:tokens[d.team_id],channel:d.channel_id,channelType:d.channel_type,user:d.sender_slack_user_id,threadTs:d.thread_ts,text:'A message you sent to a Canopy companion was dropped because too many were waiting.'});
  }
 }
 const id=newId();
 await db.query(`INSERT INTO slack_inbox(id,target_user_id,kind,payload,team_id,channel_id,channel_type,thread_ts,sender_slack_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())`,
 [id,row.target,row.kind,JSON.stringify(row.payload),row.team??null,row.channel??null,row.channelType??null,row.threadTs??null,row.sender??null]);
 return id;
}
// Transaction required; the body's signature is already verified. Returns the
// Slack posts to make after commit.
export async function receiveEvent(db,config,body,{now=Date.now()}={}){
 const effects=[];
 if(body?.type!=='event_callback'||typeof body.event_id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(body.event_id))return {effects,outcome:'ignored'};
 if(!(await db.query('INSERT INTO slack_event_seen(event_id) VALUES($1) ON CONFLICT DO NOTHING',[body.event_id])).rowCount)return {effects,outcome:'duplicate'};
 await purge(db);
 const team=body.team_id??body.event?.team;
 const install=typeof team==='string'&&SLACK_TEAM.test(team)?await installation(db,config,team):null;
 if(!install)return {effects,outcome:'not-installed'};
 const ev=classifyEvent(body,install.botUserId);
 if(!ev)return {effects,outcome:'ignored'};
 const where={token:install.token,channel:ev.channel,channelType:ev.channelType,user:ev.user,threadTs:ev.threadTs};
 const sender=(await db.query('SELECT i.user_id,u.name FROM slack_identity i JOIN "user" u ON u.id=i.user_id WHERE i.team_id=$1 AND i.slack_user_id=$2',[ev.team,ev.user])).rows[0];
 if(!sender){
  const fresh=(await db.query(`INSERT INTO slack_unlinked_notice(team_id,slack_user_id,last_sent_at) VALUES($1,$2,now())
  ON CONFLICT(team_id,slack_user_id) DO UPDATE SET last_sent_at=now() WHERE slack_unlinked_notice.last_sent_at<now()-make_interval(hours=>$3) RETURNING 1`,[ev.team,ev.user,UNLINKED_NOTICE_HOURS])).rowCount;
  if(fresh)effects.push({type:'notify',...where,text:UNLINKED_TEXT});
  return {effects,outcome:fresh?'unlinked':'unlinked-throttled'};
 }
 let target={userId:sender.user_id,name:sender.name,slackUser:ev.user};const names={};
 if(ev.mentions.length){
  const linked=(await db.query('SELECT i.slack_user_id,i.user_id,u.name FROM slack_identity i JOIN "user" u ON u.id=i.user_id WHERE i.team_id=$1 AND i.slack_user_id=ANY($2)',[ev.team,ev.mentions])).rows;
  for(const r of linked)names[r.slack_user_id]=label(r);
  const first=ev.mentions.map(id=>linked.find(r=>r.slack_user_id===id)).find(r=>r&&r.user_id!==sender.user_id);
  if(first)target={userId:first.user_id,name:first.name,slackUser:first.slack_user_id};
 }
 if(target.userId!==sender.user_id&&!(await mayMessageCompanion(db,sender.user_id,target.userId))){
  effects.push({type:'notify',...where,text:`<@${target.slackUser}> hasn't allowed teammates to message their companion.`});
  return {effects,outcome:'refused'};
 }
 const text=cleanText(ev.raw,install.botUserId,names);
 if(!text)return {effects,outcome:'empty'};
 const payload={senderLabel:label(sender),senderRole:target.userId===sender.user_id?'me':'teammate',channelType:ev.channelType,text,created:now};
 const id=await enqueue(db,config,{target:target.userId,kind:'message',payload,team:ev.team,channel:ev.channel,channelType:ev.channelType,threadTs:ev.threadTs,sender:ev.user},effects);
 return {effects,outcome:'queued',id,target:target.userId};
}

// ---- Desktop API (§4) ----
const str=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max;
async function ownItem(db,userId,id){
 if(!ITEM_ID.test(id??''))fail(400,'Invalid Slack item');
 const row=(await db.query("SELECT id,team_id,channel_id,channel_type,thread_ts,replied_at FROM slack_inbox WHERE id=$1 AND target_user_id=$2 AND kind='message' AND expires_at>now() FOR UPDATE",[id,userId])).rows[0];
 if(!row)fail(404,'That Slack message is no longer available');
 return row;
}
async function teamToken(db,config,team){
 const install=await installation(db,config,team);
 if(!install)fail(409,'Canopy is no longer installed in that Slack workspace');
 return install.token;
}
const ownerMention=slackUser=>slackUser?`<@${slackUser}>`:'the companion owner';
function approvalBlocks(summary,approvalId){
 const blocks=[{type:'section',text:{type:'mrkdwn',text:summary.slice(0,2900)}}];
 if(approvalId)blocks.push({type:'actions',block_id:'canopy_approval',elements:[
  {type:'button',action_id:'canopy_approve',style:'primary',text:{type:'plain_text',text:'Approve'},value:approvalId},
  {type:'button',action_id:'canopy_deny',style:'danger',text:{type:'plain_text',text:'Deny'},value:approvalId}]});
 return blocks;
}
const resolvedBlocks=(summary,note)=>[...approvalBlocks(summary,null),{type:'context',elements:[{type:'mrkdwn',text:note}]}];
// Transaction required. `deviceId` owns poll leases; every action is scoped to user.id.
export async function slackAction(db,config,{user,deviceId},input,{slack,redirectUri,now=Date.now()}){
 const action=input?.action;
 if(action==='status'){
  const installs=(await db.query('SELECT team_id,team_name FROM slack_installation WHERE installed_by=$1 ORDER BY team_name,team_id',[user.id])).rows.map(r=>({team:r.team_id,teamName:r.team_name}));
  const linked=(await db.query('SELECT i.team_id,i.slack_user_id,s.team_name FROM slack_identity i LEFT JOIN slack_installation s ON s.team_id=i.team_id WHERE i.user_id=$1 ORDER BY s.team_name,i.team_id',[user.id])).rows.map(r=>({team:r.team_id,teamName:r.team_name??r.team_id,slackUser:r.slack_user_id}));
  return {configured:true,installs,linked};
 }
 if(action==='install-url'||action==='link-url')return startOAuth(db,config,user.id,action==='install-url'?'install':'link',{redirectUri,now});
 if(action==='unlink'){
  if(input.team!==undefined&&!(typeof input.team==='string'&&SLACK_TEAM.test(input.team)))fail(400,'Invalid Slack workspace');
  const n=(await db.query('DELETE FROM slack_identity WHERE user_id=$1 AND ($2::text IS NULL OR team_id=$2)',[user.id,input.team??null])).rowCount;
  return {unlinked:n};
 }
 if(action==='poll'){
  if(!str(deviceId,128))fail(400,'Invalid device');
  await db.query('DELETE FROM slack_inbox WHERE target_user_id=$1 AND expires_at<=now()',[user.id]);
  const rows=(await db.query(`UPDATE slack_inbox SET lease_owner=$2,lease_expires_at=now()+make_interval(secs=>$3)
  WHERE id IN (SELECT id FROM slack_inbox WHERE target_user_id=$1 AND acked_at IS NULL AND expires_at>now() AND (lease_expires_at IS NULL OR lease_expires_at<=now() OR lease_owner=$2)
   ORDER BY created_at,id LIMIT $4 FOR UPDATE SKIP LOCKED)
  RETURNING id,kind,payload,created_at`,[user.id,deviceId,LEASE_SECONDS,POLL_LIMIT])).rows;
  rows.sort((a,b)=>a.created_at-b.created_at||(a.id<b.id?-1:1));
  return {items:rows.map(r=>({...r.payload,id:r.id,kind:r.kind}))};
 }
 if(action==='ack'){
  const ids=input.ids;
  if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||!ITEM_ID.test(id)))fail(400,'Invalid Slack items');
  const n=(await db.query('UPDATE slack_inbox SET acked_at=now() WHERE target_user_id=$1 AND id=ANY($2) AND acked_at IS NULL',[user.id,ids])).rowCount;
  return {acknowledged:n};
 }
 if(action==='reply'){
  if(!str(input.text,MAX_REPLY))fail(400,'Replies must be 1 to 39000 characters');
  const item=await ownItem(db,user.id,input.id);
  if(item.replied_at)fail(409,'That Slack message was already answered');
  const token=await teamToken(db,config,item.team_id);
  try{await slack.api('chat.postMessage',{token,body:{channel:item.channel_id,text:input.text,...(item.thread_ts?{thread_ts:item.thread_ts}:{})}});}
  catch{fail(502,'Slack did not accept the reply. Try again.');}
  await db.query('UPDATE slack_inbox SET replied_at=now(),acked_at=coalesce(acked_at,now()) WHERE id=$1',[item.id]);
  return {posted:true};
 }
 if(action==='approval'){
  if(!ITEM_ID.test(input.proposalId??''))fail(400,'Invalid proposal');
  const project=input.project??null,detail=input.detail??null;
  if(!str(input.summary,300)||project!==null&&!str(project,128)||detail!==null&&!str(detail,2000))fail(400,'Invalid approval request');
  const item=await ownItem(db,user.id,input.id);
  if((await db.query('SELECT 1 FROM slack_approval WHERE target_user_id=$1 AND proposal_id=$2',[user.id,input.proposalId])).rowCount)fail(409,'That approval was already posted');
  const owner=(await db.query('SELECT slack_user_id FROM slack_identity WHERE user_id=$1 AND team_id=$2',[user.id,item.team_id])).rows[0]?.slack_user_id;
  const summary=`*Approval needed* from ${ownerMention(owner)}\n${escapeSlack(input.summary)}`+(project?`\nProject: ${escapeSlack(project)}`:'')+(detail?`\n>${escapeSlack(detail).replace(/\n/g,'\n>')}`:'');
  const token=await teamToken(db,config,item.team_id),approvalId=newId();
  let posted;
  try{posted=await slack.api('chat.postMessage',{token,body:{channel:item.channel_id,text:`Approval needed: ${input.summary}`.slice(0,300),blocks:approvalBlocks(summary,approvalId),...(item.thread_ts?{thread_ts:item.thread_ts}:{})}});}
  catch{fail(502,'Slack did not accept the approval. Try again.');}
  if(typeof posted?.ts!=='string')fail(502,'Slack did not accept the approval. Try again.');
  await db.query(`INSERT INTO slack_approval(id,proposal_id,inbox_id,target_user_id,team_id,channel_id,message_ts,summary,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(mins=>$9))`,
  [approvalId,input.proposalId,item.id,user.id,item.team_id,typeof posted.channel==='string'?posted.channel:item.channel_id,posted.ts,summary,APPROVAL_MINUTES]);
  return {posted:true};
 }
 if(action==='approval-cancel'){
  if(!ITEM_ID.test(input.proposalId??'')||typeof input.accepted!=='boolean')fail(400,'Invalid proposal');
  const a=(await db.query(`UPDATE slack_approval SET resolution=$3,resolved_by='canopy',resolved_at=now() WHERE target_user_id=$1 AND proposal_id=$2 AND resolution IS NULL RETURNING team_id,channel_id,message_ts,summary`,[user.id,input.proposalId,input.accepted?'approved':'denied'])).rows[0];
  if(a){
   const install=await installation(db,config,a.team_id);
   if(install)await runEffects(slack,[{type:'update',token:install.token,channel:a.channel_id,ts:a.message_ts,text:input.accepted?'Approved in Canopy':'Denied in Canopy',blocks:resolvedBlocks(a.summary,input.accepted?'Approved in Canopy':'Denied in Canopy')}]);
  }
  return {};
 }
 fail(400,'Unknown Slack action');
}

// ---- Approvals (§5) ----
export function parseInteraction(rawBody){
 const payload=new URLSearchParams(rawBody.toString('utf8')).get('payload');
 if(!payload)return null;
 try{return JSON.parse(payload);}catch{return null;}
}
// Transaction required; signature already verified. Only the target's own
// linked identity may answer, the first answer wins, and 15 minutes is denial.
export async function receiveInteraction(db,config,p){
 const effects=[];
 const act=Array.isArray(p?.actions)?p.actions[0]:null;
 if(p?.type!=='block_actions'||!act||!['canopy_approve','canopy_deny'].includes(act.action_id))return {effects,outcome:'ignored'};
 const respond=text=>{if(isResponseUrl(p.response_url))effects.push({type:'respond',url:p.response_url,text});};
 const a=typeof act.value==='string'&&NONCE.test(act.value)?(await db.query('SELECT *,expires_at<=now() AS expired FROM slack_approval WHERE id=$1 FOR UPDATE',[act.value])).rows[0]:null;
 if(!a){respond('This approval is no longer available.');return {effects,outcome:'missing'};}
 const owner=(await db.query('SELECT i.slack_user_id,u.name FROM slack_identity i JOIN "user" u ON u.id=i.user_id WHERE i.user_id=$1 AND i.team_id=$2',[a.target_user_id,a.team_id])).rows[0];
 const presser=p.user?.id,presserTeam=p.user?.team_id??p.team?.id;
 if(!owner||presserTeam!==a.team_id||presser!==owner.slack_user_id){respond(`Only ${ownerMention(owner?.slack_user_id)} can approve.`);return {effects,outcome:'not-owner'};}
 if(a.resolution){respond(a.resolution==='expired'?'This approval expired and was treated as denied.':`This was already ${a.resolution}.`);return {effects,outcome:'already'};}
 const install=await installation(db,config,a.team_id);
 if(a.expired){
  await db.query("UPDATE slack_approval SET resolution='expired',resolved_at=now() WHERE id=$1",[a.id]);
  await enqueue(db,config,{target:a.target_user_id,kind:'answer',payload:{proposalId:a.proposal_id,accepted:false,by:'expiry',created:Date.now()}},effects);
  if(install)effects.push({type:'update',token:install.token,channel:a.channel_id,ts:a.message_ts,text:'Expired; treated as denied',blocks:resolvedBlocks(a.summary,'Expired; treated as denied')});
  return {effects,outcome:'expired'};
 }
 const accepted=act.action_id==='canopy_approve';
 await db.query('UPDATE slack_approval SET resolution=$2,resolved_by=$3,resolved_at=now() WHERE id=$1',[a.id,accepted?'approved':'denied',presser]);
 await enqueue(db,config,{target:a.target_user_id,kind:'answer',payload:{proposalId:a.proposal_id,accepted,by:label(owner),created:Date.now()}},effects);
 const note=`${accepted?'Approved':'Denied'} by <@${presser}>`;
 if(install)effects.push({type:'update',token:install.token,channel:a.channel_id,ts:a.message_ts,text:note,blocks:resolvedBlocks(a.summary,note)});
 return {effects,outcome:accepted?'approved':'denied'};
}

export function resultPage(title,message){
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Canopy</title>
<style>:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1d1d1b;--muted:#666}@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ededeb;--muted:#a0a09c}}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}main{max-width:28rem;padding:2rem 1rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:.25rem 0;color:var(--muted)}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><p>You can close this tab and return to Canopy.</p></main></body></html>`;
}
