/* The iframe contains only this viewer. Website HTML never enters the IDE. */
import { fitContain, ViewerConnection } from './protocol.mjs';
const $ = id => document.getElementById(id);
const canvas = $('canvas');
const context = canvas.getContext('2d', { alpha: false });
const typing = $('typing');
let parentOrigin;
let wanted = true;
let connected = false;
let frameWidth = 1280;
let frameHeight = 720;
let composing = false;
let drawing = false;
let nextFrame;
let dialogPage;
let resizeTimer;
let latestPageMessage;
const parameters=new URLSearchParams(location.search),remote=parameters.get('remote')==='1';
let bridgeSessionId=parameters.get('sessionId');
if(remote)$('welcome').textContent='Connecting to your workspace browser…';
const heldKeys = new Map();
const post = message => { if (parentOrigin) parent.postMessage(message, parentOrigin === 'null' ? '*' : parentOrigin); };
const send = message => connection.send(message);
function visibility() { send({ type: 'visible', visible: wanted && !document.hidden, coalesce: true }); }
function resize() {
  layout();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const r = $('screen').getBoundingClientRect();
    if (r.width > 1 && r.height > 1) send({ type: 'resize', width: r.width, height: r.height, deviceScaleFactor: window.devicePixelRatio || 1 });
  }, 120);
}
/** Draw the frame at the pane's size rather than its own. Chrome's viewport
 *  cannot always be made to match the pane — the extension relay cannot resize
 *  the real window — so the frame that arrives may be smaller or a different
 *  shape. Scaling here fills the pane either way, and keeps the canvas element
 *  exactly the size of the picture, which is what the pointer maths measures. */
