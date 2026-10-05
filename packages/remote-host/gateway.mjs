import {quarantineImageUpgrades} from './image-upgrade.mjs';
import {quarantineInterruptedMigrations} from './migration-startup.mjs';
import {runtimeReady} from './runtime-readiness.mjs';
import {RuntimeSupervisor} from './runtime-supervisor.mjs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {AgentCliSessions} from './agent-cli-sessions.mjs';
import {subscriptionCredentialLoader} from './subscription-credentials.mjs';
import {CredentialBroker} from './credential-broker.mjs';
import {CredentialTickets} from './credential-tickets.mjs';
import {credentialAuthority} from './credential-authority.mjs';
import {CredentialVault} from './credential-vault.mjs';
import {SharedAccounts} from './shared-accounts.mjs';
import {SharedSessions,sessionRuntimeJson} from './shared-sessions.mjs';
import {SharingSetup} from './sharing-setup.mjs';
import {SessionViewLeases} from './session-view-leases.mjs';
import {IdleAttestation} from './idle-attestation.mjs';
import {runtimeAuthority} from './runtime-authority.mjs';
import {memberAuthority} from './member-authority.mjs';
import {memberRuntime} from './member-runtime.mjs';
import {memberRenewal} from './member-renewal.mjs';
import {MemberLeases} from './member-leases.mjs';
import {mergeSharedProjects,sharedProjectDefinitions} from './project-catalog.mjs';
import {grantedProjects} from './project-mounts.mjs';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { authenticate, authorize, validateConfig, Tickets, authorizeStream } from './policy.mjs';
import { DockerWorkspaces } from './docker.mjs';
import {ElasticMemory, memoryRange} from './elastic-memory.mjs';
import {ElasticCpu, cpuRange} from './elastic-cpu.mjs';
import { body, json } from './http.mjs';

