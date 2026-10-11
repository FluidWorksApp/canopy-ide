import test from 'node:test';import assert from 'node:assert/strict';import {createHmac,randomBytes} from 'node:crypto';import {readFile} from 'node:fs/promises';
import {slackConfig,slackAction,hostSlackAction,receiveInteraction,hostLeaseOwner,DESKTOP_QUIET_SECONDS,LEASE_SECONDS,POLL_LIMIT,encryptToken} from './slack-hub.mjs';
import {verifyServiceHostToken,SERVICE_HOST_KINDS} from './service-host-auth.mjs';

const config=slackConfig({CANOPY_SLACK_CLIENT_ID:'123.456',CANOPY_SLACK_CLIENT_SECRET:'client-secret',CANOPY_SLACK_SIGNING_SECRET:'signing-secret',CANOPY_SLACK_TOKEN_KEY:randomBytes(32).toString('base64')});
const WS='ws-22222222-2222-4222-8222-222222222222',OTHER_WS='ws-33333333-3333-4333-8333-333333333333',OWNER='user-owner',ITEM='itemitem01',PROPOSAL='proposal01';
const workspace={id:WS,owner_id:OWNER,generation:3};
const sealed=encryptToken(config.tokenKey,'xoxb-synthetic','T0001');
const install={team_id:'T0001',team_name:'Team',bot_user_id:'UBOT0001',bot_token_ciphertext:sealed.ciphertext,bot_token_iv:sealed.iv,bot_token_tag:sealed.tag};
// A recording pool: the first handler whose pattern matches answers.
function fakeDb(handlers=[]){
 const calls=[];
 return {calls,ran:re=>calls.some(c=>re.test(c.sql)),async query(sql,params=[]){calls.push({sql,params});for(const [re,fn] of handlers)if(re.test(sql))return fn(params,sql);return {rows:[],rowCount:0};}};
}
const rows=r=>({rows:r,rowCount:r.length});
const enabled=on=>[/SELECT slack_companion FROM workspace/,()=>rows([{slack_companion:on}])];
const presence=fresh=>[/SELECT 1 FROM slack_desktop_presence/,()=>rows(fresh?[{}]:[])];
const recordingSlack=()=>{const calls=[];return {calls,async api(method,args){calls.push({method,...args});return {ok:true,ts:'1700000100.000001',channel:args.body?.channel};}};};
const noDb={query:async()=>{throw Error('unexpected query');}};

const mint=(kind,{key='k'.repeat(64),workspaceId=WS,generation=3,expires=Math.floor(Date.now()/1000)+60}={})=>{
 const payload=Buffer.from(JSON.stringify({version:1,kind,workspaceId,generation,expires})).toString('base64url');
 return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');
};

test('slack-companion is its own purpose-bound host credential',()=>{
 assert.ok(SERVICE_HOST_KINDS.includes('slack-companion'));
 const key=()=> 'k'.repeat(64);
 assert.equal(verifyServiceHostToken(mint('slack-companion'),key,'slack-companion').workspaceId,WS);
 // A relay or snapshot token never authorizes the Slack hub, nor the reverse.
 assert.throws(()=>verifyServiceHostToken(mint('peer-relay'),key,'slack-companion'),e=>e.code===401);
 assert.throws(()=>verifyServiceHostToken(mint('slack-companion'),key,'peer-relay'),e=>e.code===401);
 assert.throws(()=>verifyServiceHostToken(mint('slack-companion',{key:'x'.repeat(64)}),key,'slack-companion'),e=>e.code===401);
 assert.throws(()=>verifyServiceHostToken(mint('slack-companion',{expires:Math.floor(Date.now()/1000)+600}),key,'slack-companion'),e=>e.code===401);
});

test('host actions validate before touching the database and never approve',async()=>{
 const opts={slack:{}};
 for(const input of [{action:'install-url'},{action:'link-url'},{action:'unlink'},{action:'workspace-companion',workspaceId:WS,enabled:true},{action:'nope'},{},
  {action:'ack',ids:'x'},{action:'ack',ids:['short']},{action:'reply',id:ITEM,text:''},{action:'reply',id:'bad',text:'hi'},
  {action:'approval',id:ITEM,proposalId:'bad id',summary:'run'},{action:'approval',id:ITEM,proposalId:PROPOSAL,summary:''},{action:'approval-status',proposalId:'x'},
  {action:'approval-cancel',proposalId:PROPOSAL,accepted:true},{action:'approval-cancel',proposalId:PROPOSAL}])
  await assert.rejects(hostSlackAction(noDb,config,workspace,input,opts),e=>e.code===400,JSON.stringify(input));
 await assert.rejects(hostSlackAction(noDb,config,{id:'../x',owner_id:OWNER},{action:'poll'},opts),e=>e.code===403);
});

