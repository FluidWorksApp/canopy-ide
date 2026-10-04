import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, authorize, digest, Tickets, validateConfig } from './policy.mjs';
const config = () => ({ workspaces: [
  { id: 'alice-work', memoryMiB: 2048, cpus: 1, accounts: ['alice', 'team'] },
  { id: 'bob-work', memoryMiB: 2048, cpus: 1, accounts: ['bob', 'team'] },
], principals: [
  { id: 'alice', tokenSha256: digest('alice-secret'), workspaces: ['alice-work'], scope: 'drive' },
  { id: 'bob', tokenSha256: digest('bob-secret'), workspaces: ['bob-work'], scope: 'view' },
] });

test('membership is required independently of authentication', () => {
  const cfg = validateConfig(config());
  const alice = authenticate(cfg, 'Bearer alice-secret');
  assert.equal(authorize(cfg, alice, 'alice-work', 'drive').id, 'alice-work');
  assert.throws(() => authorize(cfg, alice, 'bob-work'), /Forbidden/);
  assert.throws(() => authenticate(cfg, 'Bearer invalid'), /Unauthorized/);
  assert.throws(() => authorize(cfg, authenticate(cfg, 'Bearer bob-secret'), 'bob-work', 'drive'), /Forbidden/);
});
test('account pools are explicit per workspace and bad configuration fails closed', () => {
  const cfg = config();
  cfg.workspaces[0].accounts.push('../bob');
  assert.throws(() => validateConfig(cfg));
  const invalid = config(); invalid.workspaces[0].memoryMiB = 0;
  assert.throws(() => validateConfig(invalid));
  const duplicate = config(); duplicate.principals[1].tokenSha256 = duplicate.principals[0].tokenSha256;
  assert.throws(() => validateConfig(duplicate));
});
test('stream tickets expire and cannot be replayed', () => {
  let now = 0; const tickets = new Tickets(() => now);
  tickets.issue('one', { workspaceId: 'alice-work' });
  assert.equal(tickets.consume('one').workspaceId, 'alice-work');
  assert.throws(() => tickets.consume('one'));
  tickets.issue('old', {}); now = 30_000;
  assert.throws(() => tickets.consume('old'));
});
test('elastic maximums are explicit and bounded while fixed workspaces remain valid',()=>{
 const cfg=config();cfg.workspaces[0].memoryMaxMiB=16384;assert.equal(validateConfig(cfg),cfg);
 for(const value of [1024,65537,NaN,'16384',16384.5]){const invalid=config();invalid.workspaces[0].memoryMaxMiB=value;assert.throws(()=>validateConfig(invalid),/elastic memory maximum/);}
 assert.equal(validateConfig(config()).workspaces[0].memoryMaxMiB,undefined);
});

test('elastic CPU maximums preserve fixed quotas and reject invalid ranges',()=>{
 const cfg=config();cfg.workspaces[0].cpusMax=4;assert.equal(validateConfig(cfg),cfg);
 for(const value of [0,.5,33,NaN,'4']){const invalid=config();invalid.workspaces[0].cpusMax=value;assert.throws(()=>validateConfig(invalid),/elastic CPU maximum/);}
 assert.equal(validateConfig(config()).workspaces[0].cpusMax,undefined);
});

test('managed connections expire and cannot cross workspace boundaries', async () => {
  const { createHmac } = await import('node:crypto');
  const key='a'.repeat(48);
  const config={managedSession:{key,workspaceId:'managed-work'},principals:[{id:'managed-account',tokenSha256:'0'.repeat(64),scope:'drive',workspaces:['managed-work']}]};
  const token=(workspaceId,expires)=>{const payload=Buffer.from(JSON.stringify({workspaceId,expires})).toString('base64url');return 'Bearer '+payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
  const now=Math.floor(Date.now()/1000);
  assert.equal(authenticate(config,token('managed-work',now+299)).id,'managed-account');
  assert.throws(()=>authenticate(config,token('other-work',now+299)));
  assert.throws(()=>authenticate(config,token('managed-work',now-1)));
  assert.throws(()=>authenticate(config,token('managed-work',now+3600)));
  assert.throws(()=>authenticate(config,token('managed-work',now+299)+'x'));
});

test('stream grants expire and revocation or credential rotation invalidates them',async()=>{
 const {authorizeStream}=await import('./policy.mjs');const cfg=config();
 const grant={principalId:'alice',principalFingerprint:digest('alice-secret'),workspaceId:'alice-work',stream:'/desktop/ws',expiresAt:2000};
 assert.equal(authorizeStream(cfg,grant,1000).workspace.id,'alice-work');
 assert.throws(()=>authorizeStream(cfg,grant,2000),/Unauthorized/);
 cfg.principals[0].scope='view';assert.throws(()=>authorizeStream(cfg,grant,1000),/Forbidden/);
 cfg.principals[0].scope='drive';cfg.principals[0].tokenSha256=digest('rotated');assert.throws(()=>authorizeStream(cfg,grant,1000),/Unauthorized/);
 cfg.principals=[];assert.throws(()=>authorizeStream(cfg,grant,1000),/Unauthorized/);
});

test('signed member claims preserve identity and reject malformed or future versions',async()=>{
 const {createHmac}=await import('node:crypto');const key='x'.repeat(48),now=Math.floor(Date.now()/1000);
 const cfg={managedSession:{key,workspaceId:'a'},principals:[{id:'managed-account',tokenSha256:'0'.repeat(64),scope:'drive',workspaces:['a']}]};
 const sign=claims=>{const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return 'Bearer '+payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
 const claims={version:2,workspaceId:'a',memberId:'alice',accessVersion:1,scope:'drive',expires:now+120};
 assert.equal(authenticate(cfg,sign(claims)).memberId,'alice');
 for(const changed of [{version:3},{memberId:''},{accessVersion:0},{scope:'admin'}])assert.throws(()=>authenticate(cfg,sign({...claims,...changed})),/Unauthorized/);
});
