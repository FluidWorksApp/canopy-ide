import {quarantineImageUpgrades} from './image-upgrade.mjs';
import {quarantineInterruptedMigrations} from './migration-startup.mjs';
import {runtimeReady} from './runtime-readiness.mjs';
import {RuntimeSupervisor} from './runtime-supervisor.mjs';
import {runtimeAuthority} from './runtime-authority.mjs';
import {memberAuthority} from './member-authority.mjs';
import {memberRuntime} from './member-runtime.mjs';
import {MemberLeases} from './member-leases.mjs';
import {mergeSharedProjects} from './project-catalog.mjs';
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

export function createGateway({ config, workspaces, origins = [], elasticMemory, elasticCpu, authorizeMember, authorizeRuntime, supervisor }) {
  validateConfig(config);
  const checkMember = async (principal, bearer) => {
    if (!principal.memberId) return;
    const access=authorizeMember&&await authorizeMember(principal,bearer);
    if (!access) throw Error('Forbidden');
    return access.projectAccess?{...access.projectAccess,...(access.gitIdentity?{gitIdentity:access.gitIdentity}:{})}:undefined;
  };
  const tickets = new Tickets();
  const leases=new MemberLeases({authorize:checkMember,stop:runtime=>workspaces.suspendMember(runtime)});
  if(supervisor)supervisor.authorize=async workspace=>{
    if(workspace.memberId){
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
  const active = new Map();
  const total = counts => [...counts.values()].reduce((sum, count) => sum + count, 0);
  const acceptedOrigins = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', ...origins]);
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && !acceptedOrigins.has(origin)) return json(response, 403, { error: 'Origin not allowed' });
    if (origin) response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
    response.setHeader('access-control-allow-headers', 'authorization, content-type');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
    let principal,projectAccess;
    try { principal = authenticate(config, request.headers.authorization); projectAccess=await checkMember(principal,request.headers.authorization); }
    catch { return json(response, 401, { error: 'Unauthorized' }); }
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
      const reads = new Set(['/sessions', '/files/list', '/files/read', '/git/status', '/git/diff']);
      const write = operation !== '/sessions' || request.method !== 'GET';
      const scope = operation === '/open' || operation === '/resources' || operation === '/ticket' || (reads.has(operation) && (operation !== '/sessions' || !write)) ? 'view' : 'drive';
      const workspace = authorize(config, principal, workspaceId, scope);
      if (!['GET', 'POST'].includes(request.method)) throw new Error('Unsupported method');
      if (!['/open', '/resources', '/sessions', '/ticket', '/desktop', '/files/list', '/files/read', '/files/write', '/git/status', '/git/diff', '/language/analyze', '/native'].includes(operation) &&
          !/^\/sessions\/\d+\/(input|resize|stop)$/.test(operation)) throw new Error('Unknown operation');
      if (operation === '/ticket') {
        const args = await body(request, 4096);
        if (!/^\/sessions\/\d+\/stream$/.test(args.stream) && args.stream !== '/desktop/ws') throw new Error('Invalid stream');
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
      const reader = result.body.getReader(); const chunks = []; let length = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Workspace response too large'); }
        chunks.push(Buffer.from(value));
      }
      const output = JSON.parse(Buffer.concat(chunks).toString());
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
      const projectAccess=await checkMember(principal,grant.bearer);
      if ((streams.get(principal.id) ?? 0) >= 8 || total(streams) >= 32) throw new Error('Stream capacity reached');
      streams.set(principal.id, (streams.get(principal.id) ?? 0) + 1);
      let released = false;
      release = () => { if (!released) { released = true; const count = streams.get(principal.id) - 1; if (count) streams.set(principal.id, count); else streams.delete(principal.id); } };
      const runtime = await openRuntime(workspace,principal,grant.bearer,projectAccess);
      if (socket.destroyed) { release(); return; }
      wss.handleUpgrade(request, socket, head, client => {
        const upstream = new WebSocket(`${(grant.stream !== '/desktop/ws' && runtime.nativeUrl ? runtime.nativeUrl : runtime.url).replace('http:', 'ws:')}${grant.stream}`, { headers: { authorization: `Bearer ${runtime.token}` }, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 10_000 });
        let checkingAuthorization=false;
        const authorizationTimer = setInterval(async () => {
          if(checkingAuthorization)return;
          checkingAuthorization=true;
          try { const renewed=leases.renewedGrant(grant);const current=authorizeStream(config, renewed); await checkMember(current.principal,renewed.bearer); }
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
  server.on('close',()=>{leases.close();supervisor?.close();});
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
  const workspaces = new DockerWorkspaces({ secret, image: process.env.CANOPY_WORKSPACE_IMAGE, registry: config.workspaces,releaseChannel:process.env.CANOPY_WORKSPACE_IMAGE,upgradeDirectory:path.join(state,'image-upgrades') });
  await quarantineImageUpgrades(path.join(state,'image-upgrades'),workspaces);
  await workspaces.recoverMigrations();
  await quarantineInterruptedMigrations({directory:path.join(state, 'migrations'),config,host:workspaces});
  // Host restart loses in-memory leases. Quarantine member processes before
  // accepting connections; only a fresh live authorization can restart them.
  await workspaces.suspendUnleasedMembers();
  const elasticMemory = new ElasticMemory({registry:config.workspaces,docker:workspaces});
  const elasticCpu = new ElasticCpu({registry:config.workspaces,docker:workspaces});
  const supervisor=new RuntimeSupervisor({directory:path.join(state,'runtime-recovery'),host:workspaces});
  const server = createGateway({ config, workspaces, elasticMemory, elasticCpu, supervisor, authorizeMember:memberAuthority(config.managedSession?.authorizationUrl), authorizeRuntime:runtimeAuthority(config.managedSession?.runtimePolicyUrl,config.managedSession), origins: (process.env.CANOPY_HOST_ORIGINS ?? '').split(',').filter(Boolean) });
  server.on('close', () => { elasticMemory.stop(); elasticCpu.stop(); });
  server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1', () => { elasticMemory.start(); elasticCpu.start(); supervisor.start(); console.log('Canopy remote host listening on loopback'); });
}
