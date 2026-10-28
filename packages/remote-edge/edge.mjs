// Canopy remote edge: https://<handle>.<domain> -> the owner's desktop Canopy over
// one tunnel WebSocket per handle. Runs on loopback behind Caddy, which
// terminates TLS for *.<domain> and edge.<domain>.
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { HANDLE, TTL, checkSecret, mint, verify } from './tokens.mjs';
import { MAX_FRAME, TunnelMux } from './tunnel.mjs';

export const RESERVED = new Set(['edge', 'www', 'api', 'claim']);
export const COOKIE = 'canopy_remote';
export const REPLACED = 4001;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade']);

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title, message, link) {
  const action = link ? `<p><a href="${escape(link.href)}">${escape(link.label)}</a></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>`
    + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#0f1411;color:#e7efe9}'
    + 'main{max-width:28rem;padding:2rem 1.5rem;text-align:center}h1{font-size:1.4rem;margin:.5rem 0}p{color:#a9b8ae}a{color:#7fd29a}.mark{font-weight:600;letter-spacing:.04em;color:#7fd29a}</style></head>'
    + `<body><main><div class="mark">Canopy</div><h1>${escape(title)}</h1><p>${escape(message)}</p>${action}</main></body></html>`;
}

function sendPage(response, status, title, message, link, headers = {}) {
  const body = page(title, message, link);
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...headers });
  response.end(body);
}

function sendText(response, status, text, headers = {}) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers });
  response.end(text);
}

