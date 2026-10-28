// Minimal desktop side of the tunnel protocol, for tests and as a reference for
// the desktop implementation. Each OPEN becomes a socket-shaped Duplex handed to
// an http.Server as a new connection, exactly like an accepted TCP socket.
// stream.meta is the OPEN payload: {auth: "owner" | "none", ip}.
// Export-only on purpose: node --test also loads test-*.mjs files.
import { WebSocket } from 'ws';
import { TunnelMux } from './tunnel.mjs';

export function connectTunnel({ url, token, server, onOpen, headers = {} }) {
  const ws = new WebSocket(url, { headers: { ...headers, authorization: `Bearer ${token}` }, perMessageDeflate: false });
  const mux = new TunnelMux(ws, {
    role: 'desktop',
    onOpen: onOpen || ((stream) => server.emit('connection', stream)),
  });
  const hello = new Promise((resolve, reject) => {
    ws.once('message', (data, isBinary) => {
      if (isBinary) return reject(new Error('Expected a text hello'));
      try { resolve(JSON.parse(data.toString('utf8'))); } catch (error) { reject(error); }
    });
    ws.once('unexpected-response', (_request, response) => reject(Object.assign(new Error(`Tunnel refused: ${response.statusCode}`), { status: response.statusCode })));
    ws.once('error', reject);
    ws.once('close', (code) => reject(Object.assign(new Error(`Tunnel closed: ${code}`), { code })));
  });
  hello.catch(() => {});
  const closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') })));
  return { ws, mux, hello, closed, close: () => ws.close(1000) };
}
