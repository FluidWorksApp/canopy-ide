// Interactive integration check against the installed Chrome extension.
// Opens only a disposable local fixture tab; approve Canopy's pairing page.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const { ws: WebSocket } = require('playwright-core/lib/utilsBundle');
let viewerUrl;
let qaBrowser;
const fixture = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/viewer') {
    res.end(`<!doctype html><title>Canopy iframe test</title><style>body{margin:0;background:#17191c}iframe{width:100vw;height:100vh;border:0}#overlay{position:fixed;top:100px;right:20px;background:#fcda63;padding:24px;z-index:10}</style><iframe title="Chrome stream" sandbox="allow-scripts allow-same-origin" src="${viewerUrl}"></iframe><button id="overlay">IDE overlay</button><script>const f=document.querySelector('iframe');f.onload=()=>f.contentWindow.postMessage({canopy:'stream-init',visible:true},new URL(f.src).origin);window.replies=[];addEventListener('message',e=>{if(e.source===f.contentWindow)replies.push(e.data)});</script>`);
    return;
  }
  res.end(`<!doctype html><title>Canopy Chrome smoke</title><style>body{font:24px system-ui;padding:32px;background:#e7eee8}input,button{font:inherit;margin:8px}#pad{height:1600px}</style><h1>Chrome streaming test</h1><input id="entry" aria-label="Test input"><button id="button" onclick="document.querySelector('h1').textContent='Clicked'">Click test</button><a id="popup" target="_blank" href="/popup">Popup test</a><a id="next" href="/next">Navigation test</a><div id="pad"></div>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;
const bridgeScript = process.argv.includes('--isolated') ? './test-host.mjs' : '../../src-tauri/chrome-stream/server.mjs';
const child = spawn(process.execPath, [new URL(bridgeScript, import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] });
child.stdin.write(JSON.stringify({ url }) + '\n');
const line = await new Promise((resolve, reject) => {
  createInterface({ input: child.stdout }).once('line', resolve);
  child.once('exit', code => reject(new Error(`Bridge exited: ${code}`)));
});
const viewer = JSON.parse(line).url;
viewerUrl = viewer;
console.log('Bridge started; approve the Canopy connection in Chrome.');
const origin = new URL(viewer).origin;
assert.equal((await fetch(viewer)).status, 200);
assert.equal((await fetch(origin + '/')).status, 404);
const ws = new WebSocket(viewer.replace('http:', 'ws:') + 'socket', { origin });
const pending = new Map();
let nextId = 1;
let frameCount = 0;
let tabCount = 0;
let firstFrame;
const ready = new Promise(resolve => { firstFrame = resolve; });
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'status') console.log(m.text);
  if (m.type === 'tabs') tabCount = m.tabs.length;
  if (m.type === 'frame') { frameCount++; ws.send(JSON.stringify({ type: 'ack' })); firstFrame(); }
  if (m.canopy === 'agent-result' || m.canopy === 'capture-result') {
    const cb = pending.get(m.id);
    if (cb) {
      pending.delete(m.id);
      if (m.canopy === 'capture-result' && !m.error) cb.resolve(m);
      else if (m.ok) cb.resolve(m.data);
      else cb.reject(new Error(String(m.error || m.data)));
    }
  }
});
function send(m) { ws.send(JSON.stringify(m)); }
function evaluate(code) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Agent operation timed out')); }, 10_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
    send({ canopy: 'agent', id, op: 'eval', code, bg: true });
  }).then(data => data?.result);
}
try {
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('No frame: pairing or screencast did not complete.')), 180_000).unref())]);
  // The first frame can belong to about:blank before navigation.
  for (let i = 0; i < 30; i++) {
    if (await evaluate('!!document.querySelector("#entry")').catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await evaluate('document.querySelector("#entry").focus()');
  send({ type: 'text', text: 'Chrome bridge works' });
  assert.equal(await evaluate('document.querySelector("#entry").value'), 'Chrome bridge works');
  const point = await evaluate('(() => {const r=document.querySelector("#button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  send({ type: 'mouse', event: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
  send({ type: 'mouse', event: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point });
  assert.equal(await evaluate('document.querySelector("h1").textContent'), 'Clicked');
  send({ type: 'resize', width: 900, height: 650 });
  assert.equal(await evaluate('innerWidth'), 900);
  const captureId = nextId++;
  const capture = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Screenshot timed out')), 10_000);
    pending.set(captureId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
  });
  send({ canopy: 'capture', id: captureId });
  assert.ok((await capture).image.startsWith('iVBOR'));
  send({ canopy: 'navigate', url: url + 'next' });
  assert.equal(await evaluate('location.pathname'), '/next');
  send({ canopy: 'navigate', delta: -1 });
  assert.equal(await evaluate('location.pathname'), '/');
  send({ type: 'visible', visible: false });
  const count = frameCount;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(frameCount <= count + 1);
  send({ type: 'visible', visible: true });
  await evaluate('document.querySelector("#popup").click()');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(tabCount, 2);
  console.log(`PASS: ${frameCount} frames; input, click, resize, screenshot, navigation/back, hidden stream pause and popups.`);
  if (process.argv.includes('--viewer')) {
    await new Promise(resolve => { ws.once('close', resolve); ws.close(); });
    // A disposable headless browser renders the IDE-side iframe for QA only.
    // The website under test is still running in the user's extension session.
    qaBrowser = await chromium.launch({ channel: 'chrome', headless: true });
    const qa = await qaBrowser.newPage({ viewport: { width: 1000, height: 760 } });
    const errors = [];
    qa.on('pageerror', error => errors.push(error.message));
    await qa.goto(url + 'viewer');
    const iframe = qa.frameLocator('iframe');
    await iframe.locator('#canvas').waitFor({ state: 'visible' });
    await iframe.locator('#canvas[data-viewport-width="1000"]').waitFor({ state: 'visible' });
    async function uiEval(code) {
      const id = nextId++;
      await qa.evaluate(({ id, code }) => {
        const f = document.querySelector('iframe');
        f.contentWindow.postMessage({ canopy: 'agent', id, op: 'eval', code, bg: true }, new URL(f.src).origin);
      }, { id, code });
      await qa.waitForFunction(id => window.replies.some(m => m.canopy === 'agent-result' && m.id === id), id);
      return qa.evaluate(id => window.replies.find(m => m.canopy === 'agent-result' && m.id === id).data.result, id);
    }
    const inputRect = await uiEval('(() => {const r=document.querySelector("#entry").getBoundingClientRect();return {x:r.x+30,y:r.y+15,w:innerWidth,h:innerHeight}})()');
    const screen = await iframe.locator('#canvas').boundingBox();
    await iframe.locator('#canvas').click({ position: { x: inputRect.x * screen.width / inputRect.w, y: inputRect.y * screen.height / inputRect.h } });
    assert.equal(await uiEval('document.activeElement.id'), 'entry');
    await iframe.locator('#typing').pressSequentially('iframe typing');
    assert.equal(await uiEval('document.querySelector("#entry").value'), 'iframe typing');
    await qa.locator('#overlay').click();
    assert.equal(await qa.locator('#overlay').isVisible(), true);
    assert.equal(await iframe.locator('#canvas').isVisible(), true);
    const beforeOverlayUpdate = await iframe.locator('#canvas').evaluate(canvas => canvas.toDataURL());
    await uiEval('document.querySelector("h1").textContent="Live beneath the IDE overlay"');
    const viewerFrame = qa.frames().find(frame => frame.url() === viewer);
    await viewerFrame.waitForFunction(previous => document.querySelector('canvas').toDataURL() !== previous, beforeOverlayUpdate);
    await qa.screenshot({ path: '/private/tmp/canopy-chrome-stream.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: real iframe renders frames, forwards typing and stays visible under an IDE overlay. Screenshot: /private/tmp/canopy-chrome-stream.png');
  }
} finally {
  await qaBrowser?.close();
  ws.close();
  child.stdin.end();
  fixture.close();
  const exit = child.exitCode !== null ? child.exitCode : await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Bridge did not exit after stdin closed')), 4000).unref()),
  ]);
  assert.equal(exit, 0, 'bridge shutdown');
}
