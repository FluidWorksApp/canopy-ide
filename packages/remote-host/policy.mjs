import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {sharedProjectDefinitions} from './project-catalog.mjs';

export const validId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
export const digest = value => createHash('sha256').update(value).digest('hex');

export function validateConfig(config) {
  if (!config || !Array.isArray(config.workspaces) || config.workspaces.length > 64 || !Array.isArray(config.principals)) throw new Error('Invalid host configuration');
  const ids = new Set();
  for (const workspace of config.workspaces) {
    if (!validId(workspace.id) || ids.has(workspace.id)) throw new Error('Invalid or duplicate workspace id');
    ids.add(workspace.id);
    if(workspace.ownerImage!=null&&!/^sha256:[a-f0-9]{64}$/.test(workspace.ownerImage))throw Error('Invalid owner image checkpoint');
    sharedProjectDefinitions(workspace);
    if (!Number.isInteger(workspace.memoryMiB) || workspace.memoryMiB < 512 || workspace.memoryMiB > 65536 ||
        !Number.isFinite(workspace.cpus) || workspace.cpus < 0.25 || workspace.cpus > 32) throw new Error('Workspace resource limits are required');
    if (workspace.cpusMax != null && (!Number.isFinite(workspace.cpusMax) || workspace.cpusMax < workspace.cpus || workspace.cpusMax > 32)) throw new Error('Invalid elastic CPU maximum');
    if (workspace.memoryMaxMiB != null && (!Number.isInteger(workspace.memoryMaxMiB) ||
        workspace.memoryMaxMiB < workspace.memoryMiB || workspace.memoryMaxMiB > 65536)) throw new Error('Invalid elastic memory maximum');
    if(workspace.swapRatio!=null&&(!Number.isFinite(workspace.swapRatio)||workspace.swapRatio<0||workspace.swapRatio>4))throw Error('Invalid workspace swap ratio');
    if (!Array.isArray(workspace.accounts) || !workspace.accounts.every(validId)) throw new Error('Invalid account pool');
  }
  const principals = new Set();
  const hashes = new Set();
  for (const principal of config.principals) {
    if (!validId(principal.id) || principals.has(principal.id) || !/^[a-f0-9]{64}$/.test(principal.tokenSha256) || hashes.has(principal.tokenSha256)) throw new Error('Invalid or duplicate principal');
    principals.add(principal.id); hashes.add(principal.tokenSha256);
    if (!Array.isArray(principal.workspaces) || !principal.workspaces.every(id => ids.has(id)) ||
        !['view', 'drive', 'admin'].includes(principal.scope)) throw new Error('Invalid principal grants');
  }
  if (config.managedSession && (typeof config.managedSession.key !== 'string' || config.managedSession.key.length < 32 || !ids.has(config.managedSession.workspaceId))) throw new Error('Invalid managed connection configuration');
  return config;
}

export function authenticate(config, bearer) {
  if (typeof bearer !== 'string' || !bearer.startsWith('Bearer ') || bearer.length > 1024) throw new Error('Unauthorized');
  if (config.managedSession && bearer.slice(7).includes('.')) {
    const [payload, signature, extra] = bearer.slice(7).split('.');
    const expected = createHmac('sha256', config.managedSession.key).update(payload).digest();
    const actual = Buffer.from(signature ?? '', 'base64url');
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Unauthorized');
    let claims; try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new Error('Unauthorized'); }
    const now = Math.floor(Date.now() / 1000);
    if (claims.workspaceId !== config.managedSession.workspaceId || !Number.isSafeInteger(claims.expires) || claims.expires <= now || claims.expires > now + 300) throw new Error('Unauthorized');
    const principal = config.principals.find(p => p.id === 'managed-account');
    if (!principal || principal.workspaces.length !== 1 || principal.workspaces[0] !== claims.workspaceId) throw new Error('Unauthorized');
    if (claims.version === 2) {
      if(typeof claims.memberId !== 'string' || !claims.memberId || claims.memberId.length>256 ||
         !Number.isSafeInteger(claims.accessVersion) || claims.accessVersion<1 || !['view','drive'].includes(claims.scope)) throw Error('Unauthorized');
      return {...principal,id:`member:${claims.memberId}`,memberId:claims.memberId,workspaceId:claims.workspaceId,
        accessVersion:claims.accessVersion,scope:claims.scope,expiresAt:claims.expires*1000};
    }
    if(claims.version != null)throw Error('Unauthorized');
    return {...principal, expiresAt:claims.expires*1000};
  }
  const hash = Buffer.from(digest(bearer.slice(7)), 'hex');
  const principal = config.principals.find(p => timingSafeEqual(hash, Buffer.from(p.tokenSha256, 'hex')));
  if (!principal) throw new Error('Unauthorized');
  return principal;
}

export function authorize(config, principal, workspaceId, scope = 'view') {
  const rank = { view: 0, drive: 1, admin: 2 };
  if (!principal.workspaces.includes(workspaceId) || rank[principal.scope] < rank[scope]) throw new Error('Forbidden');
  const workspace = config.workspaces.find(w => w.id === workspaceId);
  if (!workspace) throw new Error('Forbidden');
  return workspace;
}

export class Tickets {
  entries = new Map();
  constructor(now = Date.now) { this.now = now; }
  issue(key, value) {
    for (const [token, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(token);
    if (this.entries.size >= 1024) throw new Error('Ticket capacity reached');
    this.entries.set(key, { value, expires: this.now() + 30_000 });
  }
  consume(key) {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || entry.expires <= this.now()) throw new Error('Unauthorized');
    return entry.value;
  }
}

// Re-evaluate active streams, not just the HTTP request that minted a ticket.
export function authorizeStream(config, grant, now = Date.now()) {
  if (grant.expiresAt != null && (!Number.isFinite(grant.expiresAt) || grant.expiresAt <= now)) throw Error('Unauthorized');
  const template = config.principals.find(p => p.id === (grant.memberPrincipal ? 'managed-account' : grant.principalId));
  const principal = grant.memberPrincipal && template ? {...grant.memberPrincipal,tokenSha256:template.tokenSha256} : template;
  if (!principal || principal.tokenSha256 !== grant.principalFingerprint) throw Error('Unauthorized');
  const workspace = authorize(config, principal, grant.workspaceId, grant.stream === '/desktop/ws'||grant.stream.startsWith('/browsers/') ? 'drive' : 'view');
  return {principal, workspace};
}
