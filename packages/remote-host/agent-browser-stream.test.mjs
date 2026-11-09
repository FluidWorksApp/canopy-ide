// The streamed agent browser against a real Chromium: runner /browser/stream
// over a real WebSocket, the T3 control handoff, and POST /browser's 409 while
// a person holds the page. Skipped where the image's Chromium is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { AgentBrowser } from './agent-browser.mjs';
import { createRunner } from './runner.mjs';

const CHROMIUM = process.env.CANOPY_CHROMIUM_EXECUTABLE ?? '/usr/bin/chromium';
const PICKER = new URL('../../src-tauri/src/preview_picker.js', import.meta.url);
const available = await access(CHROMIUM).then(() => access(PICKER)).then(() => true, () => false);
const secret = 'x'.repeat(64);

const PAGE = `<!doctype html><html><body style="margin:0">
<button id="b" style="position:absolute;left:0;top:0;width:200px;height:100px" onclick="window.clicks=(window.clicks||0)+1">Press</button>
<input id="field" style="position:absolute;left:0;top:200px;width:200px;height:40px">
<div style="height:3000px"></div></body></html>`;

function viewerOf(ws) {
  const frames = [];
  const messages = [];
  const waiters = new Set();
  const settle = () => { for (const waiter of [...waiters]) if (waiter.check()) { waiters.delete(waiter); waiter.resolve(); } };
  ws.on('message', (data, binary) => {
    if (binary) { frames.push(Buffer.from(data)); ws.send(JSON.stringify({ type: 'ack' })); }
    else messages.push(JSON.parse(data.toString()));
    settle();
  });
  const until = (check, label, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const waiter = { check, resolve };
    if (check()) return resolve();
    waiters.add(waiter);
    setTimeout(() => { if (waiters.delete(waiter)) reject(new Error(`timed out waiting for ${label}`)); }, timeoutMs).unref();
  });
  const control = () => messages.filter(message => message.type === 'control').at(-1);
  const send = message => ws.send(JSON.stringify(message));
  return { frames, messages, until, control, send };
}