function layout() {
  const box = $('screen').getBoundingClientRect();
  const fit = fitContain({ width: canvas.width, height: canvas.height }, box);
  if (!fit.width || !fit.height) return;
  canvas.style.width = `${fit.width}px`;
  canvas.style.height = `${fit.height}px`;
}
const base64Bytes = Uint8Array.fromBase64 ? data => Uint8Array.fromBase64(data) : data => {
  const text = atob(data), bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
};
async function decodeJpeg(data) {
  const blob = new Blob([base64Bytes(data)], { type: 'image/jpeg' });
  // Decodes off the main thread, so pointer input is not held behind a frame.
  if (globalThis.createImageBitmap) return createImageBitmap(blob);
  const url = URL.createObjectURL(blob), image = new Image();
  try { image.src = url; await image.decode(); return image; } finally { URL.revokeObjectURL(url); }
}
async function drawFrame(message, sourceSocket) {
  const image = await decodeJpeg(message.data);
  try {
    if (connection.socket !== sourceSocket || !connection.ready) return;
    const width = image.naturalWidth ?? image.width, height = image.naturalHeight ?? image.height;
    // Resizing a canvas reallocates and clears it; only do so when the shape changes.
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.drawImage(image, 0, 0);
  } finally { image.close?.(); }
  frameWidth = message.width;
  frameHeight = message.height;
  canvas.dataset.viewportWidth = frameWidth;
  canvas.dataset.viewportHeight = frameHeight;
  canvas.hidden = false;
  layout();
  $('welcome').hidden = true;
  connected = true;
  $('status').textContent = 'Connected to Chrome'; $('status').classList.remove('error');
}
const connection=new ViewerConnection({
  remote,url:`${location.origin.replace('http:', 'ws:')}${location.pathname}socket`,
  requestTicket:requestId=>{if(!parentOrigin||!bridgeSessionId)return false;post({canopy:'remote-stream-ticket-request',sessionId:bridgeSessionId,requestId});},
  onReady:()=>{visibility();resize();post({canopy:'stream-ready'});},
  onDisconnect:reason=>{connected=false;$('status').textContent=reason;},
  onReopen:()=>{if(!parentOrigin||!bridgeSessionId)return false;post({canopy:'stream-reopen',sessionId:bridgeSessionId});},
  onMessage:async(message,sourceSocket)=>{
    if (message.type === 'frame') {
      // A frame that arrives mid-decode replaces the queued one but is never
      // dropped itself: the bridge filters repeats of what it last sent, so a
      // discarded newest frame would leave the preview frozen on a stale one.
      if (drawing) {
        if (nextFrame?.socket === connection.socket) send({ type: 'ack' });
        nextFrame = { message, socket: sourceSocket };
        return;
      }
      drawing = true;
      try {
        for (let frame = { message, socket: sourceSocket }; frame; frame = nextFrame, nextFrame = undefined) {
          try { await drawFrame(frame.message, frame.socket); }
          finally { if (connection.socket === frame.socket) send({ type: 'ack' }); }
        }
      } finally { drawing = false; nextFrame = undefined; }
    } else if (message.type === 'status') {
      $('status').textContent = message.text;
      $('status').title = message.text;
      $('status').classList.toggle('error', !!message.error);
      if(message.reconnect)connection.reopen();
    } else if (message.type === 'tabs') {
      $('tabs').replaceChildren(...message.tabs.map(tab => {
        const option = document.createElement('option');
        option.value = tab.id;
        option.textContent = tab.url;
        return option;
      }));
      $('tabs').value = message.active;
      $('tabs').hidden = message.tabs.length < 2;
      if (!message.active) { canvas.hidden = true; connected = false; $('welcome').hidden = false; }
    } else if (message.type === 'dialog') {
      dialogPage = message.pageId;
      $('dialog-message').textContent = message.message;
      $('dialog-text').value = message.defaultValue || '';
      $('dialog-text').hidden = message.kind !== 'prompt';
      $('dialog-cancel').hidden = message.kind === 'alert';
      $('dialog').showModal();
    } else if (message.canopy) {
      if (message.canopy === 'ready' || message.canopy === 'nav') latestPageMessage = message;
      post(message);
    }
  },
});
function connect(){connection.reconnect();}
function answerDialog(accept) {
  send({ type: 'dialog', pageId: dialogPage, accept, text: $('dialog-text').value });
  $('dialog').close();
}
$('dialog-ok').onclick = () => answerDialog(true);
$('dialog-cancel').onclick = () => answerDialog(false);
$('dialog').oncancel = event => { event.preventDefault(); answerDialog(false); };
$('reconnect').onclick = connect;
$('tabs').onchange = () => send({ type: 'select', id: Number($('tabs').value) });
$('install')?.addEventListener('click',event => { event.preventDefault(); post({ canopy: 'install-extension' }); });
window.addEventListener('message', event => {
  if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
  if (parentOrigin && event.origin !== parentOrigin) return;
  parentOrigin = event.origin;
  if(remote&&event.data.canopy==='remote-stream-ticket'){
    if(event.data.sessionId===bridgeSessionId)connection.ticket(event.data.url,event.data.requestId);return;
  }
  if(remote&&event.data.canopy==='remote-stream-ticket-error'){
    if(event.data.sessionId===bridgeSessionId)connection.ticketFailed(event.data.requestId);return;
  }
  if (event.data.canopy === 'stream-init') {
    wanted = !!event.data.visible;
    bridgeSessionId=event.data.sessionId||bridgeSessionId;
    connection.setVisible(wanted&&!document.hidden);
    if (event.data.url&&event.data.url!==latestPageMessage?.url) send({ canopy: 'navigate', url: event.data.url });
    visibility();
    if (latestPageMessage) post(latestPageMessage);
    return;
  }
  if (event.data.canopy === 'stream-visible') { wanted = !!event.data.visible; connection.setVisible(wanted&&!document.hidden);visibility();if(wanted)resize();return; }
  send(event.data);
});
const modifiers = event => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
function mouse(event, type) {
  if (!connected) return;
  const rect = canvas.getBoundingClientRect();
  send({ type: 'mouse', event: type,
    x: (event.clientX - rect.left) * frameWidth / rect.width,
    y: (event.clientY - rect.top) * frameHeight / rect.height,
    button: ['left', 'middle', 'right'][event.button] || 'none', buttons: event.buttons,
    clickCount: type === 'mouseMoved' ? 0 : event.detail || 1, modifiers: modifiers(event),
    deltaX: event.deltaX || 0, deltaY: event.deltaY || 0,
  });
}
canvas.onpointerdown = event => {
  event.preventDefault();
  typing.focus({ preventScroll: true });
  canvas.setPointerCapture(event.pointerId);
  post({ canopy: 'input' });
  mouse(event, 'mousePressed');
};
canvas.onpointerup = event => mouse(event, 'mouseReleased');
canvas.onpointercancel = event => mouse(event, 'mouseReleased');
let lastMove = 0;
canvas.onpointermove = event => {
  if (performance.now() - lastMove < 24) return;
  lastMove = performance.now();
  mouse(event, 'mouseMoved');
};
canvas.oncontextmenu = event => event.preventDefault();
canvas.addEventListener('wheel', event => { event.preventDefault(); mouse(event, 'mouseWheel'); }, { passive: false });
typing.addEventListener('compositionstart', () => { composing = true; });
typing.addEventListener('compositionend', event => { composing = false; send({ type: 'text', text: event.data }); typing.value = ''; });
typing.addEventListener('keydown', event => {
  if (composing || event.isComposing || event.key === 'Process') return;
  // Let the OS deliver paste as a paste event; ordinary typing goes to Chrome
  // as a real key event, preserving app shortcuts and key handlers.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return;
  event.preventDefault();
  heldKeys.set(event.code, { key: event.key, code: event.code, keyCode: event.keyCode });
  send({ type: 'key', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiers(event),
    text: event.key === 'Enter' ? '\r' : event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey ? event.key : undefined });
});
typing.addEventListener('keyup', event => {
  heldKeys.delete(event.code);
  if (!composing) send({ type: 'key', up: true, key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiers(event) });
});
typing.addEventListener('blur', () => {
  for (const key of heldKeys.values()) send({ type: 'key', up: true, modifiers: 0, ...key });
  heldKeys.clear();
});
typing.addEventListener('paste', event => { event.preventDefault(); send({ type: 'text', text: event.clipboardData.getData('text/plain') }); });
document.addEventListener('visibilitychange',()=>{connection.setVisible(wanted&&!document.hidden);visibility();if(!document.hidden)resize();});
window.addEventListener('online',()=>connection.connect());
window.addEventListener('pagehide',()=>connection.dispose());
new ResizeObserver(resize).observe($('screen'));
connection.connect();
