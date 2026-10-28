// Signed tokens shared by the website and the edge. One format, three kinds:
// token = b64url(JSON payload) + "." + b64url(HMAC-SHA256(secret, "canopy-remote:" + kind + ":" + b64url(JSON payload)))
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const KINDS = new Set(['tunnel', 'ticket', 'cookie']);
export const TTL = { tunnel: 300, ticket: 60, cookie: 43200 };
export const HANDLE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

const b64url = (value) => Buffer.from(value).toString('base64url');
const mac = (secret, kind, body) => createHmac('sha256', secret).update(`canopy-remote:${kind}:${body}`).digest();

export function checkSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('CANOPY_REMOTE_EDGE_SECRET must be at least 32 characters');
  return secret;
}

export function sign(secret, kind, payload) {
  if (!KINDS.has(kind)) throw new Error(`Unknown token kind: ${kind}`);
  const body = b64url(JSON.stringify({ ...payload, v: 1, kind }));
  return `${body}.${mac(secret, kind, body).toString('base64url')}`;
}

// Returns the payload, or null for anything that is not a live token of this kind.
// nowSeconds is unix seconds.
export function verify(secret, kind, token, nowSeconds) {
  if (!KINDS.has(kind) || typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = mac(secret, kind, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object' || payload.v !== 1 || payload.kind !== kind) return null;
  if (typeof payload.exp !== 'number' || !(payload.exp > nowSeconds)) return null;
  if (typeof payload.handle !== 'string' || !HANDLE.test(payload.handle)) return null;
  return payload;
}

// Mint helpers. The edge only mints cookies; the others exist for tests and
// for any Node caller that wants to match the website exactly.
export function mint(secret, kind, fields, nowSeconds) {
  const payload = { ...fields, exp: nowSeconds + TTL[kind] };
  if (kind === 'ticket') {
    payload.nonce ??= randomBytes(16).toString('base64url');
    payload.ret ??= '/';
  }
  return sign(secret, kind, payload);
}
