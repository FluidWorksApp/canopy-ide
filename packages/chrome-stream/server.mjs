import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connectChrome, pageSession, WebSocketServer } from './playwright.mjs';
import { FrameGate, viewportSize, websiteUrl } from './protocol.mjs';

export async function startBridge(config, connectBrowser = connectChrome) {
  const lines = createInterface({ input: process.stdin });
  const initialUrl = websiteUrl(config.url);
  const picker = await readFile(new URL('./preview_picker.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('./viewer.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('./viewer.js', import.meta.url), 'utf8');
  const token = randomBytes(32).toString('hex');
  let origin;
  let viewer;
  let browser;
  let connecting;
  let closing = false;
  let active;
  let serial = 0;
  let size = { width: 1280, height: 720 };
  let pendingUrl = initialUrl;
  let visible = true;
  const pages = new Map();
  const ownedPages = new Set();
  const gate = new FrameGate();
  const send = message => {
    if (viewer?.readyState === 1) viewer.send(JSON.stringify(message));
  };
  const status = (text, error = false) => send({ type: 'status', text, error });
  const fail = error => status(String(error.message || error), true);
  const tabs = () => send({ type: 'tabs', active: active?.id, tabs: [...pages.values()].map(p => ({ id: p.id, url: p.page.url() })) });

  async function select(entry) {
    if (active?.session) await active.session.send('Page.stopScreencast').catch(() => {});
    active = entry;
    gate.reset();
    tabs();
    if (!entry) return status('The Chrome tab was closed. Reconnect to open a new tab.', true);
    await entry.page.setViewportSize(size);
    send({ canopy: 'nav', url: entry.page.url(), title: await entry.page.title().catch(() => '') });
    if (visible) await startFrames(entry);
  }

  async function startFrames(entry) {
    await entry.session.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 });
  }

  async function attach(page) {
    ownedPages.add(page);
    if (closing || page.isClosed()) return;
    const entry = { id: ++serial, page, session: pageSession(page) };
    pages.set(entry.id, entry);
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(30_000);
    await page.exposeBinding('__canopyStreamSend', ({ frame }, message) => {
      if (active === entry && frame === page.mainFrame() && message && typeof message === 'object') send(message);
    });
    const source = `if (window === window.top) { window.__canopyStreamBrowser = true; ${picker}\n }`;
    await page.addInitScript({ content: source });
    await page.evaluate(source).catch(() => {});
    entry.session.on('Page.screencastFrame', frame => {
      void entry.session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      if (entry !== active || !visible || viewer?.readyState !== 1 || viewer.bufferedAmount > 2_000_000) return;
      gate.offer(send, { type: 'frame', data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight });
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        tabs();
        if (entry === active) send({ canopy: 'nav', url: page.url(), title: '' });
      }
    });
    page.on('popup', popup => void attach(popup).catch(fail));
    page.on('dialog', dialog => {
      // Native JavaScript dialogs cannot appear in the pixel stream. Surface
      // them in the viewer; the answer goes back to the actual Chrome dialog.
      entry.dialog = dialog;
      send({ type: 'dialog', pageId: entry.id, kind: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() });
    });
    page.on('close', () => {
      ownedPages.delete(page);
      pages.delete(entry.id);
      if (entry === active) void select([...pages.values()].at(-1)).catch(fail);
      else tabs();
    });
    await select(entry);
    status('Connected to Chrome');
    return entry;
  }

  async function connect() {
    if (connecting || (browser && active)) return;
    status('Approve the Playwright connection in Chrome. Canopy will open a new project tab.');
    connecting = (async () => {
      if (!browser) {
        browser = await connectBrowser();
        browser.on('disconnected', () => {
          browser = undefined;
          active = undefined;
          pages.clear();
          tabs();
          status('Chrome disconnected. Reconnect to continue.', true);
        });
      }
      if (closing) return;
      // Never navigate or inject into the personal tab chosen during pairing.
      const page = await browser.contexts()[0].newPage();
      await attach(page);
      await page.goto(pendingUrl, { waitUntil: 'domcontentloaded' });
    })();
    try { await connecting; }
    catch (error) {
      await Promise.allSettled([...ownedPages].map(page => page.close()));
      ownedPages.clear();
      await browser?.close().catch(() => {});
      browser = undefined;
      throw error;
    } finally { connecting = undefined; }
  }

  async function handle(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ack') return gate.ack();
    if (message.type === 'connect') return connect();
    if (message.type === 'visible') {
      visible = !!message.visible;
      gate.reset();
      if (active) await (visible ? startFrames(active) : active.session.send('Page.stopScreencast'));
      return;
    }
    if (message.type === 'resize') {
      size = viewportSize(message.width, message.height);
      if (active) await active.page.setViewportSize(size);
      return;
    }
    if (message.type === 'select') {
      const entry = pages.get(message.id);
      if (entry) await select(entry);
      return;
    }
    if (message.canopy === 'navigate' && message.url) {
      pendingUrl = websiteUrl(message.url);
      if (!active) return;
    }
    if (message.type === 'dialog') {
      const entry = pages.get(message.pageId);
      if (entry?.dialog) {
        const dialog = entry.dialog;
        entry.dialog = undefined;
        await (message.accept ? dialog.accept(String(message.text ?? '')) : dialog.dismiss());
      }
      return;
    }
    if (!active) throw new Error('Connect Chrome before interacting with the page.');
    const { page, session } = active;
    if (message.type === 'mouse') {
      if (!['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(message.event)) return;
      await session.send('Input.dispatchMouseEvent', {
        type: message.event, x: Math.max(0, Math.min(size.width, Number(message.x) || 0)),
        y: Math.max(0, Math.min(size.height, Number(message.y) || 0)),
        button: ['left', 'middle', 'right'].includes(message.button) ? message.button : 'none',
        buttons: Number(message.buttons) & 7, modifiers: Number(message.modifiers) & 15,
        clickCount: Math.min(3, Math.max(0, Number(message.clickCount) || 0)),
        ...(message.event === 'mouseWheel' ? { deltaX: Number(message.deltaX) || 0, deltaY: Number(message.deltaY) || 0 } : {}),
      });
    } else if (message.type === 'text') {
      await session.send('Input.insertText', { text: String(message.text ?? '').slice(0, 100_000) });
    } else if (message.type === 'key') {
      const modifier = Number(message.modifiers) & 15;
      const editingCommand = ({ a: 'selectAll', c: 'copy', x: 'cut', z: modifier & 8 ? 'redo' : 'undo' })[String(message.key).toLowerCase()];
      await session.send('Input.dispatchKeyEvent', {
        type: message.up ? 'keyUp' : 'keyDown', key: String(message.key).slice(0, 40), code: String(message.code).slice(0, 40),
        windowsVirtualKeyCode: Number(message.keyCode) || 0, modifiers: Number(message.modifiers) & 15,
        ...(message.text ? { text: String(message.text).slice(0, 8) } : {}),
        ...(!message.up && (modifier & 6) && editingCommand ? { commands: [editingCommand] } : {}),
      });
    } else if (message.canopy === 'navigate') {
      if (message.url) await page.goto(pendingUrl, { waitUntil: 'domcontentloaded' });
      else if (message.delta < 0) await page.goBack({ waitUntil: 'domcontentloaded' });
      else if (message.delta > 0) await page.goForward({ waitUntil: 'domcontentloaded' });
      else await page.reload({ waitUntil: 'domcontentloaded' });
      send({ canopy: 'nav', url: page.url(), title: await page.title() });
    } else if (message.canopy === 'capture') {
      const image = await page.screenshot({ type: 'png' });
      send({ canopy: 'capture-result', id: message.id, image: image.toString('base64'), width: size.width, height: size.height });
    } else if (['mode', 'sync', 'region', 'agent'].includes(message.canopy)) {
      await page.evaluate(d => {
        if (!window.__canopyBrowser) throw new Error('The page is still loading.');
        window.__canopyBrowser.cmd(d);
      }, message);
    }
  }

  const server = createServer((req, res) => {
    if (req.headers.host !== new URL(origin).host || req.method !== 'GET') { res.writeHead(403).end(); return; }
    const path = new URL(req.url, origin).pathname;
    const body = path === `/${token}/` ? html : path === `/${token}/viewer.js` ? js : null;
    if (body === null) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/html',
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'",
    }).end(body);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256_000 });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.host !== new URL(origin).host || req.headers.origin !== origin || req.url !== `/${token}/socket` || viewer?.readyState === 1) {
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  let idleTimer;
  wss.on('connection', ws => {
    clearTimeout(idleTimer);
    viewer = ws;
    gate.reset();
    let queued = 0;
    let inputQueue = Promise.resolve();
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      // Acks and visibility must not queue behind a navigation or pairing UI.
      if (['ack', 'visible', 'connect'].includes(message.type)) { void handle(message).catch(fail); return; }
      if (queued >= 128) return;
      queued++;
      inputQueue = inputQueue.then(() => handle(message)).catch(error => {
        if (message.canopy === 'agent') send({ canopy: 'agent-result', id: message.id, ok: false, data: String(error.message || error) });
        else if (message.canopy === 'capture') send({ canopy: 'capture-result', id: message.id, error: String(error.message || error) });
        else fail(error);
      }).finally(() => queued--);
    });
    ws.on('close', () => {
      if (viewer !== ws) return;
      visible = false;
      if (active) void active.session.send('Page.stopScreencast').catch(() => {});
      idleTimer = setTimeout(() => void shutdown(), 15_000);
    });
    if (browser && active) {
      tabs();
      status('Connected to Chrome');
      send({ canopy: 'ready', url: active.page.url(), title: '' });
    } else void connect().catch(fail);
  });

  async function shutdown() {
    if (closing) return;
    closing = true;
    // Close only tabs this process created (including their popups), then detach
    // from Chrome. Never close the user's browser context or personal tabs.
    await Promise.race([
      (async () => { await Promise.allSettled([...ownedPages].map(page => page.close())); await browser?.close(); })(),
      new Promise(resolve => setTimeout(resolve, 1500)),
    ]);
    process.exit(0);
  }
  lines.on('close', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  server.listen(0, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`;
    process.stdout.write(`${JSON.stringify({ url: `${origin}/${token}/`, pid: process.pid })}\n`);
    idleTimer = setTimeout(() => void shutdown(), 30_000);
  });
}

// Configuration arrives over stdin, never argv or a persisted credential file.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = createInterface({ input: process.stdin });
  const config = await new Promise(resolve => input.once('line', line => resolve(JSON.parse(line))));
  input.close();
  await startBridge(config);
}
