import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createEdge } from './edge.mjs';
import { mint } from './tokens.mjs';
import { connectTunnel } from './test-client.mjs';

const SECRET = 'synthetic-remote-edge-test-key-0123456789';
const DOMAIN = 'remote.test';
const AUTH = 'https://canopyide.dev';
const T0 = 1_800_000_000_000;

async function setup(t, options = {}) {
  const clock = { ms: T0 };
  const edge = createEdge({ secret: SECRET, domain: DOMAIN, authOrigin: AUTH, now: () => clock.ms, holdMs: 150, ...options });
  const { port } = await edge.listen(0, '127.0.0.1');
  const clients = [];
  t.after(async () => { for (const c of clients) c.ws.terminate(); await edge.close(); });
  const seconds = () => Math.floor(clock.ms / 1000);
  return {
    edge, port, clock, clients,
    token: (kind, fields) => mint(SECRET, kind, { userId: 'user-1', handle: 'alice', ...fields }, seconds()),
    connect(token, server = desktop()) {
      const client = connectTunnel({ url: `ws://127.0.0.1:${port}/v1/tunnel`, token, server, headers: { host: `edge.${DOMAIN}` } });
      clients.push(client);
      return client;
    },
    cookieFor(handle = 'alice') { return `canopy_remote=${mint(SECRET, 'cookie', { userId: 'user-1', handle }, seconds())}`; },
  };
}

// A desktop stand-in: echoes what reached it, and echoes WebSocket messages.
function desktop() {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, meta: req.socket.meta, headers: req.headers, body }));
  });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ auth: req.socket.meta.auth, url: req.url, cookie: req.headers.cookie ?? null }));
      ws.on('message', (data) => ws.send(`echo:${data}`));
    });
  });
  return server;
}

function request(port, { host = `alice.${DOMAIN}`, path = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function openWs(port, { host = `alice.${DOMAIN}`, path = '/ws', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { host, ...headers } });
    ws.once('unexpected-response', (_req, res) => { resolve({ status: res.statusCode }); ws.terminate?.(); });
    ws.once('message', (data) => resolve({ ws, first: JSON.parse(data) }));
    ws.once('error', reject);
  });
}

const nextMessage = (ws) => new Promise((resolve) => ws.once('message', (d) => resolve(d.toString())));

test('healthz answers on any host', async (t) => {
  const { port } = await setup(t);
  for (const host of ['localhost', `edge.${DOMAIN}`, `alice.${DOMAIN}`]) {
    const res = await request(port, { host, path: '/healthz' });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
  }
});

test('tunnel rejects bad bearers with 401', async (t) => {
  const s = await setup(t);
  for (const token of ['nope', s.token('ticket'), s.token('cookie'), mint(`${SECRET}-x`, 'tunnel', { userId: 'u', handle: 'alice' }, T0 / 1000), s.token('tunnel', { handle: 'edge' })]) {
    await assert.rejects(s.connect(token).hello, (error) => error.status === 401);
  }
  s.clock.ms += 301_000;
  const expired = mint(SECRET, 'tunnel', { userId: 'u', handle: 'alice' }, T0 / 1000);
  await assert.rejects(s.connect(expired).hello, (error) => error.status === 401);
  assert.equal(s.edge.tunnels.size, 0);
});

test('tunnel accepts, says hello, and a second connection replaces the first with 4001', async (t) => {
  const s = await setup(t);
  const first = s.connect(s.token('tunnel'));
  assert.deepEqual(await first.hello, { t: 'hello', handle: 'alice', url: `https://alice.${DOMAIN}` });
  const second = s.connect(s.token('tunnel'));
  await second.hello;
  assert.deepEqual(await first.closed, { code: 4001, reason: 'replaced' });
  assert.equal(s.edge.tunnels.get('alice').ws.readyState, WebSocket.OPEN);
  const res = await request(s.port, { path: '/still', headers: { cookie: s.cookieFor() } });
  assert.equal(res.status, 200);
  second.close();
  await second.closed;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.edge.tunnels.has('alice'), false);
});

