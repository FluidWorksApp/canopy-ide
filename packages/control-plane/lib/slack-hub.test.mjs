import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {EventEmitter} from 'node:events';
import {slackConfig,slackSignature,verifySlackSignature,readRawBody,issueState,verifyState,authorizeUrl,encryptToken,decryptToken,classifyEvent,cleanText,slackTransport,runEffects,isResponseUrl,parseInteraction,receiveEvent,receiveInteraction,slackAction,BOT_SCOPES,MAX_TEXT} from './slack-hub.mjs';

const env={CANOPY_SLACK_CLIENT_ID:'123.456',CANOPY_SLACK_CLIENT_SECRET:'client-secret',CANOPY_SLACK_SIGNING_SECRET:'signing-secret',CANOPY_SLACK_TOKEN_KEY:randomBytes(32).toString('base64')};
const config=slackConfig(env);
const BOT='UBOT0001';

test('configuration requires every variable and a 32-byte token key',()=>{
 assert.ok(config);assert.equal(config.tokenKey.length,32);
 for(const k of Object.keys(env))assert.equal(slackConfig({...env,[k]:''}),null);
 assert.equal(slackConfig({...env,CANOPY_SLACK_TOKEN_KEY:randomBytes(16).toString('base64')}),null);
 // The state key is derived from the server-only token key, not the secret Slack shares.
 assert.notDeepEqual(slackConfig({...env,CANOPY_SLACK_TOKEN_KEY:randomBytes(32).toString('base64')}).stateKey,config.stateKey);
});

test('request signatures: good, bad, stale and malformed',()=>{
 const now=1_800_000_000_000,ts=String(now/1000),body=Buffer.from('{"type":"event_callback"}');
 const signature=slackSignature('signing-secret',ts,body);
 assert.equal(verifySlackSignature({signingSecret:'signing-secret',timestamp:ts,signature,rawBody:body,now}),true);
 assert.equal(verifySlackSignature({signingSecret:'signing-secret',timestamp:ts,signature,rawBody:Buffer.from('{"type":"event_callback" }'),now}),false);
 assert.equal(verifySlackSignature({signingSecret:'other-secret',timestamp:ts,signature,rawBody:body,now}),false);
 assert.equal(verifySlackSignature({signingSecret:'signing-secret',timestamp:ts,signature,rawBody:body,now:now+301_000}),false);
 assert.equal(verifySlackSignature({signingSecret:'signing-secret',timestamp:ts,signature,rawBody:body,now:now-301_000}),false);
 assert.equal(verifySlackSignature({signingSecret:'signing-secret',timestamp:ts,signature,rawBody:body,now:now+299_000}),true);
 assert.equal(verifySlackSignature({signingSecret:'signing-secret',timestamp:ts,signature:signature.slice(0,-1),rawBody:body,now}),false);
 assert.equal(verifySlackSignature({signingSecret:'signing-secret',timestamp:ts,signature:'v1='+signature.slice(3),rawBody:body,now}),false);
 assert.equal(verifySlackSignature({signingSecret:'signing-secret',timestamp:undefined,signature,rawBody:body,now}),false);
 assert.equal(verifySlackSignature({signingSecret:'signing-secret',timestamp:ts+'x',signature,rawBody:body,now}),false);
});

test('raw body is read byte-exact and capped',async()=>{
 const req=new EventEmitter();const read=readRawBody(req);req.emit('data',Buffer.from('a=1&'));req.emit('data','b=%20');req.emit('end');
 assert.equal((await read).toString(),'a=1&b=%20');
 const big=new EventEmitter();const capped=readRawBody(big,4);big.emit('data',Buffer.from('12345'));big.emit('end');
 await assert.rejects(capped,e=>e.code===413);
});

test('OAuth state: round trip, tampering, wrong key and expiry',()=>{
 const now=Date.now(),{state,claims}=issueState(config,{kind:'link',userId:'user-1',now});
 assert.deepEqual(verifyState(config,state,now),claims);
 const [payload,sig]=state.split('.');
 const forged=Buffer.from(JSON.stringify({...claims,userId:'user-2'})).toString('base64url');
 assert.throws(()=>verifyState(config,forged+'.'+sig,now),e=>e.code===400);
 assert.throws(()=>verifyState(config,payload+'.'+sig.slice(0,-2)+'AA',now),e=>e.code===400);
 assert.throws(()=>verifyState(config,state+'.x',now),e=>e.code===400);
 assert.throws(()=>verifyState(slackConfig({...env,CANOPY_SLACK_TOKEN_KEY:randomBytes(32).toString('base64')}),state,now),e=>e.code===400);
 assert.throws(()=>verifyState(config,state,claims.expires),/expired/);
 // A state minted with a far-future expiry under the right key is still refused.
 const {state:long}=issueState(config,{kind:'install',userId:'user-1',now:now+3_600_000});
 assert.throws(()=>verifyState(config,long,now),e=>e.code===400);
 assert.throws(()=>issueState(config,{kind:'admin',userId:'user-1'}),e=>e.code===400);
});

