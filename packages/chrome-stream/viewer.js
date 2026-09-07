/* The iframe contains only this viewer. Website HTML never enters the IDE. */
const $ = id => document.getElementById(id);
const canvas = $('canvas');
const context = canvas.getContext('2d', { alpha: false });
const typing = $('typing');
let socket;
let parentOrigin;
let wanted = true;
let connected = false;
let frameWidth = 1280;
let frameHeight = 720;
let composing = false;
let decoding = false;
let dialogPage;
let resizeTimer;
let latestPageMessage;
const heldKeys = new Map();
const post = message => { if (parentOrigin) parent.postMessage(message, parentOrigin === 'null' ? '*' : parentOrigin); };
const send = message => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
function visibility() { send({ type: 'visible', visible: wanted && !document.hidden }); }
function resize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const r = $('screen').getBoundingClientRect();
    if (r.width > 1 && r.height > 1) send({ type: 'resize', width: r.width, height: r.height });
  }, 120);
}
function connect() {
  if (socket && socket.readyState < 2) { send({ type: 'connect' }); return; }
  socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}${location.pathname}socket`);
  socket.onopen = () => { visibility(); resize(); post({ canopy: 'stream-ready' }); };
  socket.onclose = () => { connected = false; $('status').textContent = 'Preview disconnected. Reconnect to continue.'; };
  socket.onmessage = async event => {
    const message = JSON.parse(event.data);
    if (message.type === 'frame') {
      if (decoding) { send({ type: 'ack' }); return; }
      decoding = true;
      const bytes = Uint8Array.from(atob(message.data), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      const image = new Image();
      try {
        image.src = url;
        await image.decode();
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        context.drawImage(image, 0, 0);
        frameWidth = message.width;
        frameHeight = message.height;
        canvas.dataset.viewportWidth = frameWidth;
        canvas.dataset.viewportHeight = frameHeight;
        canvas.hidden = false;
        $('welcome').hidden = true;
        connected = true;
      } finally {
        URL.revokeObjectURL(url);
        decoding = false;
        send({ type: 'ack' });
      }
    } else if (message.type === 'status') {
      $('status').textContent = message.text;
      $('status').title = message.text;
      $('status').classList.toggle('error', !!message.error);
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
  };
}
function answerDialog(accept) {
  send({ type: 'dialog', pageId: dialogPage, accept, text: $('dialog-text').value });
  $('dialog').close();
}
$('dialog-ok').onclick = () => answerDialog(true);
$('dialog-cancel').onclick = () => answerDialog(false);
$('dialog').oncancel = event => { event.preventDefault(); answerDialog(false); };
$('reconnect').onclick = connect;
$('tabs').onchange = () => send({ type: 'select', id: Number($('tabs').value) });
$('install').onclick = event => { event.preventDefault(); post({ canopy: 'install-extension' }); };
window.addEventListener('message', event => {
  if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
  if (parentOrigin && event.origin !== parentOrigin) return;
  parentOrigin = event.origin;
  if (event.data.canopy === 'stream-init') {
    wanted = !!event.data.visible;
    if (event.data.url) send({ canopy: 'navigate', url: event.data.url });
    visibility();
    if (latestPageMessage) post(latestPageMessage);
    return;
  }
  if (event.data.canopy === 'stream-visible') { wanted = !!event.data.visible; visibility(); return; }
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
document.addEventListener('visibilitychange', visibility);
new ResizeObserver(resize).observe($('screen'));
connect();
