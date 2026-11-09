// The /browser/stream handler (ported from T3 Code ServerBrowserStream.ts)
// with a stand-in browser: query limits, one frame in flight, superseded
// frames acked unsent, read-only viewers, and T3's close codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { browserStreamServer, handleBrowserStream } from './browser-stream.mjs';
import { browserStream, desktopStream } from './policy.mjs';

function fakeBrowser() {
  const state = { attached: [], inputs: [], acks: [], closed: 0 };
  const items = [], takers = [];
  const output = {
    take: () => items.length ? Promise.resolve(items.shift()) : new Promise(resolve => takers.push(resolve)),
    push: item => { const taker = takers.shift(); if (taker) taker(item); else items.push(item); },
  };
  const frame = name => ({ _tag: 'frame', data: Buffer.from(name), ack: async () => { state.acks.push(name); } });
  return {
    state, output, frame,
    attachViewer: async input => { state.attached.push(input); return { output, input: async message => { state.inputs.push(message); }, close: async () => { state.closed++; output.push(null); } }; },
  };
}

async function serve(t, browser) {
  const wss = browserStreamServer();
  const server = http.createServer();
  server.on('upgrade', (request, socket, head) => void handleBrowserStream(browser, wss, request, socket, head));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return query => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/browser/stream${query}`);
    const received = [];
    ws.on('message', (data, binary) => received.push(binary ? Buffer.from(data).toString() : JSON.parse(data.toString())));
    return { ws, received };
  };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 30));

test('sends one frame at a time, the newest waiting, and acks superseded frames unsent', async t => {
  const browser = fakeBrowser();
  const connect = await serve(t, browser);
  const { ws, received } = connect('?maxWidth=99999&maxHeight=600&quality=0');
  await once(ws, 'open');
  assert.deepEqual(browser.state.attached, [{ canOperate: true, maxWidth: 7680, maxHeight: 600, quality: 70 }]);
  browser.output.push({ _tag: 'control', canOperate: true, controller: 'agent', generation: 0, dialog: null });
  for (const name of ['one', 'two', 'three']) browser.output.push(browser.frame(name));
  await tick();
  assert.deepEqual(received, [{ type: 'control', canOperate: true, controller: 'agent', generation: 0, dialog: null }, 'one']);
  assert.deepEqual(browser.state.acks, ['two'], 'the superseded frame is acked, never sent');
  ws.send(JSON.stringify({ type: 'ack' }));
  await tick();
  assert.deepEqual(received.slice(2), ['three']);
  assert.deepEqual(browser.state.acks, ['two', 'one']);
  ws.send(JSON.stringify({ type: 'takeControl' }));
  await tick();
  assert.deepEqual(browser.state.inputs, [{ type: 'takeControl' }]);
  const closed = once(ws, 'close');
  browser.output.push({ _tag: 'gone' });
  const [code, reason] = await closed;
  assert.equal(code, 4404);
  assert.equal(reason.toString(), 'tab closed');
  await tick();
  assert.equal(browser.state.closed, 1);
});

test('a read-only viewer still gets frames but its input never reaches the browser', async t => {
  const browser = fakeBrowser();
  const connect = await serve(t, browser);
  const { ws, received } = connect('?interactive=false');
  await once(ws, 'open');
  assert.equal(browser.state.attached[0].canOperate, false);
  browser.output.push(browser.frame('frame'));
  ws.send(JSON.stringify({ type: 'takeControl' }));
  await tick();
  assert.deepEqual(received, ['frame']);
  assert.deepEqual(browser.state.inputs, []);
  const closed = once(ws, 'close');
  browser.output.push({ _tag: 'reconnect' });
  assert.equal((await closed)[0], 1012);
});

test('a browser that cannot start refuses the upgrade', async t => {
  const connect = await serve(t, { attachViewer: async () => { throw new Error('Chromium is missing'); } });
  const { ws } = connect('');
  const [error] = await once(ws, 'error');
  assert.match(String(error.message), /503/);
});

test('the gateway tickets only the browser stream with T3 viewer parameters', () => {
  for (const stream of ['/browser/stream', '/browser/stream?maxWidth=2560&maxHeight=1600', '/browser/stream?maxWidth=1&quality=70&interactive=false'])
    assert.equal(desktopStream(stream), true, stream);
  for (const stream of ['/browser', '/browser/stream?threadId=x', '/browser/stream?maxWidth=-1', '/browser/stream?interactive=true', '/browser/stream?a?b', `/browser/stream?maxWidth=${'1'.repeat(300)}`, null])
    assert.equal(browserStream(stream), false, String(stream));
});
