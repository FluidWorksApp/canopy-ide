import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID,randomBytes} from 'node:crypto';import {createRequire} from 'node:module';
import {slackConfig,encryptToken,receiveEvent,receiveInteraction,slackAction,hostSlackAction,DESKTOP_QUIET_SECONDS} from './slack-hub.mjs';
import {currentHostWorkspace} from './service-host-auth.mjs';
const connectionString=process.env.CANOPY_SYNTHETIC_DATABASE_URL;
const config=slackConfig({CANOPY_SLACK_CLIENT_ID:'123.456',CANOPY_SLACK_CLIENT_SECRET:'client-secret',CANOPY_SLACK_SIGNING_SECRET:'signing-secret',CANOPY_SLACK_TOKEN_KEY:randomBytes(32).toString('base64')});
const TEAM='TSYNTH02',BOT='USYNBOT02',OWNER_SLACK='USYNOWN02';
function fakeSlack(){const calls=[];let ts=0;return {calls,async api(method,args){calls.push({method,...args});return method==='chat.postMessage'?{ok:true,channel:args.body.channel,ts:`1700000200.${String(++ts).padStart(6,'0')}`}:{ok:true};}};}
let n=0;const dm=text=>({type:'event_callback',team_id:TEAM,event_id:`EvHost${++n}`,event:{type:'message',channel_type:'im',channel:'DSYNTHOWN',user:OWNER_SLACK,text,ts:`1700000000.${String(n).padStart(6,'0')}`}});