test('opt-in: a workspace that is switched off leases nothing and may only withdraw',async()=>{
 const db=fakeDb([enabled(false)]);
 assert.deepEqual(await hostSlackAction(db,config,workspace,{action:'poll'},{slack:{}}),{enabled:false,deferred:null,items:[]});
 assert.equal(db.ran(/UPDATE slack_inbox/),false);
 for(const input of [{action:'reply',id:ITEM,text:'hi'},{action:'approval',id:ITEM,proposalId:PROPOSAL,summary:'run'},{action:'ack',ids:[ITEM]},{action:'approval-status',proposalId:PROPOSAL}])
  await assert.rejects(hostSlackAction(fakeDb([enabled(false)]),config,workspace,input,{slack:{}}),e=>e.code===403);
 // Withdrawing as denied is cleanup, allowed off, and scoped to this host's own approvals.
 const cancel=fakeDb([enabled(false)]);
 assert.deepEqual(await hostSlackAction(cancel,config,workspace,{action:'approval-cancel',proposalId:PROPOSAL,accepted:false},{slack:{}}),{});
 const update=cancel.calls.find(c=>/UPDATE slack_approval/.test(c.sql));
 assert.deepEqual(update.params,[OWNER,PROPOSAL,'denied',hostLeaseOwner(WS)]);
 // The enabled flag is read for this workspace and its current owner only.
 const status=fakeDb([enabled(true),presence(true)]);
 assert.deepEqual(await hostSlackAction(status,config,workspace,{action:'status'},{slack:{}}),{enabled:true,desktopActive:true,quietSeconds:DESKTOP_QUIET_SECONDS});
 assert.deepEqual(status.calls[0].params,[WS,OWNER]);
});

