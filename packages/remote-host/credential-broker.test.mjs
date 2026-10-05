import test from 'node:test';import assert from 'node:assert/strict';import {CredentialBroker} from './credential-broker.mjs';
const principal={workspaceId:'ws-example',memberId:'alice'};
const request={projectId:'app',operation:'agents:claude',body:new TextEncoder().encode('{"messages":[]}')};
const grant={...principal,projectId:'app',operation:request.operation,accountId:'owner-agent'};
const secret='synthetic-owner-secret';
const credential={workspaceId:principal.workspaceId,accountId:grant.accountId,provider:'anthropic',token:secret};
test('shared execution sends secret only to fixed provider and strips response headers',async()=>{
 let calls=0;const broker=new CredentialBroker({authorize:async()=>grant,loadCredential:async()=>credential,fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://api.anthropic.com/v1/messages');assert.equal(options.headers['x-api-key'],secret);assert.equal(options.redirect,'error');
  return new Response('result',{headers:{'content-type':'text/event-stream','set-cookie':secret,'x-secret':secret}});
 }});
 const result=await broker.execute(principal,request);assert.equal(await result.text(),'result');assert.equal(result.headers.get('set-cookie'),null);assert.equal(result.headers.get('x-secret'),null);assert.equal(calls,1);
});
test('forged workspace/member/project/operation cannot touch the vault or provider',async()=>{
 let vault=0,provider=0;const broker=new CredentialBroker({authorize:async()=>grant,loadCredential:async()=>{vault++;return credential;},fetchImpl:async()=>{provider++;return Response.json({});}});
 for(const [p,r] of [[{...principal,memberId:'bob'},request],[{...principal,workspaceId:'other'},request],[principal,{...request,projectId:'secret'}],[principal,{...request,operation:'agents:codex'}],[principal,{...request,url:'http://169.254.169.254'}],[principal,{...request,accountId:'bob'}]])await assert.rejects(broker.execute(p,r));
 assert.equal(vault,0);assert.equal(provider,0);
});
test('revocation during vault lookup cannot start a provider request',async()=>{
 let allowed=true,provider=0;const broker=new CredentialBroker({authorize:async()=>allowed?grant:null,loadCredential:async()=>{allowed=false;return credential;},fetchImpl:async()=>{provider++;return Response.json({});}});
 await assert.rejects(broker.execute(principal,request),/Forbidden/);assert.equal(provider,0);
});
test('Git fetch cannot borrow a push grant or select a different repository',async()=>{
 const r={projectId:'app',operation:'git:fetch',advertise:true};const g={...grant,operation:r.operation};let provider=0;
 const broker=new CredentialBroker({authorize:async()=>g,loadCredential:async()=>({...credential,provider:'github',repository:'example/repo'}),fetchImpl:async(url,options)=>{
  provider++;assert.equal(url,'https://github.com/example/repo.git/info/refs?service=git-upload-pack');assert.equal(options.method,'GET');return new Response('refs');
 }});
 assert.equal(await (await broker.execute(principal,r)).text(),'refs');
 await assert.rejects(broker.execute(principal,{...r,operation:'git:push'}),/Forbidden/);
 await assert.rejects(broker.execute(principal,{...r,repository:'other/private'}));assert.equal(provider,1);
});
test('vault misbinding, unsafe token, oversized payload and transport failures fail closed',async()=>{
 for(const c of [{...credential,workspaceId:'other'},{...credential,accountId:'other'},{...credential,token:'bad\r\nheader'},{...credential,provider:'attacker'}]){
  const broker=new CredentialBroker({authorize:async()=>grant,loadCredential:async()=>c,fetchImpl:async()=>{throw Error('Must not send');}});await assert.rejects(broker.execute(principal,request));
 }
 const broker=new CredentialBroker({authorize:async()=>grant,loadCredential:async()=>credential,fetchImpl:async()=>{throw Error(secret);}});
 await assert.rejects(broker.execute(principal,{...request,body:new Uint8Array(4*1024*1024+1)}),/too large/);
 await assert.rejects(broker.execute(principal,request),error=>!error.message.includes(secret));
});