test('authorize URLs carry state, scopes and the OpenID nonce',()=>{
 const install=new URL(authorizeUrl(config,{kind:'install',state:'s',nonce:'n',redirectUri:'https://canopyide.dev/api/slack-oauth'}));
 assert.equal(install.origin+install.pathname,'https://slack.com/oauth/v2/authorize');
 assert.equal(install.searchParams.get('scope'),BOT_SCOPES.join(','));assert.equal(install.searchParams.get('state'),'s');assert.equal(install.searchParams.get('redirect_uri'),'https://canopyide.dev/api/slack-oauth');
 const link=new URL(authorizeUrl(config,{kind:'link',state:'s',nonce:'n',redirectUri:'https://canopyide.dev/api/slack-oauth'}));
 assert.equal(link.origin+link.pathname,'https://slack.com/openid/connect/authorize');
 assert.equal(link.searchParams.get('scope'),'openid profile');assert.equal(link.searchParams.get('nonce'),'n');assert.equal(link.searchParams.get('response_type'),'code');
});

test('bot tokens round-trip under AES-256-GCM bound to their team',()=>{
 const sealed=encryptToken(config.tokenKey,'plaintext-fixture','T0001');
 assert.ok(!JSON.stringify(sealed).includes('plaintext'));
 assert.equal(decryptToken(config.tokenKey,sealed,'T0001'),'plaintext-fixture');
 assert.notEqual(encryptToken(config.tokenKey,'plaintext-fixture','T0001').iv,sealed.iv);
 assert.throws(()=>decryptToken(config.tokenKey,sealed,'T0002'));
 assert.throws(()=>decryptToken(randomBytes(32),sealed,'T0001'));
 const flipped=Buffer.from(sealed.ciphertext,'base64');flipped[0]^=1;
 assert.throws(()=>decryptToken(config.tokenKey,{...sealed,ciphertext:flipped.toString('base64')},'T0001'));
});

const event=(e,extra={})=>({type:'event_callback',team_id:'T0001',event_id:'Ev1',event:{ts:'1700000000.000100',channel:'D0001',user:'U0001',...e},...extra});
test('only human DMs and channel mentions reach a companion',()=>{
 const dm=classifyEvent(event({type:'message',channel_type:'im',text:'hi'}),BOT);
 assert.deepEqual(dm,{team:'T0001',user:'U0001',channel:'D0001',channelType:'im',ts:'1700000000.000100',threadTs:null,raw:'hi',mentions:[]});
 assert.equal(classifyEvent(event({type:'message',channel_type:'im',bot_id:'B1',text:'x'}),BOT),null);
 assert.equal(classifyEvent(event({type:'message',channel_type:'im',subtype:'message_changed'}),BOT),null);
 assert.equal(classifyEvent(event({type:'message',channel_type:'im',user:BOT,text:'me'}),BOT),null);
 assert.equal(classifyEvent(event({type:'message',channel_type:'channel',channel:'C0001',text:'x'}),BOT),null);
 assert.equal(classifyEvent(event({type:'app_mention',channel_type:'im',text:`<@${BOT}> hi`}),BOT),null);
 assert.equal(classifyEvent(event({type:'reaction_added'}),BOT),null);
 assert.equal(classifyEvent(event({type:'message',channel_type:'im',channel:'not a channel'}),BOT),null);
 const mention=classifyEvent(event({type:'app_mention',channel:'C0001',text:`<@${BOT}> ask <@U0002|bob> and <@U0001> and <@U0003> <@U0002>`}),BOT);
 assert.deepEqual(mention.mentions,['U0002','U0003']);assert.equal(mention.threadTs,'1700000000.000100');assert.equal(mention.channelType,'channel');
 assert.equal(classifyEvent(event({type:'app_mention',channel:'C0001',thread_ts:'1699999999.000001',text:'x'}),BOT).threadTs,'1699999999.000001');
});

test('text drops the bot mention, names linked people and is capped',()=>{
 assert.equal(cleanText(`<@${BOT}>  please ask <@U0002> about <@U0009>`,BOT,{U0002:'Bob'}),'please ask @Bob about <@U0009>');
 assert.equal(cleanText('x'.repeat(MAX_TEXT+50),BOT).length,MAX_TEXT);
});