test('arbitration: the host lease is one statement gated on desktop quiet, messages only',async()=>{
 const db=fakeDb([[/UPDATE slack_inbox SET lease_owner/,()=>rows([{id:ITEM,kind:'message',payload:{text:'hi',senderRole:'me'},created_at:new Date(1)}])],enabled(true),presence(true)]);
 const result=await hostSlackAction(db,config,workspace,{action:'poll'},{slack:{}});
 assert.deepEqual(result,{enabled:true,deferred:'desktop-active',items:[{text:'hi',senderRole:'me',id:ITEM,kind:'message'}]});
 const lease=db.calls.find(c=>/UPDATE slack_inbox SET lease_owner/.test(c.sql));
 assert.deepEqual(lease.params,[OWNER,'workspace:'+WS,LEASE_SECONDS,POLL_LIMIT,DESKTOP_QUIET_SECONDS]);
 assert.match(lease.sql,/kind='message'/);
 assert.match(lease.sql,/NOT EXISTS\(SELECT 1 FROM slack_desktop_presence p WHERE p\.user_id=\$1 AND p\.last_poll_at>now\(\)-make_interval\(secs=>\$5\)\)/);
 // Renewal of its own live lease is not gated; a lapsed lease is a new lease.
 assert.match(lease.sql,/\(lease_owner=\$2 AND lease_expires_at>now\(\)\) OR \(\(lease_expires_at IS NULL OR lease_expires_at<=now\(\)\)/);
 assert.equal(db.ran(/slack_desktop_presence\(/),false,'a host poll never counts as a desktop');
 assert.equal(DESKTOP_QUIET_SECONDS,30);
});

test('the desktop poll records presence; the host never does',async()=>{
 const db=fakeDb();
 await slackAction(db,config,{user:{id:OWNER},deviceId:'device-a'},{action:'poll'},{slack:{},redirectUri:'https://x'});
 const write=db.calls.find(c=>/INSERT INTO slack_desktop_presence/.test(c.sql));
 assert.deepEqual(write.params,[OWNER,'device-a']);
 assert.ok(db.calls.indexOf(write)<db.calls.findIndex(c=>/UPDATE slack_inbox SET lease_owner/.test(c.sql)),'presence is recorded before the desktop leases');
});

test('a host answers only items it holds, through the same reply path',async()=>{
 const item=lease=>[/FROM slack_inbox WHERE id=\$1 AND target_user_id=\$2/,()=>rows([{id:ITEM,team_id:'T0001',channel_id:'C0001',channel_type:'channel',thread_ts:'1.1',replied_at:null,lease_owner:lease}])];
 const installed=[/FROM slack_installation WHERE team_id/,()=>rows([install])];
 const taken=fakeDb([enabled(true),item('device-a'),installed]);
 await assert.rejects(hostSlackAction(taken,config,workspace,{action:'reply',id:ITEM,text:'hi'},{slack:recordingSlack()}),e=>e.code===409);
 await assert.rejects(hostSlackAction(fakeDb([enabled(true),item(hostLeaseOwner(OTHER_WS)),installed]),config,workspace,{action:'reply',id:ITEM,text:'hi'},{slack:recordingSlack()}),e=>e.code===409);
 const slack=recordingSlack(),db=fakeDb([enabled(true),item(hostLeaseOwner(WS)),installed]);
 assert.deepEqual(await hostSlackAction(db,config,workspace,{action:'reply',id:ITEM,text:'hi'},{slack}),{posted:true});
 assert.deepEqual(slack.calls[0].body,{channel:'C0001',text:'hi',thread_ts:'1.1'});
 assert.equal(slack.calls[0].token,'xoxb-synthetic');
 assert.ok(db.ran(/UPDATE slack_inbox SET replied_at=now\(\)/));
 // The item lookup is scoped to the workspace owner.
 assert.deepEqual(db.calls.find(c=>/FROM slack_inbox WHERE id=\$1/.test(c.sql)).params,[ITEM,OWNER]);
 // A host approval is recorded as the host's, so its answer is not queued for a desktop.
 const approval=fakeDb([enabled(true),item(hostLeaseOwner(WS)),installed]);
 await hostSlackAction(approval,config,workspace,{action:'approval',id:ITEM,proposalId:PROPOSAL,summary:'Run the tests'},{slack:recordingSlack()});
 assert.equal(approval.calls.find(c=>/INSERT INTO slack_approval/.test(c.sql)).params.at(-1),hostLeaseOwner(WS));
 const desktop=fakeDb([item(null),installed]);
 await slackAction(desktop,config,{user:{id:OWNER},deviceId:'device-a'},{action:'approval',id:ITEM,proposalId:PROPOSAL,summary:'Run the tests'},{slack:recordingSlack(),redirectUri:'https://x'});
 assert.equal(desktop.calls.find(c=>/INSERT INTO slack_approval/.test(c.sql)).params.at(-1),null);
});

test('approval-status: pending, answered, and expiry at 15 minutes is denial',async()=>{
 const approval=extra=>[/FROM slack_approval WHERE target_user_id=\$1 AND proposal_id=\$2 AND requested_by=\$3/,(params)=>{assert.deepEqual(params,[OWNER,PROPOSAL,hostLeaseOwner(WS)]);return rows([{id:'a'.repeat(22),resolution:null,team_id:'T0001',channel_id:'C0001',message_ts:'1.2',summary:'s',expired:false,...extra}]);}];
 const ask=(db,slack={api:async()=>({ok:true})})=>hostSlackAction(db,config,workspace,{action:'approval-status',proposalId:PROPOSAL},{slack});
 assert.deepEqual(await ask(fakeDb([enabled(true),approval({})])),{resolution:'pending',accepted:false});
 assert.deepEqual(await ask(fakeDb([enabled(true),approval({resolution:'approved'})])),{resolution:'approved',accepted:true});
 assert.deepEqual(await ask(fakeDb([enabled(true),approval({resolution:'denied'})])),{resolution:'denied',accepted:false});
 const slack=recordingSlack(),db=fakeDb([enabled(true),approval({expired:true}),[/FROM slack_installation WHERE team_id/,()=>rows([install])]]);
 assert.deepEqual(await ask(db,slack),{resolution:'expired',accepted:false});
 assert.ok(db.ran(/UPDATE slack_approval SET resolution='expired'/));
 assert.equal(slack.calls[0].method,'chat.update');assert.equal(slack.calls[0].body.text,'Expired; treated as denied');
 await assert.rejects(ask(fakeDb([enabled(true)])),e=>e.code===404);
});

test('an owner press on a host approval resolves it without queueing a desktop answer',async()=>{
 const pending={id:'a'.repeat(22),proposal_id:PROPOSAL,target_user_id:OWNER,team_id:'T0001',channel_id:'C0001',message_ts:'1.2',summary:'s',resolution:null,expired:false,requested_by:hostLeaseOwner(WS)};
 const db=fakeDb([[/SELECT \*,expires_at<=now\(\) AS expired FROM slack_approval/,()=>rows([pending])],[/FROM slack_identity i JOIN "user" u ON u.id=i.user_id WHERE i.user_id=\$1/,()=>rows([{slack_user_id:'UOWNER01',name:'Olive'}])],[/FROM slack_installation WHERE team_id/,()=>rows([install])]]);
 const r=await receiveInteraction(db,config,{type:'block_actions',user:{id:'UOWNER01',team_id:'T0001'},actions:[{action_id:'canopy_approve',value:pending.id}]});
 assert.equal(r.outcome,'approved');assert.ok(db.ran(/UPDATE slack_approval SET resolution=\$2/));
 assert.equal(db.ran(/INSERT INTO slack_inbox/),false);
 // Someone else pressing is still refused: owner-only, unchanged.
 const other=await receiveInteraction(db,config,{type:'block_actions',user:{id:'UTEAM001',team_id:'T0001'},actions:[{action_id:'canopy_approve',value:pending.id}]});
 assert.equal(other.outcome,'not-owner');
});

test('the owner opts one workspace in from the desktop; only the owner can',async()=>{
 const ctx={user:{id:OWNER},deviceId:'device-a'},opts={slack:{},redirectUri:'https://x'};
 for(const input of [{action:'workspace-companion',workspaceId:WS},{action:'workspace-companion',workspaceId:'ws-1',enabled:true}])
  await assert.rejects(slackAction(noDb,config,ctx,input,opts),e=>e.code===400);
 const ws=owner=>[/SELECT id,owner_id,name FROM workspace WHERE id=\$1/,()=>rows([{id:WS,owner_id:owner,name:'Main'}])];
 await assert.rejects(slackAction(fakeDb([ws('someone-else')]),config,ctx,{action:'workspace-companion',workspaceId:WS,enabled:true},opts),e=>e.code===403);
 await assert.rejects(slackAction(fakeDb([]),config,ctx,{action:'workspace-companion',workspaceId:WS,enabled:true},opts),e=>e.code===404);
 const on=fakeDb([ws(OWNER)]);
 assert.deepEqual(await slackAction(on,config,ctx,{action:'workspace-companion',workspaceId:WS,enabled:true},opts),{workspaceCompanion:{workspaceId:WS,name:'Main'}});
 const off=on.calls.findIndex(c=>/SET slack_companion=false WHERE owner_id=\$1/.test(c.sql)),set=on.calls.findIndex(c=>/SET slack_companion=\$2 WHERE id=\$1/.test(c.sql));
 assert.ok(off>=0&&off<set,'enabling one workspace switches the owner\'s others off first');
 assert.deepEqual(on.calls.find(c=>/workspace_access_audit/.test(c.sql)).params,[WS,OWNER,'slack-companion-on']);
 const disable=fakeDb([ws(OWNER)]);
 assert.deepEqual(await slackAction(disable,config,ctx,{action:'workspace-companion',workspaceId:WS,enabled:false},opts),{workspaceCompanion:null});
 assert.equal(disable.ran(/SET slack_companion=false WHERE owner_id/),false);
 const status=await slackAction(fakeDb([[/FROM workspace WHERE owner_id=\$1 AND slack_companion/,()=>rows([{id:WS,name:'Main'}])]]),config,ctx,{action:'status'},opts);
 assert.deepEqual(status.workspaceCompanion,{workspaceId:WS,name:'Main'});
});

test('the migration is additive and idempotent',async()=>{
 const sql=await readFile(new URL('../slack-companion-host-schema.sql',import.meta.url),'utf8');
 for(const statement of sql.replace(/--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))
  assert.match(statement,/^(CREATE TABLE IF NOT EXISTS|CREATE UNIQUE INDEX IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS)/,statement.slice(0,60));
 assert.match(sql,/slack_companion boolean NOT NULL DEFAULT false/);
});