test('repository traversal and nonboolean advertisement cannot reach a provider',async()=>{
 let calls=0;const r={projectId:'app',operation:'git:fetch',advertise:true};
 for(const repository of ['../repo','example/..','example/.','example/repo/extra','example/repo?secret=1']){
  const broker=new CredentialBroker({authorize:async()=>({...grant,operation:r.operation}),loadCredential:async()=>({...credential,provider:'github',repository}),fetchImpl:async()=>{calls++;return new Response('bad');}});
  await assert.rejects(broker.execute(principal,r));
 }
 const broker=new CredentialBroker({authorize:async()=>grant,loadCredential:async()=>credential});
 await assert.rejects(broker.execute(principal,{...r,advertise:'true'}));assert.equal(calls,0);
});
test('revocation aborts an active provider stream even when its body ignores cancellation',async()=>{
 let allowed=true,signal;const broker=new CredentialBroker({pollMs:20,maxDurationMs:1000,authorize:async()=>allowed?grant:null,loadCredential:async()=>credential,fetchImpl:async(_url,options)=>{
  signal=options.signal;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('first'));},pull(){return new Promise(()=>{});}}));
 }});
 const response=await broker.execute(principal,request),reader=response.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'first');allowed=false;
 await assert.rejects(reader.read(),/Shared provider stream failed/);assert.equal(signal.aborted,true);
});
test('provider stream deadline and downstream cancellation terminate execution',async()=>{
 let signal;const make=()=>new CredentialBroker({pollMs:20,maxDurationMs:60,authorize:async()=>grant,loadCredential:async()=>credential,fetchImpl:async(_url,options)=>{signal=options.signal;return new Response(new ReadableStream({pull(){return new Promise(()=>{});}}));}});
 const response=await make().execute(principal,request);await assert.rejects(response.body.getReader().read(),/Shared provider stream failed/);assert.equal(signal.aborted,true);
 const next=await make().execute(principal,request);await next.body.cancel();assert.equal(signal.aborted,true);
});
test('provider error bodies cannot reflect credentials back to a member',async()=>{
 const broker=new CredentialBroker({authorize:async()=>grant,loadCredential:async()=>credential,fetchImpl:async()=>Response.json({error:{message:secret}},{status:401,headers:{'x-api-key':secret}})});
 const response=await broker.execute(principal,request);assert.equal(response.status,401);assert.ok(!(await response.text()).includes(secret));assert.equal(response.headers.get('x-api-key'),null);
});
test('client disconnect before provider headers aborts the upstream request',async()=>{
 const client=new AbortController();let upstream;
 const broker=new CredentialBroker({authorize:async()=>grant,loadCredential:async()=>credential,fetchImpl:async(_url,options)=>{upstream=options.signal;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error(secret)),{once:true}));}});
 const pending=broker.execute(principal,request,{signal:client.signal});setTimeout(()=>client.abort(),20);await assert.rejects(pending,error=>!error.message.includes(secret));assert.equal(upstream.aborted,true);
});
test('CLI model discovery and token counting use fixed provider routes and reject injected discovery bodies',async()=>{
 for(const [operation,provider,url,method]of [['agents:claude:count-tokens','anthropic','https://api.anthropic.com/v1/messages/count_tokens','POST'],['agents:claude:models','anthropic','https://api.anthropic.com/v1/models','GET'],['agents:codex:models','openai','https://api.openai.com/v1/models','GET']]){
  let calls=0;const broker=new CredentialBroker({authorize:async(p,c)=>({...c,accountId:'selected'}),loadCredential:async()=>({...credential,accountId:'selected',provider}),fetchImpl:async(actual,options)=>{calls++;assert.equal(actual,url);assert.equal(options.method,method);assert.equal(options.body===undefined,method==='GET');return Response.json({data:[]});}});
  const body=method==='GET'?Buffer.alloc(0):Buffer.from('{}');const result=await broker.execute(principal,{projectId:'app',operation,body});assert.equal(result.status,200);await result.json();assert.equal(calls,1);
  if(method==='GET'){await assert.rejects(broker.execute(principal,{projectId:'app',operation,body:Buffer.from('forged')}),/Unexpected model discovery body/);assert.equal(calls,1);}
 }
});
test('capability headers cannot replace authentication, redirect routing or inject CRLF',async()=>{
 let loads=0;const broker=new CredentialBroker({authorize:async()=>grant,loadCredential:async()=>{loads++;return credential;}});
 for(const providerHeaders of [{authorization:'forged'},{host:'169.254.169.254'},{'anthropic-beta':'value\r\nAuthorization: forged'},{'anthropic-beta':'x'.repeat(2049)}])await assert.rejects(broker.execute(principal,{...request,providerHeaders}),/Invalid provider capability headers/);
 assert.equal(loads,0);
});
