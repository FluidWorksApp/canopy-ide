import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createGateway } from './gateway.mjs';

// The agent browser's live view goes through the gateway like the desktop
// stream: a one-use ticket naming the stream (with its viewer query), drive
// scope, and the runner's close codes 4404 and 1012 reach the viewer.
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };

test('the gateway relays the agent browser stream, its viewer query and its close codes', async () => {
  const id = 'ws-11111111-1111-4111-8111-111111111111', key = 'k'.repeat(48);
  const token = claims => { const payload = Buffer.from(JSON.stringify({ workspaceId: id, expires: Math.floor(Date.now() / 1000) + 120, ...claims })).toString('base64url'); return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url'); };
  const runner = http.createServer((_request, response) => response.end('{}'));
  const runnerUrl = await listen(runner);
  const upstreamPaths = [];
  let closeWith = 4404;
  const wss = new WebSocketServer({ server: runner });
  wss.on('connection', (socket, request) => {
    upstreamPaths.push(request.url);
    socket.send(Buffer.from([0xff, 0xd8, 0xff]));
    socket.on('message', data => { if (JSON.parse(data.toString()).type === 'ack') socket.close(closeWith, closeWith === 4404 ? 'tab closed' : 'reconnect'); });
  });
  const gateway = createGateway({
    config: { workspaces: [{ id, accounts: [], memoryMiB: 1024, cpus: 1 }], principals: [{ id: 'managed-account', scope: 'drive', workspaces: [id], tokenSha256: '0'.repeat(64) }], managedSession: { workspaceId: id, key } },
    workspaces: { open: async () => ({ url: runnerUrl, token: 'synthetic' }) },
    authorizeMember: async () => true,
  });
  const base = await listen(gateway);
  const ticket = async (auth, stream) => fetch(`${base}/v1/workspaces/${id}/ticket`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify({ stream }) });
  const sockets = [];
  try {
    const viewer = token({ version: 2, memberId: 'bob', accessVersion: 1, scope: 'view' });
    // Like the desktop, a view-only member gets no browser stream.
    for (const stream of ['/desktop/ws', '/browser/stream']) {
      const refused = await ticket(viewer, stream);
      assert.deepEqual([refused.status, (await refused.json()).error], [400, 'Viewer terminals are unavailable'], stream);
    }
    assert.equal((await ticket(token({}), '/browser/stream?threadId=x')).status, 400);
    for (const expected of [4404, 1012]) {
      closeWith = expected;
      const issued = await ticket(token({}), '/browser/stream?maxWidth=2560&maxHeight=1600');
      assert.equal(issued.status, 200);
      const socket = new WebSocket(`${base.replace('http:', 'ws:')}/v1/stream?ticket=${(await issued.json()).ticket}`);
      sockets.push(socket);
      const [frame] = await once(socket, 'message');
      assert.deepEqual([...frame], [0xff, 0xd8, 0xff]);
      const closed = once(socket, 'close');
      socket.send(JSON.stringify({ type: 'ack' }));
      const [code] = await closed;
      assert.equal(code, expected);
    }
    assert.deepEqual(upstreamPaths, ['/browser/stream?maxWidth=2560&maxHeight=1600', '/browser/stream?maxWidth=2560&maxHeight=1600']);
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await close(gateway);
    await close(runner);
  }
});
