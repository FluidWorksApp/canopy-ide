// Ported from T3 Code (MIT) apps/server/src/preview/ServerBrowserStream.ts
// (pingdotgg/t3code d5290e9): one viewer of the agent browser over a
// WebSocket. Binary messages are JPEG frames; text messages are JSON
// `{type, ...data}`; the viewer answers each frame with `{type:"ack"}`.
//
// Differences forced by Canopy's surroundings, behaviour unchanged:
// - Served by runner.mjs at /browser/stream behind the gateway's one-use
//   ticket (policy.mjs browserStream) instead of T3's /api/preview-stream/ws
//   with its own auth. There is no threadId/tabId: one page per workspace.
// - canOperate: T3 requires its operate scope. Canopy's gateway has view and
//   drive scopes, but the browser stream, like the desktop stream, needs
//   drive, so every viewer that reaches the runner may operate. A passive
//   viewer still opts out with interactive=false.
// - A browser that cannot start answers 503 before the upgrade, like T3's
//   ServerBrowserLaunchError; T3's host-setup close code has no Canopy
//   equivalent (the image ships Chromium), so it is not sent.
// - Download and upload routes are not ported.
import { WebSocketServer } from 'ws';

export const TAB_GONE_CODE = 4404;
export const DEFAULT_QUALITY = 70;
export const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;

const intParam = (params, name, fallback, max) => {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), max) : fallback;
};

const isAck = message =>
  typeof message === 'object' && message !== null && 'type' in message && message.type === 'ack';

const parseMessage = chunk => {
  try {
    return JSON.parse(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  } catch {
    return null;
  }
};

// JPEGs are already compressed. Disabling deflate also keeps all pending
// writes in the socket buffer bounded below, not a zlib queue.
// 1 MiB of input matches the gateway's client limit.
export const browserStreamServer = () =>
  new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });

/**
 * Upgrades one viewer of `browser` (an AgentBrowser).
 * @param {import('./agent-browser.mjs').AgentBrowser} browser
 */
export async function handleBrowserStream(browser, wss, request, socket, head) {
  const params = new URL(request.url, 'http://runner').searchParams;
  const canOperate = params.get('interactive') !== 'false';
  let viewer;
  try {
    viewer = await browser.attachViewer({
      canOperate,
      maxWidth: intParam(params, 'maxWidth', 1280, 7680),
      maxHeight: intParam(params, 'maxHeight', 800, 4320),
      quality: intParam(params, 'quality', DEFAULT_QUALITY, 100),
    });
  } catch (error) {
    // The tab closed while it attached: T3's ServerBrowserTabNotFoundError.
    if (error?.reason === 'closed' || /tab closed/i.test(String(error?.message))) viewer = null;
    else {
      console.warn(`Agent browser failed to start: ${String(error?.message ?? error).slice(0, 200)}`);
      if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
  }
  if (socket.destroyed) { await viewer?.close(); return; }
  wss.handleUpgrade(request, socket, head, ws => {
    // A refused upgrade reads as an auth failure to ticket clients, so a
    // missing tab is a close code they stop on.
    const gone = () => ws.close(TAB_GONE_CODE, 'tab closed');
    if (!viewer) { gone(); return; }
    // `send` returns once the frame is queued, so Chromium's ack for each
    // frame waits for the viewer's `ack` message instead. Only one frame is on
    // the wire and only the newest waits behind it, so replies never queue
    // behind stale images on a slow link.
    let inFlight = null;
    let pending = null;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      void viewer.close();
    };
    const write = data => {
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      if (socket.writableLength + bytes + 14 > MAX_SOCKET_BUFFER_BYTES) {
        // A slow viewer is disconnected, never buffered without bound.
        socket.destroy();
        end();
        return;
      }
      if (ws.readyState === 1) ws.send(data, { binary: typeof data !== 'string' });
    };
    const sendFrame = frame => {
      inFlight = frame.ack;
      write(frame.data);
    };
    const sendOutput = async () => {
      while (!ended) {
        const output = await viewer.output.take();
        if (output === null || ended) return;
        switch (output._tag) {
          case 'frame': {
            if (inFlight === null) { sendFrame(output); break; }
            const superseded = pending;
            pending = output;
            // Never sent, but Chromium still waits for its ack.
            if (superseded) void superseded.ack();
            break;
          }
          case 'viewport':
          case 'control':
          case 'clipboard':
          case 'download':
          case 'fileChooser':
          case 'fileChooserClosed':
          case 'popup':
          case 'pointer':
          case 'probe': {
            const { _tag: type, ...data } = output;
            write(JSON.stringify({ type, ...data }));
            break;
          }
          case 'gone':
            gone();
            end();
            return;
          case 'reconnect':
            ws.close(1012, 'reconnect');
            end();
            return;
        }
      }
    };
    ws.on('message', chunk => {
      const message = parseMessage(chunk);
      // Ownership serializes actions in the browser. Keep reading so dialog
      // replies and takeover can unblock an action already waiting on the page.
      if (!isAck(message)) {
        if (canOperate) void viewer.input(message);
        return;
      }
      const ack = inFlight;
      const next = pending;
      inFlight = null;
      pending = null;
      // Not awaited: Chromium acks are paced and must not hold up input.
      if (ack) void ack();
      if (next) sendFrame(next);
    });
    ws.on('close', end);
    ws.on('error', end);
    void sendOutput().catch(() => { ws.terminate(); end(); });
  });
}