test('unauthenticated requests redirect to the website; unknown hosts 404', async (t) => {
  const s = await setup(t);
  const res = await request(s.port, { path: '/projects/a?tab=x&y=1' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `${AUTH}/remote/alice?ret=${encodeURIComponent('/projects/a?tab=x&y=1')}`);
  assert.equal((await request(s.port, { headers: { cookie: s.cookieFor('bob') } })).status, 302, 'cookie for another handle');
  assert.equal((await request(s.port, { host: `www.${DOMAIN}` })).status, 404);
  assert.equal((await request(s.port, { host: `a.b.${DOMAIN}` })).status, 404);
  assert.equal((await request(s.port, { host: 'example.com' })).status, 404);
  assert.equal((await request(s.port, { host: `edge.${DOMAIN}`, path: '/' })).status, 404);
});

test('sign-in ticket sets the cookie once, for its own handle only', async (t) => {
  const s = await setup(t);
  const ticket = s.token('ticket', { ret: '/projects?a=1' });
  const ok = await request(s.port, { path: `/_canopy/auth?ticket=${ticket}` });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, '/projects?a=1');
  const [cookie] = ok.headers['set-cookie'];
  assert.match(cookie, /^canopy_remote=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200$/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.equal((await request(s.port, { path: `/_canopy/auth?ticket=${ticket}` })).status, 403, 'nonce is single use');
  const bobs = s.token('ticket', { handle: 'bob' });
  assert.equal((await request(s.port, { path: `/_canopy/auth?ticket=${bobs}` })).status, 403, 'wrong host handle');
  assert.equal((await request(s.port, { host: `bob.${DOMAIN}`, path: `/_canopy/auth?ticket=${bobs}` })).status, 302);
  assert.equal((await request(s.port, { path: `/_canopy/auth?ticket=${s.token('cookie')}` })).status, 403, 'wrong kind');
  const offsite = await request(s.port, { path: `/_canopy/auth?ticket=${s.token('ticket', { ret: '//evil.example/' })}` });
  assert.equal(offsite.headers.location, '/');
  const stale = s.token('ticket');
  s.clock.ms += 61_000;
  assert.equal((await request(s.port, { path: `/_canopy/auth?ticket=${stale}` })).status, 403, 'expired');

  // The minted cookie authenticates a proxied request.
  s.connect(s.token('tunnel'));
  await s.clients[0].hello;
  const proxied = await request(s.port, { path: '/x', headers: { cookie: cookie.split(';')[0] } });
  assert.equal(proxied.status, 200);
  assert.equal(JSON.parse(proxied.body).meta.auth, 'owner');
});

test('signout clears the cookie', async (t) => {
  const s = await setup(t);
  const res = await request(s.port, { path: '/_canopy/signout' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
  assert.match(res.headers['set-cookie'][0], /^canopy_remote=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/);
});

test('proxies HTTP through the tunnel with forwarding headers and no edge cookie', async (t) => {
  const s = await setup(t);
  await s.connect(s.token('tunnel')).hello;
  const res = await request(s.port, {
    path: '/api/thing?q=1', method: 'POST', body: 'payload',
    headers: { cookie: `theme=dark; ${s.cookieFor()}; z=9`, 'x-forwarded-for': '198.51.100.7', 'content-type': 'text/plain', connection: 'keep-alive, x-drop', 'x-drop': '1' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
  const seen = JSON.parse(res.body);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/api/thing?q=1');
  assert.equal(seen.body, 'payload');
  assert.deepEqual(seen.meta, { auth: 'owner', ip: '198.51.100.7' });
  assert.equal(seen.headers.cookie, 'theme=dark; z=9');
  assert.equal(seen.headers.host, `alice.${DOMAIN}`);
  assert.equal(seen.headers['x-forwarded-for'], '198.51.100.7');
  assert.equal(seen.headers['x-forwarded-proto'], 'https');
  assert.equal(seen.headers['x-drop'], undefined);
  const only = JSON.parse((await request(s.port, { path: '/', headers: { cookie: s.cookieFor() } })).body);
  assert.equal(only.headers.cookie, undefined);
});

test('proxies WebSocket upgrades; no cookie is 401 except /team/ws', async (t) => {
  const s = await setup(t);
  await s.connect(s.token('tunnel')).hello;
  const owner = await openWs(s.port, { path: '/terminal?id=1', headers: { cookie: `${s.cookieFor()}; keep=1` } });
  assert.deepEqual(owner.first, { auth: 'owner', url: '/terminal?id=1', cookie: 'keep=1' });
  owner.ws.send('ping');
  assert.equal(await nextMessage(owner.ws), 'echo:ping');
  owner.ws.send(Buffer.alloc(200_000, 7).toString('hex').slice(0, 300_000));
  assert.equal((await nextMessage(owner.ws)).length, 'echo:'.length + 300_000);
  owner.ws.close();

  assert.equal((await openWs(s.port, { path: '/terminal' })).status, 401);
  assert.equal((await openWs(s.port, { path: '/terminal', headers: { cookie: s.cookieFor('bob') } })).status, 401);
  const team = await openWs(s.port, { path: '/team/ws' });
  assert.deepEqual(team.first, { auth: 'none', url: '/team/ws', cookie: null });
  team.ws.close();
});

test('offline handle: holds for a reconnect, then a branded 503', async (t) => {
  const s = await setup(t);
  const started = Date.now();
  const res = await request(s.port, { path: '/', headers: { cookie: s.cookieFor() } });
  assert.ok(Date.now() - started >= 140, 'held before giving up');
  assert.equal(res.status, 503);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /This Canopy is offline/);
  assert.equal((await openWs(s.port, { path: '/team/ws' })).status, 503);

  const pending = request(s.port, { path: '/late', headers: { cookie: s.cookieFor() } });
  setTimeout(() => s.connect(s.token('tunnel')), 30);
  const late = await pending;
  assert.equal(late.status, 200);
  assert.equal(JSON.parse(late.body).url, '/late');
});

test('rate limits each client IP at 60 burst, 20/s', async (t) => {
  const s = await setup(t);
  const from = (ip) => ({ path: '/', headers: { 'x-forwarded-for': `10.0.0.1, ${ip}` } });
  for (let i = 0; i < 60; i += 1) assert.equal((await request(s.port, from('203.0.113.9'))).status, 302);
  const limited = await request(s.port, from('203.0.113.9'));
  assert.equal(limited.status, 429);
  assert.equal((await request(s.port, from('203.0.113.10'))).status, 302, 'other IPs are unaffected');
  assert.equal((await request(s.port, { ...from('203.0.113.9'), path: '/healthz' })).status, 200, 'healthz is exempt');
  s.clock.ms += 110; // 2.2 tokens back at 20/s
  assert.equal((await request(s.port, from('203.0.113.9'))).status, 302);
  assert.equal((await request(s.port, from('203.0.113.9'))).status, 302);
  assert.equal((await request(s.port, from('203.0.113.9'))).status, 429);
});
