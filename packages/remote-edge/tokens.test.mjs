import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { checkSecret, mint, sign, verify } from './tokens.mjs';

const SECRET = 'synthetic-remote-edge-test-key-0123456789';
const NOW = 1_800_000_000;

test('signs exactly the shared format', () => {
  const token = sign(SECRET, 'tunnel', { userId: 'u1', handle: 'alice', exp: NOW + 300 });
  const [body, mac] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url')), { userId: 'u1', handle: 'alice', exp: NOW + 300, v: 1, kind: 'tunnel' });
  const expected = createHmac('sha256', SECRET).update(`canopy-remote:tunnel:${body}`).digest('base64url');
  assert.equal(mac, expected);
  assert.equal(verify(SECRET, 'tunnel', token, NOW).handle, 'alice');
});

test('verifies a token minted by hand the way the website does', () => {
  const body = Buffer.from(JSON.stringify({ v: 1, kind: 'ticket', userId: 'u1', handle: 'alice', exp: NOW + 60, nonce: 'n', ret: '/x' })).toString('base64url');
  const mac = createHmac('sha256', SECRET).update(`canopy-remote:ticket:${body}`).digest('base64url');
  assert.equal(verify(SECRET, 'ticket', `${body}.${mac}`, NOW).ret, '/x');
});

test('mint sets lifetimes and ticket nonce', () => {
  const ticket = verify(SECRET, 'ticket', mint(SECRET, 'ticket', { userId: 'u1', handle: 'alice' }, NOW), NOW);
  assert.equal(ticket.exp, NOW + 60);
  assert.equal(Buffer.from(ticket.nonce, 'base64url').length, 16);
  assert.equal(ticket.ret, '/');
  assert.equal(verify(SECRET, 'cookie', mint(SECRET, 'cookie', { userId: 'u1', handle: 'alice' }, NOW), NOW).exp, NOW + 43200);
  assert.equal(verify(SECRET, 'tunnel', mint(SECRET, 'tunnel', { userId: 'u1', handle: 'alice' }, NOW), NOW).exp, NOW + 300);
});

test('rejects the wrong kind, even with a matching payload kind field', () => {
  const ticket = mint(SECRET, 'ticket', { userId: 'u1', handle: 'alice' }, NOW);
  assert.equal(verify(SECRET, 'cookie', ticket, NOW), null);
  assert.equal(verify(SECRET, 'tunnel', ticket, NOW), null);
  // A cookie-kind payload signed under the ticket domain separator is still not a cookie.
  const body = Buffer.from(JSON.stringify({ v: 1, kind: 'cookie', userId: 'u1', handle: 'alice', exp: NOW + 60 })).toString('base64url');
  const mac = createHmac('sha256', SECRET).update(`canopy-remote:ticket:${body}`).digest('base64url');
  assert.equal(verify(SECRET, 'cookie', `${body}.${mac}`, NOW), null);
  assert.equal(verify(SECRET, 'ticket', `${body}.${mac}`, NOW), null);
});

test('rejects expired tokens (exp must be strictly in the future)', () => {
  const token = mint(SECRET, 'tunnel', { userId: 'u1', handle: 'alice' }, NOW);
  assert.ok(verify(SECRET, 'tunnel', token, NOW + 299));
  assert.equal(verify(SECRET, 'tunnel', token, NOW + 300), null);
  assert.equal(verify(SECRET, 'tunnel', token, NOW + 10_000), null);
});

test('rejects tampered, foreign and malformed tokens', () => {
  const token = mint(SECRET, 'cookie', { userId: 'u1', handle: 'alice' }, NOW);
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), handle: 'mallory' })).toString('base64url');
  assert.equal(verify(SECRET, 'cookie', `${forged}.${mac}`, NOW), null);
  assert.equal(verify(SECRET, 'cookie', `${body}.${mac.slice(0, -2)}AA`, NOW), null);
  assert.equal(verify(`${SECRET}-other`, 'cookie', token, NOW), null);
  for (const bad of ['', '.', 'abc', `${body}.`, `.${mac}`, `${token}.x`, null, 42]) assert.equal(verify(SECRET, 'cookie', bad, NOW), null);
  const v2 = sign(SECRET, 'cookie', { userId: 'u1', handle: 'alice', exp: NOW + 60 }).split('.');
  const v2Body = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(v2[0], 'base64url')), v: 2 })).toString('base64url');
  const v2Mac = createHmac('sha256', SECRET).update(`canopy-remote:cookie:${v2Body}`).digest('base64url');
  assert.equal(verify(SECRET, 'cookie', `${v2Body}.${v2Mac}`, NOW), null);
});

test('requires a secret of at least 32 characters', () => {
  assert.throws(() => checkSecret('short'));
  assert.throws(() => checkSecret(undefined));
  assert.equal(checkSecret(SECRET), SECRET);
});

// The website mints these (canopy-website lib/canopy/remote-link.mjs, same
// vectors in its tests/remote-link.test.mjs). If the HMAC input or encoding
// drifts in either repo, every sign-in breaks — so the edge checks the
// website's exact output.
test('accepts the website\'s published token vectors', () => {
  const secret = 'x'.repeat(32);
  const tunnel = 'eyJ2IjoxLCJraW5kIjoidHVubmVsIiwidXNlcklkIjoidXNlci0xIiwiaGFuZGxlIjoic2FtIiwiZXhwIjoxOTAwMDAwMDAwfQ.aNHuI9Zaw91U_eJdN7gZ0AqyipeiOL2ruJDCGh9d-1k';
  const ticket = 'eyJ2IjoxLCJraW5kIjoidGlja2V0IiwidXNlcklkIjoidXNlci0xIiwiaGFuZGxlIjoic2FtIiwiZXhwIjoxOTAwMDAwMDAwLCJub25jZSI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUEiLCJyZXQiOiIvdGVhbT94PTEifQ.yTehIT0vwep1q4JxuqpIDGqH7U0svnx4rrM-Yjx46Uw';
  const now = 1_800_000_000;
  assert.equal(verify(secret, 'tunnel', tunnel, now)?.handle, 'sam');
  const t = verify(secret, 'ticket', ticket, now);
  assert.equal(t?.ret, '/team?x=1');
  assert.equal(t?.nonce, 'AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(verify(secret, 'ticket', tunnel, now), null);
});