test('real Postgres: workspace host arbitration, leases, replies and approvals',{skip:!connectionString},async()=>{
 assert.equal(new URL(connectionString).hostname,'127.0.0.1');assert.equal(new URL(connectionString).port,'55461');assert.equal(new URL(connectionString).username,'canopy_validation');
 const require=createRequire(process.env.CANOPY_SYNTHETIC_PG_PACKAGE_JSON??new URL('../../../package.json',import.meta.url));const {Pool}=require('pg');const pool=new Pool({connectionString});const db=await pool.connect();
 try{await db.query('BEGIN');
 for(const file of ['slack-hub.sql','slack-companion-host.sql','slack-companion-host.sql'])await db.query(await readFile(new URL('../'+file.replace('.sql','-schema.sql'),import.meta.url),'utf8'));
 const owner=randomUUID(),stranger=randomUUID(),ws='ws-'+randomUUID(),ws2='ws-'+randomUUID(),theirs='ws-'+randomUUID();
 for(const [id,name] of [[owner,'Olive Owner'],[stranger,'Sam']])await db.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,name,id+'@example.invalid']);
 await db.query("INSERT INTO workspace(id,owner_id,name,state,desired_state,generation) VALUES($1,$2,'Main','ready','running',2),($3,$2,'Second','ready','running',1),($4,$5,'Theirs','ready','running',1)",[ws,owner,ws2,theirs,stranger]);
 const sealed=encryptToken(config.tokenKey,'xoxb-synthetic-host',TEAM);
 await db.query('INSERT INTO slack_installation(team_id,team_name,bot_user_id,bot_token_ciphertext,bot_token_iv,bot_token_tag,installed_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[TEAM,'Synthetic',BOT,sealed.ciphertext,sealed.iv,sealed.tag,owner]);
 await db.query('INSERT INTO slack_identity(team_id,slack_user_id,user_id) VALUES($1,$2,$3)',[TEAM,OWNER_SLACK,owner]);
 const slack=fakeSlack();
 const desktop=(input,deviceId='device-a')=>slackAction(db,config,{user:{id:owner},deviceId},input,{slack,redirectUri:'https://x'});
 const hostWs=await currentHostWorkspace(db,{workspaceId:ws,generation:2});
 const host=input=>hostSlackAction(db,config,hostWs,input,{slack});
 const route=async text=>(await receiveEvent(db,config,dm(text))).id;
 const quiet=()=>db.query(`UPDATE slack_desktop_presence SET last_poll_at=now()-make_interval(secs=>$2) WHERE user_id=$1`,[owner,DESKTOP_QUIET_SECONDS+1]);
 // A replaced host carries an older generation and never gets this far.
 await assert.rejects(()=>currentHostWorkspace(db,{workspaceId:ws,generation:1}),e=>e.code===403);

 // --- Opt-in is off by default: the host sees nothing and the item waits.
 const first=await route('are the tests green?');
 assert.deepEqual(await host({action:'poll'}),{enabled:false,deferred:null,items:[]});
 await assert.rejects(()=>host({action:'reply',id:first,text:'x'}),e=>e.code===403);
 assert.equal((await db.query('SELECT lease_owner FROM slack_inbox WHERE id=$1',[first])).rows[0].lease_owner,null);
 // Only the owner can opt a workspace in; one workspace per owner.
 await assert.rejects(()=>desktop({action:'workspace-companion',workspaceId:theirs,enabled:true}),e=>e.code===403);
 assert.deepEqual(await desktop({action:'workspace-companion',workspaceId:ws2,enabled:true}),{workspaceCompanion:{workspaceId:ws2,name:'Second'}});
 assert.deepEqual(await desktop({action:'workspace-companion',workspaceId:ws,enabled:true}),{workspaceCompanion:{workspaceId:ws,name:'Main'}});
 assert.deepEqual((await db.query('SELECT id FROM workspace WHERE owner_id=$1 AND slack_companion',[owner])).rows.map(r=>r.id),[ws]);
 await db.query('SAVEPOINT unique_owner');
 await assert.rejects(()=>db.query('UPDATE workspace SET slack_companion=true WHERE id=$1',[ws2]),e=>e.code==='23505');
 await db.query('ROLLBACK TO SAVEPOINT unique_owner');
 assert.equal((await desktop({action:'status'})).workspaceCompanion.workspaceId,ws);

 // --- A desktop polled within the quiet window: the host leases nothing new.
 const leased=(await desktop({action:'poll'})).items;// the desktop takes `first`
 assert.deepEqual(leased.map(i=>i.id),[first]);
 const second=await route('and the deploy?');
 assert.deepEqual(await host({action:'status'}),{enabled:true,desktopActive:true,quietSeconds:DESKTOP_QUIET_SECONDS});
 assert.deepEqual(await host({action:'poll'}),{enabled:true,deferred:'desktop-active',items:[]});
 assert.equal((await db.query('SELECT lease_owner FROM slack_inbox WHERE id=$1',[second])).rows[0].lease_owner,null);

 // --- Desktop quiet: the host takes what nobody holds, never a live desktop lease.
 await quiet();
 const taken=await host({action:'poll'});
 assert.equal(taken.deferred,null);assert.deepEqual(taken.items.map(i=>[i.id,i.kind,i.text,i.senderRole]),[[second,'message','and the deploy?','me']]);
 await assert.rejects(()=>host({action:'reply',id:first,text:'mine?'}),e=>e.code===409);// the desktop holds it
 // The desktop returns: it cannot take the host's lease, the host keeps renewing it.
 assert.deepEqual((await desktop({action:'poll'},'device-b')).items.map(i=>i.id),[]);
 const renewed=await host({action:'poll'});
 assert.equal(renewed.deferred,'desktop-active');assert.deepEqual(renewed.items.map(i=>i.id),[second]);
 // A message arriving while the desktop is back goes to the desktop.
 const third=await route('one more thing');
 assert.deepEqual((await host({action:'poll'})).items.map(i=>i.id),[second]);
 assert.deepEqual((await desktop({action:'poll'},'device-b')).items.map(i=>i.id),[third]);

 // --- Replies: one answer per message whoever holds it.
 slack.calls.length=0;
 assert.deepEqual(await host({action:'reply',id:second,text:'Deploy is green.'}),{posted:true});
 assert.deepEqual(slack.calls[0],{method:'chat.postMessage',token:'xoxb-synthetic-host',body:{channel:'DSYNTHOWN',text:'Deploy is green.'}});
 await assert.rejects(()=>desktop({action:'reply',id:second,text:'me too'}),e=>e.code===409);
 await assert.rejects(()=>host({action:'reply',id:second,text:'again'}),e=>e.code===409);
 // A host lease that lapses while the desktop is active is not re-taken.
 await quiet();const fourth=await route('lapse test');assert.deepEqual((await host({action:'poll'})).items.map(i=>i.id),[fourth]);
 await db.query("UPDATE slack_inbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[fourth]);
 assert.ok((await desktop({action:'poll'},'device-b')).items.some(i=>i.id===fourth));
 assert.deepEqual((await host({action:'poll'})).items.map(i=>i.id),[]);
 await assert.rejects(()=>host({action:'reply',id:fourth,text:'late'}),e=>e.code===409);
 assert.deepEqual(await host({action:'ack',ids:[fourth]}),{acknowledged:0});

 // --- Approvals: posted by the host, answered by the owner in Slack, read by status.
 await quiet();const fifth=await route('please run the migration');
 assert.deepEqual((await host({action:'poll'})).items.map(i=>i.id),[fifth]);
 assert.deepEqual(await host({action:'approval',id:fifth,proposalId:'vmproposal01',summary:'Run the migration',project:'api',detail:null}),{posted:true});
 const button=slack.calls.at(-1).body.blocks[1].elements[0].value;
 assert.equal((await db.query('SELECT requested_by FROM slack_approval WHERE id=$1',[button])).rows[0].requested_by,'workspace:'+ws);
 assert.deepEqual(await host({action:'approval-status',proposalId:'vmproposal01'}),{resolution:'pending',accepted:false});
 const press=id=>receiveInteraction(db,config,{type:'block_actions',user:{id:OWNER_SLACK,team_id:TEAM},actions:[{action_id:'canopy_approve',value:id}]});
 assert.equal((await press(button)).outcome,'approved');
 assert.deepEqual(await host({action:'approval-status',proposalId:'vmproposal01'}),{resolution:'approved',accepted:true});
 assert.equal((await db.query("SELECT count(*)::int n FROM slack_inbox WHERE target_user_id=$1 AND kind='answer'",[owner])).rows[0].n,0,'no desktop answer for a host approval');
 // The desktop cannot read the host's approvals through status, nor can another host.
 const otherHost=input=>hostSlackAction(db,config,{id:ws2,owner_id:owner,generation:1},input,{slack});
 await assert.rejects(()=>otherHost({action:'approval-status',proposalId:'vmproposal01'}),e=>e.code===403);// switched off
 // Expiry: 15 minutes unanswered is denial, and the Slack message says so.
 await host({action:'approval',id:fifth,proposalId:'vmproposal02',summary:'Delete the cache'});
 await db.query("UPDATE slack_approval SET expires_at=now()-interval '1 second' WHERE proposal_id='vmproposal02'");
 assert.deepEqual(await host({action:'approval-status',proposalId:'vmproposal02'}),{resolution:'expired',accepted:false});
 assert.equal(slack.calls.at(-1).method,'chat.update');assert.equal(slack.calls.at(-1).body.text,'Expired; treated as denied');
 assert.equal((await press((await db.query("SELECT id FROM slack_approval WHERE proposal_id='vmproposal02'")).rows[0].id)).outcome,'already');
 // A turn that ends with a question open withdraws it as denied; never as approved.
 await host({action:'approval',id:fifth,proposalId:'vmproposal03',summary:'Restart the server'});
 await assert.rejects(()=>host({action:'approval-cancel',proposalId:'vmproposal03',accepted:true}),e=>e.code===400);
 assert.deepEqual(await host({action:'approval-cancel',proposalId:'vmproposal03',accepted:false}),{});
 assert.deepEqual(await host({action:'approval-status',proposalId:'vmproposal03'}),{resolution:'denied',accepted:false});
 assert.equal(slack.calls.at(-1).body.text,'Denied in Canopy');

 // --- Switched off: no new leases, the owner's desktop flow is untouched.
 assert.deepEqual(await desktop({action:'workspace-companion',workspaceId:ws,enabled:false}),{workspaceCompanion:null});
 await quiet();await route('after opt-out');
 assert.deepEqual(await host({action:'poll'}),{enabled:false,deferred:null,items:[]});
 assert.deepEqual((await db.query("SELECT action FROM workspace_access_audit WHERE workspace_id=$1 ORDER BY created_at,action",[ws])).rows.map(r=>r.action).sort(),['slack-companion-off','slack-companion-on']);
 }finally{await db.query('ROLLBACK');db.release();await pool.end();}
});