test('Slack transport posts JSON or forms with the bearer and surfaces errors',async()=>{
 const calls=[];const fetch=async(url,init)=>{calls.push({url,init});return {ok:true,status:200,json:async()=>url.endsWith('chat.update')?{ok:false,error:'message_not_found'}:{ok:true,ts:'1.2'}};};
 const slack=slackTransport({fetch});
 assert.equal((await slack.api('chat.postMessage',{token:'xoxb-1',body:{channel:'C1',text:'hi'}})).ts,'1.2');
 assert.equal(calls[0].url,'https://slack.com/api/chat.postMessage');assert.equal(calls[0].init.headers.authorization,'Bearer xoxb-1');assert.deepEqual(JSON.parse(calls[0].init.body),{channel:'C1',text:'hi'});
 await slack.api('oauth.v2.access',{form:{code:'c',client_id:'1'}});
 assert.equal(calls[1].init.headers['content-type'],'application/x-www-form-urlencoded');assert.equal(calls[1].init.body,'code=c&client_id=1');assert.equal(calls[1].init.headers.authorization,undefined);
 await assert.rejects(slack.api('chat.update',{token:'t',body:{}}),e=>e.slackError==='message_not_found');
 await assert.rejects(slack.respond('https://evil.example/hook',{}),/non-Slack/);
 assert.equal(isResponseUrl('https://hooks.slack.com/actions/T1/2/abc'),true);assert.equal(isResponseUrl('https://hooks.slack.com.evil.example/x'),false);
});

test('effects post DMs inline, channel notices ephemerally, and never throw',async()=>{
 const calls=[],logged=[];const slack={api:async(m,a)=>{calls.push([m,a.body]);if(a.body.channel==='CFAIL')throw Object.assign(Error('x'),{slackError:'channel_not_found'});return {ok:true};},respond:async(u,b)=>calls.push(['respond',u,b])};
 await runEffects(slack,[
  {type:'notify',token:'t',channel:'D1',channelType:'im',user:'U1',threadTs:null,text:'a'},
  {type:'notify',token:'t',channel:'CFAIL',channelType:'channel',user:'U1',threadTs:'1.1',text:'b'},
  {type:'notify',token:'t',channel:'C1',channelType:'channel',user:'U1',threadTs:'1.1',text:'c'},
  {type:'respond',url:'https://hooks.slack.com/actions/x',text:'d'}],(...a)=>logged.push(a));
 assert.deepEqual(calls[0],['chat.postMessage',{channel:'D1',text:'a'}]);
 assert.deepEqual(calls[2],['chat.postEphemeral',{channel:'C1',user:'U1',text:'c',thread_ts:'1.1'}]);
 assert.deepEqual(calls[3][2],{response_type:'ephemeral',replace_original:false,text:'d'});
 assert.equal(logged.length,1);assert.equal(logged[0][2],'channel_not_found');
});

test('interaction payloads parse from the signed form body',()=>{
 assert.deepEqual(parseInteraction(Buffer.from('payload='+encodeURIComponent(JSON.stringify({type:'block_actions'})))),{type:'block_actions'});
 assert.equal(parseInteraction(Buffer.from('payload=%7Bbad')),null);assert.equal(parseInteraction(Buffer.from('x=1')),null);
});

// Database-free guards: these return before any query, so a db that throws proves it.
const noDb={query:async()=>{throw Error('unexpected query');}};
test('events without an id, url checks and foreign interactions never touch the database',async()=>{
 assert.equal((await receiveEvent(noDb,config,{type:'event_callback',event:{}})).outcome,'ignored');
 assert.equal((await receiveEvent(noDb,config,{type:'app_rate_limited'})).outcome,'ignored');
 assert.equal((await receiveInteraction(noDb,config,{type:'view_submission'})).outcome,'ignored');
 assert.equal((await receiveInteraction(noDb,config,{type:'block_actions',actions:[{action_id:'other'}]})).outcome,'ignored');
});
test('desktop actions validate input before touching the database',async()=>{
 const ctx={user:{id:'user-1'},deviceId:'device-1'},opts={slack:{},redirectUri:'https://x'};
 for(const input of [{action:'nope'},{action:'ack',ids:'x'},{action:'ack',ids:['short']},{action:'ack',ids:Array(101).fill('abcdefgh')},{action:'reply',id:'abcdefgh',text:''},{action:'reply',id:'abcdefgh',text:'x'.repeat(39001)},{action:'approval',id:'abcdefgh',proposalId:'bad id',summary:'run'},{action:'approval',id:'abcdefgh',proposalId:'abcdefgh',summary:''},{action:'approval',id:'abcdefgh',proposalId:'abcdefgh',summary:'run',project:''},{action:'approval-cancel',proposalId:'abcdefgh',accepted:'yes'},{action:'unlink',team:'lower'}])
  await assert.rejects(slackAction(noDb,config,ctx,input,opts),e=>e.code===400,JSON.stringify(input).slice(0,80));
 await assert.rejects(slackAction(noDb,config,{...ctx,deviceId:''},{action:'poll'},opts),e=>e.code===400);
});
