import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID,randomBytes} from 'node:crypto';import {createRequire} from 'node:module';
import {slackConfig,startOAuth,completeOAuth,receiveEvent,receiveInteraction,slackAction,UNLINKED_TEXT,MAX_UNDELIVERED} from './slack-hub.mjs';
const connectionString=process.env.CANOPY_SYNTHETIC_DATABASE_URL;
const config=slackConfig({CANOPY_SLACK_CLIENT_ID:'123.456',CANOPY_SLACK_CLIENT_SECRET:'client-secret',CANOPY_SLACK_SIGNING_SECRET:'signing-secret',CANOPY_SLACK_TOKEN_KEY:randomBytes(32).toString('base64')});
const redirectUri='https://canopyide.dev/api/slack-oauth',TEAM='TSYNTH01',BOT='USYNTHBOT';
const SLACK={owner:'USYNOWNER',alice:'USYNALICE',bob:'USYNBOB',stranger:'USYNSTRNG',nobody:'USYNNOBDY'};
const b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
// A recording Slack: OAuth exchanges answer from `next`, posts get sequential ts.
function fakeSlack(){
 const calls=[];let ts=0;const s={calls,next:null,
  async api(method,args){calls.push({method,...args});
   if(method==='oauth.v2.access'||method==='openid.connect.token')return s.next;
   if(method==='chat.postMessage')return {ok:true,channel:args.body.channel,ts:`1700000100.${String(++ts).padStart(6,'0')}`};
   return {ok:true};},
  async respond(url,body){calls.push({method:'respond',url,body});}};
 return s;
}
const savepoint=async(db,fn)=>{await db.query('SAVEPOINT oauth');try{const r=await fn();await db.query('RELEASE SAVEPOINT oauth');return r;}catch(e){await db.query('ROLLBACK TO SAVEPOINT oauth');throw e;}};
const stateOf=url=>{const u=new URL(url);return {state:u.searchParams.get('state'),nonce:u.searchParams.get('nonce')};};
let n=0;const ev=(e,id=`EvSynth${++n}`)=>({type:'event_callback',team_id:TEAM,event_id:id,event:{ts:`1700000000.${String(n).padStart(6,'0')}`,...e}});
const dm=(user,text)=>ev({type:'message',channel_type:'im',channel:'DSYNTH'+user.slice(-3),user,text});
const mention=(user,text,extra={})=>ev({type:'app_mention',channel:'CSYNTH01',user,text,...extra});