export function createGateway({ config, workspaces, origins = [], elasticMemory, elasticCpu, authorizeMember, authorizeRuntime, supervisor, credentialVault, sharedAccounts, credentialTickets, sharingSetup, brokerOptions={}, renewMember, now=Date.now }) {
  validateConfig(config);
  const checkMember = async (principal, bearer) => {
    if (!principal.memberId) return;
    const access=authorizeMember&&await authorizeMember(principal,bearer);
    if (!access) throw Error('Forbidden');
    return access.projectAccess?{...access.projectAccess,...(access.gitIdentity?{gitIdentity:access.gitIdentity}:{})}:undefined;
  };
  const tickets = new Tickets();
  const sessionViewLeases=new SessionViewLeases({now});
  const leases=new MemberLeases({authorize:checkMember,stop:runtime=>workspaces.suspendMember(runtime),renew:renewMember,inspectRunning:async runtime=>{const inspected=await workspaces.inspectRuntime(runtime);return inspected?.State?.Running===true&&!inspected.State.Paused;}});
  const sharedSessions=new SharedSessions({authorizeMember,stop:runtime=>workspaces.suspendMember(runtime)});
  const resolveShared=async(workspace,principal,bearer,id,operation='view')=>{
    if(!principal.memberId&&principal.id==='managed-account'&&config.managedSession?.workspaceId===workspace.id){
      sharedSessions.prune();const entry=sharedSessions.entries.get(id);
      if(!entry||entry.workspaceId!==workspace.id||operation==='interact'&&(!entry.runtime||entry.mode!=='interact')||['stopped','deleted'].includes(workspace.desiredState??workspace.desired_state))throw Error('Forbidden');return {...entry};
    }
    return sharedSessions.resolve(workspace,principal,bearer,id,operation);
  };
  if(supervisor)supervisor.authorize=async workspace=>{
    if(idleAttestation?.reserved(workspace.parentWorkspaceId??workspace.id))return false;
    if(sharingSetup?.active(workspace.parentWorkspaceId??workspace.id))return false;
    if(workspace.memberId){
      if(workspace.memberId.startsWith('collaboration:')){const parent=config.workspaces.find(w=>w.id===workspace.parentWorkspaceId);return sharedSessions.activeRuntime(workspace.id)&&!!parent&&!['stopped','deleted'].includes(parent.desiredState??parent.desired_state)&&(!config.managedSession||!!authorizeRuntime&&await authorizeRuntime(parent));}
      const entry=leases.entries.get(workspace.id);
      if(!entry||entry.stopping||entry.principal.expiresAt<=Date.now())return false;
      try{await checkMember(entry.principal,entry.bearer);return true;}catch{return false;}
    }
    const current=config.workspaces.find(w=>w.id===workspace.id);
    if(!current||current!==workspace||['stopped','deleted'].includes(current.desiredState??current.desired_state))return false;
    return config.managedSession?!!authorizeRuntime&&await authorizeRuntime(workspace):true;
  };
  const openRuntime=(workspace,principal,bearer,access,options)=>{
    const runtime=memberRuntime(workspace,principal,access);
    return principal.memberId?leases.open(runtime,principal,bearer,()=>workspaces.open(runtime,options)):workspaces.open(runtime,options);
  };
  const loadSharedCredential=credentialVault?subscriptionCredentialLoader(credentialVault,{fetchImpl:brokerOptions.refreshFetchImpl}):null;
  const ownerLeases=new Map();
  const sharedAuthority=credentialVault&&sharedAccounts&&authorizeMember?credentialAuthority({workspaces:config.workspaces,authorizeMember,bindings:(ws,project,slot)=>sharedAccounts.resolve(ws,project,slot)}):null;
  const resolveCliPrincipal=async entry=>{
    const workspace=config.workspaces.find(w=>w.id===entry.workspaceId);
    if(!workspace||['stopped','deleted'].includes(workspace.desiredState??workspace.desired_state))throw Error('Shared agent access ended');
    if(entry.isOwner){
      const current=ownerLeases.get(entry.workspaceId),currentTime=now();
      if(!current||!Number.isSafeInteger(entry.generation)||workspace.generation!==entry.generation||currentTime-current.lastClientAt>=86400000||!authorizeRuntime||!await authorizeRuntime(workspace))throw Error('Shared agent access ended');
      const inspected=await workspaces.inspectRuntime(workspace);if(inspected?.State?.Running!==true||inspected.State.Paused)throw Error('Shared agent runtime stopped');
      // Internal operation context only: never sign or return owner/admin access.
      return {...current,cliOwner:true,cliGeneration:entry.generation,memberId:'owner',workspaceId:workspace.id,scope:'drive',accessVersion:1,expiresAt:Math.min(currentTime+120000,current.lastClientAt+86400000)};
    }
    const current=[...leases.entries.values()].find(e=>!e.stopping&&e.principal.workspaceId===entry.workspaceId&&e.principal.memberId===entry.memberId&&e.principal.accessVersion===entry.accessVersion&&e.principal.scope===entry.principal.scope);
    if(!current||current.principal.expiresAt<=Date.now())throw Error('Shared agent access ended');
    await checkMember(current.principal,current.bearer);
    return {...current.principal,bearer:current.bearer};
  };
  const cliAuthority=async(principal,context)=>{
    if(!principal.cliOwner){
      const latest=await resolveCliPrincipal({workspaceId:principal.workspaceId,memberId:principal.memberId,accessVersion:principal.accessVersion,principal});
      return sharedAuthority?.(latest,context);
    }
    const workspace=config.workspaces.find(w=>w.id===context.workspaceId);
    await resolveCliPrincipal({workspaceId:context.workspaceId,isOwner:true,generation:principal.cliGeneration});
    const slots={'git:fetch':'git','git:push':'git','agents:claude':'claude','agents:claude:count-tokens':'claude','agents:claude:models':'claude','agents:codex':'codex','agents:codex:models':'codex'};
    if(!workspace||principal.workspaceId!==context.workspaceId||principal.memberId!==context.memberId||!Object.hasOwn(slots,context.operation)||!(workspace.projectMounts??[]).some(p=>p.id===context.projectId&&p.writable)||!await authorizeRuntime(workspace))return null;
    const accountId=await sharedAccounts.resolve(context.workspaceId,context.projectId,slots[context.operation]);return accountId?{...context,accountId}:null;
  };
  const cliSessions=credentialVault&&sharedAccounts&&credentialTickets&&sharedAuthority?new AgentCliSessions({now,resolvePrincipal:resolveCliPrincipal,authorize:cliAuthority,endpoint:workspace=>'https://'+workspace.id+'.workspaces.canopyide.dev',loadGitRepository:async(id,context)=>(await credentialVault.load(id,context)).repository,execute:async(principal,input,options)=>{
    const context={workspaceId:principal.workspaceId,memberId:principal.memberId,projectId:input.projectId,operation:input.operation},grant=await cliAuthority(principal,context);
    if(!grant)throw Error('Forbidden');
    const ticket=credentialTickets.issue(principal,grant,{bodySha256:(await import('node:crypto')).createHash('sha256').update(input.body).digest('hex'),advertise:input.advertise??false});
    const claims=await credentialTickets.consume(ticket,principal,input.body,{advertise:input.advertise??false});
    const broker=new CredentialBroker({...brokerOptions,authorize:async(p,c)=>{if(options.isSessionActive&&!options.isSessionActive())return null;const grant=await cliAuthority(p,c);return grant?.accountId===claims.accountId?grant:null;},loadCredential:loadSharedCredential});
    return broker.execute(principal,input,options);
  }}):null;
  const active = new Map();
  const total = counts => [...counts.values()].reduce((sum, count) => sum + count, 0);
  const idleAttestation=config.managedSession?new IdleAttestation({config,host:workspaces,authorizeRuntime,now,busy:()=>total(active)>1||total(streams)>0||workspaces.pending?.size>0||leases.pending.size>0||leases.entries.size>0||sharedSessions.entries.size>0||sharedSessions.pendingStops.size>0||cliSessions?.entries.size>0||cliSessions?.active.size>0||cliSessions?.pending.size>0||[...sessionViewLeases.entries.values()].some(entry=>entry.principal.expiresAt>now())||config.workspaces.some(w=>sharingSetup?.active(w.id))}):null;
  const acceptedOrigins = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', ...origins]);
  const server = http.createServer(async (request, response) => {
    try{if(cliSessions&&await cliSessions.handle(request,response))return;}
    catch{if(response.headersSent)response.destroy();else json(response,400,{error:'Invalid agent request'});return;}
    const origin = request.headers.origin;
    if (origin && !acceptedOrigins.has(origin)) return json(response, 403, { error: 'Origin not allowed' });
    if (origin) response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
    response.setHeader('access-control-allow-headers', 'authorization, content-type');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
    let principal,projectAccess;
    try { principal = authenticate(config, request.headers.authorization); projectAccess=await checkMember(principal,request.headers.authorization);sessionViewLeases.observe(principal,request.headers.authorization); }
    catch { return json(response, 401, { error: 'Unauthorized' }); }
    if(config.managedSession&&principal.id==='managed-account'&&!principal.memberId&&Number.isFinite(principal.expiresAt)){const old=ownerLeases.get(config.managedSession.workspaceId);if(!old||old.expiresAt<=principal.expiresAt)ownerLeases.set(config.managedSession.workspaceId,{...principal,lastClientAt:now()});}
    if (process.env.CANOPY_INSTANCE_NAME) response.setHeader('x-canopy-instance', process.env.CANOPY_INSTANCE_NAME);
    if ((active.get(principal.id) ?? 0) >= 8 || total(active) >= 32) return json(response, 429, { error: 'Too many pending operations' });
    active.set(principal.id, (active.get(principal.id) ?? 0) + 1);
    try {
      const route = new URL(request.url, 'http://gateway').pathname;
      if (route === '/v1/workspaces' && request.method === 'GET') {
        return json(response, 200, { principal: principal.id, scope: principal.scope,
          workspaces: config.workspaces.filter(w => principal.workspaces.includes(w.id)).map(w => ({ id: w.id, name: w.name ?? w.id, accounts: w.accounts, memoryMiB: w.memoryMiB, memoryMaxMiB: memoryRange(w).max, cpus: w.cpus, cpusMax: cpuRange(w).max })) });
      }
      const match = route.match(/^\/v1\/workspaces\/([a-z][a-z0-9-]{0,47})(\/.*)$/);
      if (!match) return json(response, 404, { error: 'Unknown operation' });
      const [, workspaceId, operation] = match;
      const reads = new Set(['/shared-ticket', '/shared-execute', '/shared-sessions', '/projects', '/sessions', '/files/list', '/files/read', '/git/status', '/git/diff']);
      const write = operation !== '/sessions' || request.method !== 'GET';
      const scope = operation === '/open' || operation === '/resources' || operation === '/ticket' || (reads.has(operation) && (operation !== '/sessions' || !write)) ? 'view' : 'drive';
      const workspace = authorize(config, principal, workspaceId, scope);
      if(operation!=='/idle-attestation'&&idleAttestation?.reserved(workspace.id))throw Error('Workspace idle shutdown is reserved. Retry after it finishes.');
      if(operation!=='/sharing-setup'&&sharingSetup?.active(workspace.id))throw Error('Sharing setup is moving project storage. Reconnect after it finishes.');
      if (!['GET', 'POST'].includes(request.method)) throw new Error('Unsupported method');
      if(operation==='/idle-attestation'){
        if(!idleAttestation||request.method!=='POST'||principal.memberId||principal.id!=='managed-account'||config.managedSession?.workspaceId!==workspace.id)throw Error('Forbidden');
        return json(response,200,await idleAttestation.attest(workspace,await body(request,4096)));
      }
      if(operation==='/sharing-setup'){
        if(!sharingSetup||principal.memberId||principal.id!=='managed-account'||config.managedSession?.workspaceId!==workspace.id)throw Error('Forbidden');
        if(request.method==='GET')return json(response,200,await sharingSetup.status(workspace));
        const input=await body(request,128*1024);
        if(input.action==='attest')return json(response,200,await sharingSetup.attest(workspace,input));
        if(input.action!=='start')throw Error('Unknown sharing setup action');
        return json(response,202,await sharingSetup.start(workspace,input));
      }
      if (!['/shared-ticket', '/shared-execute', '/shared-accounts', '/shared-sessions', '/projects', '/open', '/resources', '/sessions', '/ticket', '/desktop', '/files/list', '/files/read', '/files/write', '/git/status', '/git/diff', '/language/analyze', '/native'].includes(operation) && !/^\/shared-sessions\/[a-f0-9-]{36}\/input$/.test(operation) &&
          !/^\/sessions\/\d+\/(input|resize|stop)$/.test(operation)) throw new Error('Unknown operation');
      if(operation==='/shared-sessions'){
        const owner=!principal.memberId&&principal.id==='managed-account'&&config.managedSession?.workspaceId===workspace.id;
        if(request.method==='GET')return json(response,200,{sessions:owner?sharedSessions.ownerList(workspace.id):await sharedSessions.list(workspace,principal,request.headers.authorization)});
        if(!owner)throw Error('Forbidden');
        const input=await body(request,4096);
        if(input.action==='revoke'){await sharedSessions.revoke(workspace.id,input.id);return json(response,200,{sessions:sharedSessions.ownerList(workspace.id)});}
        if(['stopped','deleted'].includes(workspace.desiredState??workspace.desired_state))throw Error('Workspace is stopped');
        if(input.action==='create'){
          const entry=sharedSessions.collaboration(workspace,input);
          try{const runtime=await workspaces.open(entry.runtime,{resume:true});
            const result=await fetch(`${runtime.url}/sessions`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${runtime.token}`,'content-type':'application/json'},body:JSON.stringify({command:`cd /workspace/projects/${entry.projectId} && exec /bin/bash`,kind:'terminal',requestId:entry.id}),signal:AbortSignal.timeout(15000)});
            const data=await sessionRuntimeJson(result);if(!result.ok)throw Error('Collaboration shell could not start');sharedSessions.register(entry,data.id);
          }catch(error){await workspaces.suspendMember(entry.runtime);throw error;}
          return json(response,200,{sessions:sharedSessions.ownerList(workspace.id)});
        }
        if(input.action!=='publish'||input.mode!=='view')throw Error('Owner terminals may only be shared for viewing. Create a collaboration shell for interaction.');
        const runtime=await workspaces.open(workspace);
        const result=await fetch(`${runtime.url}/sessions`,{redirect:'error',headers:{authorization:`Bearer ${runtime.token}`},signal:AbortSignal.timeout(5000)});
        const sessions=await sessionRuntimeJson(result);if(!result.ok||!Array.isArray(sessions)||!sessions.some(s=>s.id===input.sessionId&&s.exitCode==null))throw Error('Session is not running');
        sharedSessions.publish(workspace,input);return json(response,200,{sessions:sharedSessions.ownerList(workspace.id)});
      }
      const sharedInput=operation.match(/^\/shared-sessions\/([a-f0-9-]{36})\/input$/);
      if(sharedInput){
        if(request.method!=='POST')throw Error('Forbidden');const input=await body(request,20000);
        if(typeof input.data!=='string'||Buffer.byteLength(input.data)>16384||Object.keys(input).some(k=>k!=='data'))throw Error('Invalid session input');
        const entry=await resolveShared(workspace,principal,request.headers.authorization,sharedInput[1],'interact');if(!entry.runtime)throw Error('Forbidden');
        const runtime=await workspaces.open(entry.runtime);await resolveShared(workspace,principal,request.headers.authorization,entry.id,'interact');
        const result=await fetch(`${runtime.url}/sessions/${entry.sessionId}/input`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${runtime.token}`,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(5000)});
        return json(response,result.status,{ok:result.ok});
      }
      if(operation==='/shared-ticket'||operation==='/shared-execute'){
        if(request.method!=='POST'||!principal.memberId||!credentialTickets||!credentialVault||!sharedAccounts||!authorizeMember)throw Error('Forbidden');
        const member={...principal,bearer:request.headers.authorization};
        const authority=credentialAuthority({workspaces:config.workspaces,authorizeMember,bindings:(workspaceId,projectId,slot)=>sharedAccounts.resolve(workspaceId,projectId,slot)});
        if(operation==='/shared-ticket'){
          const input=await body(request,4096);
          if(!input||Object.keys(input).some(k=>!['projectId','operation','bodySha256','advertise'].includes(k)))throw Error('Invalid credential request');
          const context={workspaceId:workspace.id,memberId:member.memberId,projectId:input.projectId,operation:input.operation};
          const grant=await authority(member,context);if(!grant)throw Error('Forbidden');
          return json(response,200,{ticket:credentialTickets.issue(member,grant,{bodySha256:input.bodySha256,advertise:input.advertise??false})});
        }
        const input=await body(request,6*1024*1024);
        if(!input||Object.keys(input).some(k=>!['ticket','body','advertise'].includes(k))||typeof input.body!=='string'||input.body.length>5592408||typeof (input.advertise??false)!=='boolean')throw Error('Invalid credential payload');
        const payload=Buffer.from(input.body,'base64');if(payload.toString('base64')!==input.body)throw Error('Invalid credential payload');
        const claims=await credentialTickets.consume(input.ticket,member,payload,{advertise:input.advertise??false});
        const broker=new CredentialBroker({...brokerOptions,authorize:async(p,c)=>{const current=await authority(p,c);return current?.accountId===claims.accountId?current:null;},loadCredential:loadSharedCredential});
        const clientGone=new AbortController(),onClose=()=>clientGone.abort();response.once('close',onClose);if(response.destroyed)clientGone.abort();
        try{
        const result=await broker.execute(member,{projectId:claims.projectId,operation:claims.operation,body:payload,...(claims.operation.startsWith('git:')?{advertise:claims.advertise}:{})},{signal:clientGone.signal});
        response.writeHead(result.status,Object.fromEntries(result.headers));
        if(result.body)await pipeline(Readable.fromWeb(result.body),response);else response.end();
        }finally{response.removeListener('close',onClose);}
        return;
      }
      if(operation==='/shared-accounts'){
        if(principal.memberId||principal.id!=='managed-account'||config.managedSession?.workspaceId!==workspace.id||!credentialVault||!sharedAccounts)throw Error('Forbidden');
        try{
          if(request.method==='GET')return json(response,200,{bindings:await sharedAccounts.list(workspace.id)});
          const input=await body(request,16384);
          if(!input||Object.keys(input).some(k=>!['action','accountId','credential','projectId','slot'].includes(k)))throw Error('Invalid account request');
          if(input.action==='import'){await credentialVault.store(workspace.id,input.accountId,input.credential);return json(response,200,{imported:true});}
          if(input.action==='remove'){await sharedAccounts.remove(workspace.id,input.accountId);return json(response,200,{removed:true});}
          if(!(workspace.projectMounts??[]).some(p=>p.id===input.projectId))throw Error('Unknown shared project');
          if(input.action==='bind')await sharedAccounts.bind(workspace.id,input.projectId,input.slot,input.accountId);
          else if(input.action==='unbind')await sharedAccounts.unbind(workspace.id,input.projectId,input.slot);
          else throw Error('Invalid account action');
          return json(response,200,{bindings:await sharedAccounts.list(workspace.id)});
        }catch{return json(response,400,{error:'Shared account request could not be completed'});}
      }
      if(operation==='/projects'){
        if(request.method!=='GET')throw Error('Project catalog is administrator-managed');
        const catalog=principal.memberId?{...workspace,projectMounts:grantedProjects(workspace,projectAccess)}:workspace;
        return json(response,200,{projects:sharedProjectDefinitions(catalog).map(p=>({id:p.id,name:p.name,components:p.components.map(c=>({id:c.id,name:c.label}))}))});
      }
      if (operation === '/ticket') {
        const args = await body(request, 4096);
        const shared=args.stream?.match(/^\/shared-sessions\/([a-f0-9-]{36})\/stream$/);
        if (!/^\/sessions\/\d+\/stream$/.test(args.stream) && args.stream !== '/desktop/ws'&&!shared) throw new Error('Invalid stream');
        if(shared)await resolveShared(workspace,principal,request.headers.authorization,shared[1]);
        authorize(config, principal, workspaceId, args.stream === '/desktop/ws' ? 'drive' : 'view');
        const ticket = randomBytes(32).toString('base64url');
        tickets.issue(ticket, { principalId: principal.id, principalFingerprint:principal.tokenSha256, expiresAt:principal.expiresAt, memberPrincipal:principal.memberId?principal:undefined, bearer:principal.memberId?request.headers.authorization:undefined, workspaceId, stream: args.stream });
        return json(response, 200, { ticket });
      }
      const opening=operation==='/open'&&request.method==='POST'?await body(request,4096):{};
      if(opening.resume===true)authorize(config,principal,workspaceId,'drive');
      const runtime = await openRuntime(workspace,principal,request.headers.authorization,projectAccess,{resume:opening.resume===true});
      if (operation === '/open') {
        if(!await runtimeReady(runtime))throw Error('Workspace services are not responding yet');
        return json(response, 200, { id: workspace.id, connected: true });
      }
      if (operation === '/resources') {
        if (request.method !== 'GET') throw Error('Resource configuration is administrator-managed');
        return json(response, 200, {...(elasticMemory?.status(workspace.id) ?? {minMiB:workspace.memoryMiB,maxMiB:memoryRange(workspace).max,currentMiB:null,status:'pending'}), cpu:elasticCpu?.status(workspace.id) ?? {minCpus:workspace.cpus,maxCpus:cpuRange(workspace).max,currentCpus:null,status:'pending'}});
      }
      const payload = request.method === 'POST' ? await body(request) : undefined;
      if(operation==='/sessions'&&request.method==='POST'){
        if(Object.hasOwn(payload??{},'sharedAgents'))throw Error('Shared agent configuration is administrator-managed');
        if(cliSessions&&payload?.projectId){const launch=await cliSessions.prepare(workspace,principal,payload.projectId,payload.requestId);if(Object.keys(launch).length)payload.sharedAgents=launch;}
      }
      if(principal.memberId&&operation==='/native'&&payload?.command==='git_commit'){
        if(!projectAccess?.gitIdentity)throw Error('Member Git identity is unavailable');
        payload.args={...payload.args,gitIdentity:projectAccess.gitIdentity};
      }
      if(principal.memberId&&operation==='/sessions'&&request.method==='POST'){
        if(!projectAccess?.gitIdentity)throw Error('Member Git identity is unavailable');
        payload.gitIdentity=projectAccess.gitIdentity;
      }
      const result = await fetch(`${(operation === "/native" || /^\/sessions\/\d+\/resize$/.test(operation)) && runtime.nativeUrl ? runtime.nativeUrl : runtime.url}${operation}`, { method: request.method, redirect:'error',
        headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(operation === "/native" && ["git_clone","git_fetch","git_pull","git_push"].includes(payload?.command) ? 330_000 : payload?.command === "profile_import_git" ? 45_000 : 15_000) });
      if(operation==='/sessions'&&request.method==='POST'&&!result.ok)cliSessions?.discard(workspace.id,principal.memberId??'owner',payload.requestId);
      const reader = result.body.getReader(); const chunks = []; let length = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Workspace response too large'); }
        chunks.push(Buffer.from(value));
      }
      let output;try{output=JSON.parse(Buffer.concat(chunks).toString());}catch(error){if(operation==='/sessions'&&request.method==='POST')cliSessions?.discard(workspace.id,principal.memberId??'owner',payload.requestId);throw error;}
      if(operation==='/sessions'&&request.method==='POST'&&result.ok&&(!Number.isSafeInteger(output?.id)||output.id<1)){cliSessions?.discard(workspace.id,principal.memberId??'owner',payload.requestId);throw Error('Invalid session startup result');}
      if(result.ok&&cliSessions){
        const actor=principal.memberId??'owner';
        if(operation==='/sessions'&&request.method==='POST'&&Number.isSafeInteger(output?.id))cliSessions.bind(workspace.id,actor,payload.requestId,output.id);
        const stopped=operation.match(/^\/sessions\/(\d+)\/stop$/);if(stopped)cliSessions.revoke(workspace.id,actor,Number(stopped[1]));
        if(operation==='/sessions'&&request.method==='GET'&&Array.isArray(output))for(const session of output)if(session.exitCode!=null)cliSessions.revoke(workspace.id,actor,session.id);
      }
      if (result.ok && (principal.memberId || workspace.projectMounts?.length) && operation === '/native' && payload?.command === 'store_load') {
        output.result=mergeSharedProjects(output.result,memberRuntime(workspace,principal,projectAccess));
      }
      if (operation === '/native' && payload?.command === 'workspace_metrics' && output.result) {
        output.result.elasticMemory = elasticMemory?.status(workspace.id) ?? null;
        output.result.elasticCpu = elasticCpu?.status(workspace.id) ?? null;
      }
      if (operation === '/native' && payload?.command === 'terminal_governor_status' && output.result?.capability && memoryRange(workspace).max > workspace.memoryMiB) {
        const allocation = elasticMemory?.status(workspace.id);
        output.result.capability.detail += ` Elastic workspace memory: ${workspace.memoryMiB/1024}–${memoryRange(workspace).max/1024} GiB.${allocation ? ` Current limit ${allocation.currentMiB/1024} GiB; host capacity permits up to ${allocation.availableMaxMiB/1024} GiB.` : ''}`;
      }
      return json(response, result.status, output);
    } catch (error) {
      if(response.headersSent){response.destroy();return;}
      json(response, error.message === 'Forbidden' ? 403 : 400, { error: error.message });
    } finally {
      const count = (active.get(principal.id) ?? 1) - 1;
      if (count) active.set(principal.id, count); else active.delete(principal.id);
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  server.maxConnections = 128;
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const streams = new Map();
  server.on('upgrade', async (request, socket, head) => {
    let release;
    try {
      if (request.headers.origin && !acceptedOrigins.has(request.headers.origin)) throw new Error('Origin not allowed');
      const url = new URL(request.url, 'http://gateway');
      if (url.pathname !== '/v1/stream') throw new Error('Invalid stream');
      const grant = tickets.consume(url.searchParams.get('ticket'));
      const {principal,workspace} = authorizeStream(config, grant);
      if(sharingSetup?.active(workspace.id))throw Error('Sharing setup is in progress');
      const projectAccess=await checkMember(principal,grant.bearer);
      if ((streams.get(principal.id) ?? 0) >= 8 || total(streams) >= 32) throw new Error('Stream capacity reached');
      streams.set(principal.id, (streams.get(principal.id) ?? 0) + 1);
      let released = false;
      release = () => { if (!released) { released = true; const count = streams.get(principal.id) - 1; if (count) streams.set(principal.id, count); else streams.delete(principal.id); } };
      const shared=grant.stream.match(/^\/shared-sessions\/([a-f0-9-]{36})\/stream$/);
      const publication=shared?await resolveShared(workspace,principal,grant.bearer,shared[1]):null;
      const runtime = publication?await workspaces.open(publication.runtime??workspace):await openRuntime(workspace,principal,grant.bearer,projectAccess);
      if(publication)await resolveShared(workspace,principal,grant.bearer,publication.id);
      if (socket.destroyed) { release(); return; }
      wss.handleUpgrade(request, socket, head, client => {
        const upstreamStream=publication?`/sessions/${publication.sessionId}/stream`:grant.stream;
        const upstream = new WebSocket(`${(grant.stream !== '/desktop/ws' && runtime.nativeUrl ? runtime.nativeUrl : runtime.url).replace('http:', 'ws:')}${upstreamStream}`, { headers: { authorization: `Bearer ${runtime.token}` }, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 10_000 });
        let checkingAuthorization=false;
        const authorizationTimer = setInterval(async () => {
          if(checkingAuthorization)return;
          checkingAuthorization=true;
          try { const renewed=publication?sessionViewLeases.renewedGrant(leases.renewedGrant(grant)):leases.renewedGrant(grant);const current=authorizeStream(config, renewed); await checkMember(current.principal,renewed.bearer);if(publication)await resolveShared(workspace,current.principal,renewed.bearer,publication.id); }
          catch { client.close(1008, 'Access expired'); upstream.terminate(); client.terminate(); }
          finally { checkingAuthorization=false; }
        }, 1000);
        authorizationTimer.unref();
        client.once('close', () => clearInterval(authorizationTimer));
        // Client input before the upstream opens is refused, never buffered.
        client.on('message', (data, binary) => {
          if (grant.stream !== '/desktop/ws') return; // terminals use scoped REST input
          if (upstream.readyState !== 1 || upstream.bufferedAmount > 1024 * 1024) return client.close(1013);
          upstream.send(data, { binary });
        });
        upstream.on('message', (data, binary) => {
          if (client.readyState !== 1) return;
          if (client.bufferedAmount > 4 * 1024 * 1024) return client.close(1013, 'Slow consumer');
          client.send(data, { binary });
        });
        client.on('close', () => { upstream.close(); release(); });
        upstream.on('close', () => client.close());
        upstream.on('error', () => client.close(1011));
        client.on('error', () => upstream.close());
      });
    } catch { release?.(); socket.destroy(); }
  });
  server.on('close',()=>{sharedSessions.close();leases.close();cliSessions?.close();supervisor?.close();});
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const config = validateConfig(JSON.parse(await readFile(process.env.CANOPY_HOST_CONFIG ?? './host.json', 'utf8')));
  const promisedBytes = config.workspaces.reduce((sum, w) => sum + w.memoryMiB * 1024 * 1024, 0);
  if (promisedBytes > os.totalmem() - 2 * 1024 * 1024 * 1024) throw new Error('Workspace limits must leave at least 2 GiB for the VM and control plane');
  const state = process.env.CANOPY_HOST_STATE ?? '/var/lib/canopy-host';
  await mkdir(state, { recursive: true, mode: 0o700 });
  const keyPath = path.join(state, 'host.key');
  let secret;
  try { secret = await readFile(keyPath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secret = randomBytes(32).toString('hex'); await writeFile(keyPath, secret, { mode: 0o600, flag: 'wx' });
  }
  const credentialVault=config.managedSession?await CredentialVault.initialize(path.join(state,'credential-vault')):undefined;
  const credentialTickets=credentialVault?await CredentialTickets.initialize(path.join(state,'credential-ticket-journal'),secret):undefined;
  const sharedAccounts=credentialVault?new SharedAccounts(credentialVault):undefined;
  const authority=runtimeAuthority(config.managedSession?.runtimePolicyUrl,config.managedSession);
  const workspaces = new DockerWorkspaces({ secret, image: process.env.CANOPY_WORKSPACE_IMAGE, registry: config.workspaces,releaseChannel:process.env.CANOPY_WORKSPACE_IMAGE,resolveRelease:authority?workspace=>authority.release({...workspace,id:workspace.parentWorkspaceId??workspace.id}):undefined,upgradeDirectory:path.join(state,'image-upgrades') });
  await quarantineImageUpgrades(path.join(state,'image-upgrades'),workspaces);
  await workspaces.recoverMigrations();
  await quarantineInterruptedMigrations({directory:path.join(state, 'migrations'),config,host:workspaces});
  // Host restart loses in-memory leases. Quarantine member processes before
  // accepting connections; only a fresh live authorization can restart them.
  await workspaces.suspendUnleasedMembers();
  const elasticMemory = new ElasticMemory({registry:config.workspaces,docker:workspaces});
  const elasticCpu = new ElasticCpu({registry:config.workspaces,docker:workspaces});
  const supervisor=new RuntimeSupervisor({directory:path.join(state,'runtime-recovery'),host:workspaces});
  const sharingSetup=config.managedSession?new SharingSetup({config,host:workspaces,directory:path.join(state,'migrations'),configPath:process.env.CANOPY_HOST_CONFIG??'./host.json',authorizeRuntime:authority}):undefined;
  const server = createGateway({ config, workspaces, renewMember:memberRenewal(config), credentialVault, sharedAccounts, credentialTickets, sharingSetup, elasticMemory, elasticCpu, supervisor, authorizeMember:memberAuthority(config.managedSession?.authorizationUrl), authorizeRuntime:authority, origins: (process.env.CANOPY_HOST_ORIGINS ?? '').split(',').filter(Boolean) });
  server.on('close', () => { elasticMemory.stop(); elasticCpu.stop(); });
  server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1', () => { elasticMemory.start(); elasticCpu.start(); supervisor.start(); console.log('Canopy remote host listening on loopback'); });
}
