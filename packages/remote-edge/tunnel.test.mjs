import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DATA, END, OPEN, RESET, TunnelMux, decodeFrame, encodeFrame } from './tunnel.mjs';

test('frames are [type:u8][stream:u32 BE][payload]', () => {
  const frame = encodeFrame(DATA, 0x01020304, Buffer.from('hi'));
  assert.deepEqual([...frame], [0x02, 0x01, 0x02, 0x03, 0x04, 0x68, 0x69]);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.type, DATA);
  assert.equal(decoded.stream, 0x01020304);
  assert.equal(decoded.payload.toString(), 'hi');
  assert.equal(decodeFrame(Buffer.from([1, 0, 0])), null);
  assert.deepEqual([...encodeFrame(END, 3)], [0x03, 0, 0, 0, 3]);
});

// Two in-memory "WebSockets" wired back to back.
function pair() {
  const make = () => Object.assign(new EventEmitter(), { readyState: 1, sent: [] });
  const a = make(), b = make();
  a.send = (data, _opts, cb) => { a.sent.push(data); setImmediate(() => { b.emit('message', data, true); cb?.(); }); };
  b.send = (data, _opts, cb) => { b.sent.push(data); setImmediate(() => { a.emit('message', data, true); cb?.(); }); };
  return [a, b];
}

test('edge opens odd increasing streams and both sides half-close', async () => {
  const [edgeWs, deskWs] = pair();
  const edge = new TunnelMux(edgeWs, { role: 'edge' });
  const opened = [];
  new TunnelMux(deskWs, {
    role: 'desktop',
    onOpen: (stream, meta) => {
      opened.push([stream.id, meta]);
      let text = '';
      stream.on('data', (c) => { text += c; });
      stream.on('end', () => stream.end(`echo:${text}`));
    },
  });
  const one = edge.open({ auth: 'owner', ip: '203.0.113.1' });
  const two = edge.open({ auth: 'none', ip: '203.0.113.2' });
  assert.deepEqual([one.id, two.id], [1, 3]);
  assert.equal(decodeFrame(edgeWs.sent[0]).type, OPEN);
  const read = (s) => new Promise((resolve) => { let t = ''; s.on('data', (c) => { t += c; }); s.on('end', () => resolve(t)); });
  const replies = [read(one), read(two)];
  one.end('a');
  two.end('b');
  assert.deepEqual(await Promise.all(replies), ['echo:a', 'echo:b']);
  assert.deepEqual(opened, [[1, { auth: 'owner', ip: '203.0.113.1' }], [3, { auth: 'none', ip: '203.0.113.2' }]]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(edge.streams.size, 0);
  assert.ok(!edgeWs.sent.some((f) => decodeFrame(f).type === RESET), 'clean close sends no RESET');
});

test('RESET aborts the peer stream and tunnel close aborts all streams', async () => {
  const [edgeWs, deskWs] = pair();
  const edge = new TunnelMux(edgeWs, { role: 'edge' });
  let remote;
  new TunnelMux(deskWs, { role: 'desktop', onOpen: (s) => { remote = s; s.on('error', () => {}); } });
  const stream = edge.open({ auth: 'owner', ip: '::1' });
  stream.write('x');
  await new Promise((r) => setTimeout(r, 10));
  const aborted = new Promise((resolve) => remote.on('close', resolve));
  stream.destroy();
  await aborted;
  assert.equal(remote.destroyed, true);
  const other = edge.open({ auth: 'owner', ip: '::1' });
  const failed = new Promise((resolve) => other.on('error', resolve));
  edgeWs.emit('close');
  assert.equal((await failed).code, 'ECONNRESET');
});