test('a person watches, takes, uses and releases the agent browser while the agent waits', { skip: !available && 'no Chromium in this environment', timeout: 90_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'agent-browser-stream-'));
  const site = http.createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end(PAGE); });
  site.listen(0, '127.0.0.1'); await once(site, 'listening');
  const browser = new AgentBrowser({ home, executablePath: CHROMIUM, picker: PICKER });
  const runner = createRunner({ secret, spawnPty: () => { throw new Error('unused'); }, browser });
  runner.listen(0, '127.0.0.1'); await once(runner, 'listening');
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await browser.close();
    runner.closeAllConnections();
    await new Promise(resolve => runner.close(resolve));
    site.close();
    await rm(home, { recursive: true, force: true });
  });
  const pageUrl = `http://127.0.0.1:${site.address().port}/`;
  const post = async (op, args) => {
    const response = await fetch(`http://127.0.0.1:${runner.address().port}/browser`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ op, args }) });
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await post('navigate', { url: pageUrl })).status, 200);

  const ws = new WebSocket(`ws://127.0.0.1:${runner.address().port}/browser/stream?maxWidth=640&maxHeight=400`, { headers: { authorization: `Bearer ${secret}` } });
  sockets.add(ws);
  const viewer = viewerOf(ws);
  await once(ws, 'open');
  // A JPEG frame (FF D8), the agent's control and the page size arrive on attach.
  await viewer.until(() => viewer.frames.length > 0, 'a frame');
  assert.deepEqual([...viewer.frames[0].subarray(0, 2)], [0xff, 0xd8]);
  await viewer.until(() => viewer.control(), 'control');
  assert.deepEqual(viewer.control(), { type: 'control', canOperate: true, controller: 'agent', generation: 0, dialog: null });
  await viewer.until(() => viewer.messages.some(message => message.type === 'viewport'), 'viewport');
  assert.deepEqual(viewer.messages.find(message => message.type === 'viewport'), { type: 'viewport', width: 1280, height: 720 });

  // Input before taking control is refused: the agent owns the page.
  viewer.send({ type: 'mouse', action: 'down', x: 100, y: 50, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 });
  viewer.send({ type: 'mouse', action: 'up', x: 100, y: 50, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 });

  viewer.send({ type: 'takeControl' });
  await viewer.until(() => viewer.control()?.controller === 'you', 'control taken');

  // While the person controls the page, an agent action answers 409 humanControl...
  const refused = await post('eval', { code: '1' });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: 'A human controls this tab.', reason: 'humanControl' });
  // ...but reading still works.
  assert.equal((await post('console', {})).status, 200);
  await assert.rejects(browser.run('click', { selector: '#b' }), error => error.status === 409 && error.reason === 'humanControl');

  // The person clicks the button and types into the field.
  viewer.send({ type: 'mouse', action: 'move', x: 100, y: 50, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 });
  viewer.send({ type: 'mouse', action: 'down', x: 100, y: 50, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 });
  viewer.send({ type: 'mouse', action: 'up', x: 100, y: 50, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 });
  viewer.send({ type: 'mouse', action: 'down', x: 100, y: 220, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 });
  viewer.send({ type: 'mouse', action: 'up', x: 100, y: 220, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 });
  viewer.send({ type: 'text', text: 'typed by a person' });
  viewer.send({ type: 'probe', x: 100, y: 220 });
  await viewer.until(() => viewer.messages.some(message => message.type === 'probe'), 'probe');
  assert.deepEqual(viewer.messages.find(message => message.type === 'probe'), { type: 'probe', x: 100, y: 220, editable: true });
  // Wheel input scrolls the page.
  viewer.send({ type: 'wheel', x: 300, y: 300, deltaX: 0, deltaY: 400, modifiers: 0 });
  // Releasing cancels input still queued (T3's handoff), so wait for the wheel to run first.
  viewer.send({ type: 'probe', x: 1, y: 1 });
  await viewer.until(() => viewer.messages.some(message => message.type === 'probe' && message.x === 1), 'input drained');

  viewer.send({ type: 'releaseControl' });
  await viewer.until(() => viewer.control()?.controller === 'agent' && viewer.control().generation === 2, 'control released');

  // Released, the agent acts again and sees what the person did.
  const seen = await post('eval', { code: '({clicks: window.clicks ?? 0, value: document.getElementById("field").value})' });
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.deepEqual(seen.body.result, { clicks: 1, value: 'typed by a person' });
  // Chromium scrolls a wheel event on its compositor, a moment after dispatch.
  let scrolled = false;
  for (let i = 0; i < 40 && !scrolled; i++) { scrolled = (await post('eval', { code: 'scrollY > 0' })).body.result; if (!scrolled) await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(scrolled, true);

  // A dialog stays pending: the agent is refused, and only a controlling viewer can answer it.
  assert.equal((await post('eval', { code: 'setTimeout(() => { window.answer = prompt("Name?", "initial"); }, 0), true' })).status, 200);
  await viewer.until(() => viewer.control()?.dialog, 'dialog');
  assert.deepEqual(viewer.control().dialog, { type: 'prompt', message: 'Name?', defaultValue: 'initial' });
  const blocked = await post('eval', { code: '1' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.reason, 'dialogPending');
  viewer.send({ type: 'dialog', accept: true, promptText: 'ignored' });
  viewer.send({ type: 'takeControl' });
  await viewer.until(() => viewer.control()?.controller === 'you', 'control for the dialog');
  viewer.send({ type: 'dialog', accept: true, promptText: 'Ada' });
  await viewer.until(() => viewer.control()?.dialog === null && viewer.control()?.controller === 'you', 'dialog answered');
  viewer.send({ type: 'releaseControl' });
  await viewer.until(() => viewer.control()?.controller === 'agent', 'released after the dialog');
  assert.deepEqual((await post('eval', { code: 'window.answer' })).body.result, 'Ada');

  // A screenshot pauses the viewer's screencast and resumes it.
  const shot = await post('screenshot', {});
  assert.equal(shot.status, 200);
  const before = viewer.frames.length;
  assert.equal((await post('eval', { code: 'document.body.style.background = "rgb(200, 30, 30)", true' })).status, 200);
  await viewer.until(() => viewer.frames.length > before, 'a frame after the screenshot');

  // The page closing ends the stream with T3's 4404.
  const closed = once(ws, 'close');
  await browser.close();
  const [code, reason] = await closed;
  assert.equal(code, 4404);
  assert.equal(reason.toString(), 'tab closed');
});