test('real Postgres Slack hub: OAuth, routing matrix, leases, replies and approvals',{skip:!connectionString},async()=>{
 assert.equal(new URL(connectionString).hostname,'127.0.0.1');assert.equal(new URL(connectionString).port,'55461');assert.equal(new URL(connectionString).username,'canopy_validation');
 const require=createRequire(process.env.CANOPY_SYNTHETIC_PG_PACKAGE_JSON??new URL('../../../package.json',import.meta.url));const {Pool}=require('pg');const pool=new Pool({connectionString});const db=await pool.connect();
 try{await db.query('BEGIN');await db.query(await readFile(new URL('../slack-hub-schema.sql',import.meta.url),'utf8'));
 await db.query(await readFile(new URL('../slack-hub-schema.sql',import.meta.url),'utf8'));// idempotent
 const [owner,alice,bob,carol]=[randomUUID(),randomUUID(),randomUUID(),randomUUID()],ws='ws-'+randomUUID();
 for(const [id,name] of [[owner,'Olive Owner'],[alice,'Alice'],[bob,'Bob'],[carol,'Carol']])await db.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,name,id+'@example.invalid']);
 await db.query("INSERT INTO workspace(id,owner_id,name,state,desired_state,generation) VALUES($1,$2,'Synthetic slack','ready','running',1)",[ws,owner]);
 await db.query("INSERT INTO workspace_member(workspace_id,user_id,role,permissions) VALUES($1,$2,'member',$3),($1,$4,'member',$5)",[ws,alice,JSON.stringify({projects:'all',sessions:'interact'}),bob,JSON.stringify({projects:'all',sessions:'view'})]);
 const slack=fakeSlack(),opts={slack,redirectUri,transaction:savepoint};
 const act=(user,input,deviceId='device-a')=>slackAction(db,config,{user:{id:user},deviceId},input,{slack,redirectUri});

 // --- OAuth: install links the installer; state is single-use and tamper-proof.
 const install=stateOf((await act(owner,{action:'install-url'})).url);
 slack.next={ok:true,access_token:'xoxb-synthetic-token',bot_user_id:BOT,team:{id:TEAM,name:'Synthetic Team'},authed_user:{id:SLACK.owner}};
 assert.deepEqual(await completeOAuth(db,config,{state:install.state,code:'code-1'},opts),{kind:'install',team:TEAM,teamName:'Synthetic Team'});
 const stored=(await db.query('SELECT * FROM slack_installation WHERE team_id=$1',[TEAM])).rows[0];
 assert.equal(stored.installed_by,owner);assert.ok(!JSON.stringify(stored).includes('xoxb-synthetic-token'));
 await assert.rejects(()=>completeOAuth(db,config,{state:install.state,code:'code-1'},opts),e=>e.code===400);// replay
 const [p,sig]=install.state.split('.');const forged=b64({...JSON.parse(Buffer.from(p,'base64url')),userId:carol});
 await assert.rejects(()=>completeOAuth(db,config,{state:forged+'.'+sig,code:'c'},opts),e=>e.code===400);
 const link=async(user,slackUser,{nonce,team=TEAM,aud=config.clientId}={})=>{const s=stateOf((await act(user,{action:'link-url'})).url);
  slack.next={ok:true,id_token:`${b64({alg:'RS256'})}.${b64({iss:'https://slack.com',aud,exp:Math.floor(Date.now()/1000)+300,nonce:nonce??s.nonce,'https://slack.com/user_id':slackUser,'https://slack.com/team_id':team})}.sig`};
  return completeOAuth(db,config,{state:s.state,code:'code'},opts);};
 assert.equal((await link(alice,SLACK.alice)).kind,'link');
 assert.equal((await link(bob,SLACK.bob)).kind,'link');
 await assert.rejects(()=>link(carol,SLACK.alice),e=>e.code===409&&/another Canopy account/.test(e.message));
 await assert.rejects(()=>link(carol,SLACK.stranger,{nonce:'x'.repeat(22)}),e=>e.code===502);
 await assert.rejects(()=>link(carol,SLACK.stranger,{aud:'other-app'}),e=>e.code===502);
 await assert.rejects(()=>link(carol,SLACK.stranger,{team:'TOTHER01'}),e=>e.code===409&&/not installed/.test(e.message));
 // A cancelled authorize still burns the state.
 const cancelled=stateOf((await act(carol,{action:'link-url'})).url);
 await assert.rejects(()=>completeOAuth(db,config,{state:cancelled.state,error:'access_denied'},opts),/cancelled/);
 await assert.rejects(()=>completeOAuth(db,config,{state:cancelled.state,code:'c'},opts),e=>e.code===400);
 assert.deepEqual(await act(owner,{action:'status'}),{configured:true,installs:[{team:TEAM,teamName:'Synthetic Team'}],linked:[{team:TEAM,teamName:'Synthetic Team',slackUser:SLACK.owner}]});
 assert.deepEqual((await act(alice,{action:'status'})).installs,[]);

 // --- Routing matrix.
 const route=body=>receiveEvent(db,config,body);
 const own=await route(dm(SLACK.alice,'hello companion'));
 assert.equal(own.outcome,'queued');assert.equal(own.target,alice);assert.deepEqual(own.effects,[]);
 const dup=dm(SLACK.alice,'again');assert.equal((await route(dup)).outcome,'queued');assert.equal((await route(dup)).outcome,'duplicate');
 assert.equal((await route(ev({type:'message',channel_type:'im',channel:'DSYNTH001',user:SLACK.alice,bot_id:'B1',text:'x'}))).outcome,'ignored');
 assert.equal((await route(ev({type:'message',channel_type:'im',channel:'DSYNTH001',user:SLACK.alice,subtype:'message_changed',text:'x'}))).outcome,'ignored');
 assert.equal((await route(dm(BOT,'my own post'))).outcome,'ignored');
 assert.equal((await route({...dm(SLACK.alice,'x'),team_id:'TNOTHERE1'})).outcome,'not-installed');
 const unlinked=await route(dm(SLACK.stranger,'hi'));
 assert.equal(unlinked.outcome,'unlinked');assert.equal(unlinked.effects[0].text,UNLINKED_TEXT);assert.equal(unlinked.effects[0].token,'xoxb-synthetic-token');
 assert.equal((await route(mention(SLACK.stranger,`<@${BOT}> hi`))).outcome,'unlinked-throttled');
 await db.query("UPDATE slack_unlinked_notice SET last_sent_at=now()-interval '7 hours' WHERE slack_user_id=$1",[SLACK.stranger]);
 assert.equal((await route(dm(SLACK.stranger,'hi'))).outcome,'unlinked');
 // Teammate delivery off: a granted teammate is still refused.
 const off=await route(mention(SLACK.alice,`<@${BOT}> <@${SLACK.owner}> deploy please`));
 assert.equal(off.outcome,'refused');assert.equal(off.effects[0].text,`<@${SLACK.owner}> hasn't allowed teammates to message their companion.`);
 assert.equal(off.effects[0].channelType,'channel');assert.equal(off.effects[0].user,SLACK.alice);
 await db.query('UPDATE workspace SET team_delivery=true WHERE id=$1',[ws]);
 const granted=await route(mention(SLACK.alice,`<@${BOT}> <@${SLACK.nobody}> <@${SLACK.owner}> deploy please`));
 assert.equal(granted.outcome,'queued');assert.equal(granted.target,owner);
 // View-only session sharing is not enough, even with delivery on.
 assert.equal((await route(mention(SLACK.bob,`<@${BOT}> <@${SLACK.owner}> hi`))).outcome,'refused');
 // A mention of nobody linked targets the sender; DMs always target the sender.
 assert.equal((await route(mention(SLACK.bob,`<@${BOT}> <@${SLACK.nobody}> note this`))).target,bob);
 assert.equal((await route(dm(SLACK.alice,`<@${SLACK.owner}> tell yours`))).target,alice);
 assert.equal((await route(mention(SLACK.alice,`<@${BOT}>`))).outcome,'empty');
 const routed=(await db.query('SELECT * FROM slack_inbox WHERE id=$1',[granted.id])).rows[0];
 assert.deepEqual([routed.team_id,routed.channel_id,routed.channel_type,routed.sender_slack_user_id],[TEAM,'CSYNTH01','channel',SLACK.alice]);assert.match(routed.thread_ts,/^1700000000\./);
 assert.equal((await db.query('SELECT thread_ts FROM slack_inbox WHERE id=$1',[own.id])).rows[0].thread_ts,null);

 // --- Poll leases, ack and reply are scoped to the caller.
 const ownerItems=(await act(owner,{action:'poll'})).items;
 assert.equal(ownerItems.length,1);
 assert.deepEqual({...ownerItems[0],created:0},{id:granted.id,kind:'message',senderLabel:'Alice',senderRole:'teammate',channelType:'channel',text:`<@${SLACK.nobody}> @Olive Owner deploy please`,created:0});
 assert.ok(!('team' in ownerItems[0])&&!('channel' in ownerItems[0])&&!('thread_ts' in ownerItems[0]));
 assert.deepEqual((await act(owner,{action:'poll'},'device-b')).items,[]);// leased to device-a
 assert.equal((await act(owner,{action:'poll'})).items.length,1);// same device sees its lease again
 await db.query("UPDATE slack_inbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[granted.id]);
 assert.equal((await act(owner,{action:'poll'},'device-b')).items.length,1);
 const aliceItems=(await act(alice,{action:'poll'})).items;
 assert.deepEqual(aliceItems.map(i=>[i.senderRole,i.channelType,i.text]),[['me','im','hello companion'],['me','im','again'],['me','im',`<@${SLACK.owner}> tell yours`]]);
 assert.deepEqual(await act(alice,{action:'ack',ids:[granted.id]}),{acknowledged:0});
 await assert.rejects(()=>act(alice,{action:'reply',id:granted.id,text:'not yours'}),e=>e.code===404);
 assert.deepEqual(await act(alice,{action:'ack',ids:[aliceItems[0].id,aliceItems[0].id]}),{acknowledged:1});
 assert.equal((await act(alice,{action:'poll'})).items.length,2);
 slack.calls.length=0;
 assert.deepEqual(await act(owner,{action:'reply',id:granted.id,text:'Deploying now.'}),{posted:true});
 assert.deepEqual(slack.calls[0],{method:'chat.postMessage',token:'xoxb-synthetic-token',body:{channel:'CSYNTH01',text:'Deploying now.',thread_ts:routed.thread_ts}});
 await assert.rejects(()=>act(owner,{action:'reply',id:granted.id,text:'twice'}),e=>e.code===409);
 assert.deepEqual((await act(owner,{action:'poll'})).items,[]);
 await act(alice,{action:'reply',id:aliceItems[1].id,text:'Hi'});
 assert.equal(slack.calls.at(-1).body.thread_ts,undefined);// DMs answer inline

 // --- Approvals: owner-only presses, first answer wins, expiry denies.
 const ask=await route(mention(SLACK.alice,`<@${BOT}> <@${SLACK.owner}> run the migration`));
 await act(owner,{action:'approval',id:ask.id,proposalId:'proposal-0001',summary:'Run <migrate>',project:'api',detail:'line 1\nline 2'});
 const posted=slack.calls.at(-1);assert.equal(posted.body.thread_ts,(await db.query('SELECT thread_ts FROM slack_inbox WHERE id=$1',[ask.id])).rows[0].thread_ts);
 assert.match(posted.body.blocks[0].text.text,new RegExp(`<@${SLACK.owner}>[\\s\\S]*Run &lt;migrate&gt;[\\s\\S]*Project: api[\\s\\S]*>line 1\\n>line 2`));
 const approvalId=posted.body.blocks[1].elements[0].value;assert.equal(posted.body.blocks[1].elements[1].value,approvalId);
 await assert.rejects(()=>act(owner,{action:'approval',id:ask.id,proposalId:'proposal-0001',summary:'again'}),e=>e.code===409);
 await assert.rejects(()=>act(alice,{action:'approval',id:ask.id,proposalId:'proposal-0002',summary:'mine'}),e=>e.code===404);
 const press=(user,actionId,id=approvalId,team=TEAM)=>receiveInteraction(db,config,{type:'block_actions',user:{id:user,team_id:team},team:{id:team},response_url:'https://hooks.slack.com/actions/T/1/x',actions:[{action_id:actionId,value:id}]});
 const notOwner=await press(SLACK.alice,'canopy_approve');
 assert.equal(notOwner.outcome,'not-owner');assert.deepEqual(notOwner.effects,[{type:'respond',url:'https://hooks.slack.com/actions/T/1/x',text:`Only <@${SLACK.owner}> can approve.`}]);
 assert.equal((await press(SLACK.owner,'canopy_approve',approvalId,'TOTHER01')).outcome,'not-owner');
 const approved=await press(SLACK.owner,'canopy_approve');
 assert.equal(approved.outcome,'approved');assert.equal(approved.effects[0].type,'update');assert.equal(approved.effects[0].ts,posted.ts??approved.effects[0].ts);
 assert.match(approved.effects[0].blocks.at(-1).elements[0].text,new RegExp(`Approved by <@${SLACK.owner}>`));assert.ok(!approved.effects[0].blocks.some(b=>b.type==='actions'));
 assert.equal((await press(SLACK.owner,'canopy_deny')).outcome,'already');
 const answer=(await act(owner,{action:'poll'})).items.filter(i=>i.kind==='answer');
 assert.deepEqual(answer.map(({proposalId,accepted,by})=>({proposalId,accepted,by})),[{proposalId:'proposal-0001',accepted:true,by:'Olive Owner'}]);
 assert.equal((await act(alice,{action:'poll'})).items.filter(i=>i.kind==='answer').length,0);
 await act(owner,{action:'approval',id:ask.id,proposalId:'proposal-0003',summary:'Late question'});
 const lateId=slack.calls.at(-1).body.blocks[1].elements[0].value;
 await db.query("UPDATE slack_approval SET expires_at=now()-interval '1 second' WHERE id=$1",[lateId]);
 const late=await press(SLACK.owner,'canopy_approve',lateId);assert.equal(late.outcome,'expired');assert.match(late.effects[0].text,/denied/);
 assert.deepEqual((await act(owner,{action:'poll'})).items.filter(i=>i.kind==='answer'&&i.proposalId==='proposal-0003').map(i=>[i.accepted,i.by]),[[false,'expiry']]);
 assert.equal((await press(SLACK.owner,'canopy_approve',lateId)).outcome,'already');
 await act(owner,{action:'approval',id:ask.id,proposalId:'proposal-0004',summary:'Answered in Canopy',project:null,detail:null});
 const panelId=slack.calls.at(-1).body.blocks[1].elements[0].value;
 assert.deepEqual(await act(owner,{action:'approval-cancel',proposalId:'proposal-0004',accepted:false}),{});
 assert.equal(slack.calls.at(-1).method,'chat.update');assert.equal(slack.calls.at(-1).body.text,'Denied in Canopy');
 assert.equal((await press(SLACK.owner,'canopy_approve',panelId)).outcome,'already');
 assert.deepEqual(await act(alice,{action:'approval-cancel',proposalId:'proposal-0004',accepted:true}),{});
 assert.equal((await db.query('SELECT resolution,resolved_by FROM slack_approval WHERE id=$1',[panelId])).rows[0].resolution,'denied');
 assert.equal((await press(SLACK.owner,'canopy_approve','A'.repeat(22))).outcome,'missing');

 // --- Undelivered cap: the oldest message is dropped and its sender told.
 await db.query(`INSERT INTO slack_inbox(id,target_user_id,kind,payload,team_id,channel_id,channel_type,thread_ts,sender_slack_user_id,created_at)
 SELECT 'capacity-'||g,$1,'message','{}',$2,'CSYNTH02','channel','1.1',$3,now()-make_interval(mins=>500-g) FROM generate_series(1,$4::int) g`,[bob,TEAM,SLACK.alice,MAX_UNDELIVERED-1]);// plus Bob's own earlier note
 const capped=await route(dm(SLACK.bob,'one more'));
 assert.equal(capped.outcome,'queued');assert.equal(capped.effects.length,1);assert.equal(capped.effects[0].user,SLACK.alice);assert.equal(capped.effects[0].channel,'CSYNTH02');
 assert.equal((await db.query("SELECT count(*)::int n FROM slack_inbox WHERE target_user_id=$1 AND acked_at IS NULL",[bob])).rows[0].n,MAX_UNDELIVERED);
 assert.equal((await db.query("SELECT 1 FROM slack_inbox WHERE id='capacity-1'")).rowCount,0);
 // Expired rows are never delivered.
 await db.query("UPDATE slack_inbox SET expires_at=now()-interval '1 second' WHERE target_user_id=$1",[bob]);
 assert.deepEqual((await act(bob,{action:'poll'})).items,[]);

 // --- Unlink removes only the caller's links; routing then treats them as unlinked.
 assert.deepEqual(await act(alice,{action:'unlink',team:TEAM}),{unlinked:1});
 assert.equal((await route(dm(SLACK.alice,'still there?'))).outcome,'unlinked');
 assert.equal((await db.query('SELECT count(*)::int n FROM slack_identity WHERE team_id=$1',[TEAM])).rows[0].n,2);
 }finally{await db.query('ROLLBACK');db.release();await pool.end();}
});