function rawReply(socket, status, text = http.STATUS_CODES[status] || '') {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || ''}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${text}`);
  socket.destroySoon?.();
}

function parseCookies(header) {
  const cookies = [];
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) { if (part.trim()) cookies.push([part.trim(), null]); continue; }
    cookies.push([part.slice(0, at).trim(), part.slice(at + 1).trim()]);
  }
  return cookies;
}

function safeRet(ret) {
  return typeof ret === 'string' && ret.startsWith('/') && !ret.startsWith('//') && !ret.includes('\\') && !/[\r\n]/.test(ret) ? ret : '/';
}

function requestTarget(raw) {
  try { return new URL(raw || '/', 'http://edge.invalid'); } catch { return null; }
}

export function createEdge({
  secret, domain, authOrigin = 'https://canopyide.dev', now = Date.now,
  holdMs = 5000, rate = { burst: 60, perSecond: 20 }, pingMs = 20000, idleMs = 60000, trustProxy = true,
  log = () => {},
} = {}) {
  checkSecret(secret);
  domain = String(domain || '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes('.')) throw new Error('CANOPY_REMOTE_DOMAIN must be a DNS name');
  authOrigin = new URL(authOrigin).origin;
  const seconds = () => Math.floor(now() / 1000);
  const tunnels = new Map();
  const waiters = new Map();
  const nonces = new Map();
  const buckets = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });

  function clientIp(request) {
    const peer = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (trustProxy && (peer === '127.0.0.1' || peer === '::1')) {
      const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').pop().trim();
      if (net.isIP(forwarded)) return forwarded;
    }
    return peer;
  }

  function allow(ip) {
    const t = now() / 1000;
    let bucket = buckets.get(ip);
    if (!bucket) { bucket = { tokens: rate.burst, at: t }; buckets.set(ip, bucket); }
    bucket.tokens = Math.min(rate.burst, bucket.tokens + Math.max(0, t - bucket.at) * rate.perSecond);
    bucket.at = t;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  function classify(request) {
    const host = String(request.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    if (host === `edge.${domain}`) return { kind: 'edge' };
    if (host.endsWith(`.${domain}`)) {
      const label = host.slice(0, -(domain.length + 1));
      if (HANDLE.test(label) && !RESERVED.has(label)) return { kind: 'public', handle: label };
    }
    return { kind: 'unknown' };
  }

  function ownerCookie(request, handle) {
    for (const [name, value] of parseCookies(request.headers.cookie)) {
      if (name !== COOKIE || !value) continue;
      const claims = verify(secret, 'cookie', value, seconds());
      if (claims && claims.handle === handle) return claims;
    }
    return null;
  }

  // "none" for the team relay ingress, "owner" with a valid cookie, else null.
  function access(request, url, handle) {
    if (url.pathname === '/team/ws') return 'none';
    return ownerCookie(request, handle) ? 'owner' : null;
  }

  function signInUrl(handle, request, url) {
    const raw = String(request.url || '');
    const ret = raw.startsWith('/') && !raw.startsWith('//') ? raw : url.pathname + url.search;
    return `${authOrigin}/remote/${handle}?ret=${encodeURIComponent(ret)}`;
  }

  function waitForTunnel(handle, request) {
    const live = tunnels.get(handle);
    if (live) return Promise.resolve(live);
    if (holdMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let set = waiters.get(handle);
      if (!set) { set = new Set(); waiters.set(handle, set); }
      const done = (entry) => {
        clearTimeout(timer);
        request.off('close', gone);
        set.delete(done);
        if (!set.size) waiters.delete(handle);
        resolve(entry);
      };
      const gone = () => done(null);
      const timer = setTimeout(() => done(null), holdMs);
      request.once('close', gone);
      set.add(done);
    });
  }

  function forwardHeaders(request, ip, upgrade) {
    const named = new Set(String(request.headers.connection || '').toLowerCase().split(',').map((v) => v.trim()).filter(Boolean));
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (HOP.has(name) || named.has(name) || name.startsWith('x-forwarded-')) continue;
      if (name === 'cookie') {
        const kept = parseCookies(value).filter(([key]) => key !== COOKIE).map(([key, v]) => (v === null ? key : `${key}=${v}`));
        if (kept.length) headers.cookie = kept.join('; ');
        continue;
      }
      headers[name] = value;
    }
    headers['x-forwarded-for'] = ip;
    headers['x-forwarded-proto'] = 'https';
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = request.headers.upgrade; }
    return headers;
  }

  function responseHeaders(rawHeaders) {
    const named = new Set();
    for (let i = 0; i < rawHeaders.length; i += 2) {
      if (rawHeaders[i].toLowerCase() === 'connection') for (const v of rawHeaders[i + 1].split(',')) named.add(v.trim().toLowerCase());
    }
    const out = [];
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const name = rawHeaders[i].toLowerCase();
      if (HOP.has(name) || named.has(name)) continue;
      out.push(rawHeaders[i], rawHeaders[i + 1]);
    }
    return out;
  }

  function openUpstream(tunnel, request, meta, upgrade) {
    const stream = tunnel.mux.open(meta);
    return http.request({ method: request.method, path: request.url, headers: forwardHeaders(request, meta.ip, upgrade), createConnection: () => stream });
  }

  function proxyHttp(request, response, tunnel, meta) {
    let upstream;
    try { upstream = openUpstream(tunnel, request, meta, false); } catch { return offline(response); }
    upstream.on('response', (reply) => {
      response.writeHead(reply.statusCode, reply.statusMessage, responseHeaders(reply.rawHeaders));
      reply.pipe(response);
      reply.on('error', () => response.destroy());
    });
    upstream.on('error', () => {
      if (!response.headersSent) sendText(response, 502, 'Bad gateway');
      else response.destroy();
    });
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  }

  function proxyUpgrade(request, socket, head, tunnel, meta) {
    let upstream;
    try { upstream = openUpstream(tunnel, request, meta, true); } catch { return rawReply(socket, 503, 'This Canopy is offline'); }
    upstream.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
      let raw = `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n`;
      for (let i = 0; i < reply.rawHeaders.length; i += 2) raw += `${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}\r\n`;
      socket.write(`${raw}\r\n`);
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
    });
    upstream.on('response', (reply) => {
      // The desktop declined the upgrade: relay its answer and close.
      let raw = `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n`;
      const headers = responseHeaders(reply.rawHeaders);
      for (let i = 0; i < headers.length; i += 2) raw += `${headers[i]}: ${headers[i + 1]}\r\n`;
      socket.write(`${raw}Connection: close\r\n\r\n`);
      reply.pipe(socket);
    });
    upstream.on('error', () => rawReply(socket, 502, 'Bad gateway'));
    socket.on('close', () => upstream.destroy());
    upstream.end();
  }

  function offline(response) {
    sendPage(response, 503, 'This Canopy is offline', 'The computer behind this link is not connected right now. Open Canopy on it, check that Remote access is on, then reload this page.', null, { 'retry-after': '5' });
  }

  function signIn(request, response, handle, url) {
    const ticket = url.searchParams.get('ticket') || '';
    const claims = verify(secret, 'ticket', ticket, seconds());
    const retry = { href: `${authOrigin}/remote/${handle}`, label: 'Sign in again' };
    if (!claims || claims.handle !== handle || typeof claims.nonce !== 'string' || !claims.nonce || nonces.has(claims.nonce)) {
      return sendPage(response, 403, 'This sign-in link has expired', 'Sign-in links work once and only for a minute.', retry);
    }
    nonces.set(claims.nonce, claims.exp);
    const cookie = mint(secret, 'cookie', { userId: claims.userId, handle }, seconds());
    response.writeHead(302, {
      location: safeRet(claims.ret),
      'set-cookie': `${COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL.cookie}`,
      'cache-control': 'no-store',
    });
    response.end();
  }

  function signOut(response) {
    response.writeHead(302, {
      location: '/',
      'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      'cache-control': 'no-store',
    });
    response.end();
  }

  async function onRequest(request, response) {
    const url = requestTarget(request.url);
    if (!url) return sendText(response, 400, 'Bad request');
    if (url.pathname === '/healthz') return sendText(response, 200, 'ok');
    const ip = clientIp(request);
    if (!allow(ip)) return sendText(response, 429, 'Too many requests', { 'retry-after': '1' });
    const target = classify(request);
    if (target.kind !== 'public') return sendText(response, 404, 'Not found');
    const { handle } = target;
    if (url.pathname === '/_canopy/auth') return signIn(request, response, handle, url);
    if (url.pathname === '/_canopy/signout') return signOut(response);
    const auth = access(request, url, handle);
    if (!auth) {
      response.writeHead(302, { location: signInUrl(handle, request, url), 'cache-control': 'no-store' });
      return response.end();
    }
    const tunnel = await waitForTunnel(handle, request);
    if (response.destroyed) return;
    if (!tunnel) return offline(response);
    proxyHttp(request, response, tunnel, { auth, ip });
  }

  function acceptTunnel(request, socket, head) {
    const match = /^Bearer\s+(\S+)$/i.exec(String(request.headers.authorization || ''));
    const claims = match && verify(secret, 'tunnel', match[1], seconds());
    if (!claims || RESERVED.has(claims.handle)) return rawReply(socket, 401, 'Unauthorized');
    wss.handleUpgrade(request, socket, head, (ws) => register(ws, claims));
  }

  function register(ws, claims) {
    const { handle } = claims;
    const entry = { ws, mux: new TunnelMux(ws, { role: 'edge' }), userId: claims.userId, handle, lastSeen: now() };
    const previous = tunnels.get(handle);
    tunnels.set(handle, entry);
    if (previous) {
      previous.mux.shutdown();
      previous.ws.close(REPLACED, 'replaced');
    }
    const seen = () => { entry.lastSeen = now(); };
    ws.on('pong', seen);
    ws.on('ping', seen);
    ws.on('message', seen);
    ws.on('close', () => {
      if (tunnels.get(handle) === entry) tunnels.delete(handle);
      log('tunnel closed', handle);
    });
    ws.on('error', () => {});
    ws.send(JSON.stringify({ t: 'hello', handle, url: `https://${handle}.${domain}` }));
    log('tunnel connected', handle);
    for (const wake of [...(waiters.get(handle) || [])]) wake(entry);
  }

  async function onUpgrade(request, socket, head) {
    socket.on('error', () => {});
    const url = requestTarget(request.url);
    if (!url) return rawReply(socket, 400);
    const ip = clientIp(request);
    if (!allow(ip)) return rawReply(socket, 429, 'Too many requests');
    const target = classify(request);
    if (target.kind === 'edge') return url.pathname === '/v1/tunnel' ? acceptTunnel(request, socket, head) : rawReply(socket, 404);
    if (target.kind !== 'public') return rawReply(socket, 404);
    const auth = access(request, url, target.handle);
    if (!auth) return rawReply(socket, 401, 'Sign in required');
    const tunnel = await waitForTunnel(target.handle, socket);
    if (socket.destroyed) return;
    if (!tunnel) return rawReply(socket, 503, 'This Canopy is offline');
    proxyUpgrade(request, socket, head, tunnel, { auth, ip });
  }

  const server = http.createServer((request, response) => {
    onRequest(request, response).catch((error) => {
      log('request failed', error);
      if (!response.headersSent) sendText(response, 500, 'Internal error'); else response.destroy();
    });
  });
  server.on('upgrade', (request, socket, head) => {
    onUpgrade(request, socket, head).catch((error) => { log('upgrade failed', error); socket.destroy(); });
  });
  server.on('clientError', (_error, socket) => rawReply(socket, 400));

  const pinger = setInterval(() => {
    for (const entry of tunnels.values()) {
      if (now() - entry.lastSeen > idleMs) { entry.ws.terminate(); continue; }
      try { entry.ws.ping(); } catch {}
    }
  }, pingMs);
  pinger.unref();
  const sweeper = setInterval(() => {
    const s = seconds();
    for (const [nonce, exp] of nonces) if (exp <= s) nonces.delete(nonce);
    const t = now() / 1000;
    for (const [ip, bucket] of buckets) if (bucket.tokens + (t - bucket.at) * rate.perSecond >= rate.burst) buckets.delete(ip);
  }, 30000);
  sweeper.unref();

  return {
    server,
    tunnels,
    listen(port = 8080, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    async close() {
      clearInterval(pinger);
      clearInterval(sweeper);
      for (const set of waiters.values()) for (const wake of [...set]) wake(null);
      for (const entry of tunnels.values()) entry.ws.terminate();
      tunnels.clear();
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
