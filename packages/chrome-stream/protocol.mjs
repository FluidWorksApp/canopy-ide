export function websiteUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enter an HTTP or HTTPS website URL.');
  return url.href;
}

export function viewportSize(width, height) {
  return {
    width: Math.max(240, Math.min(2560, Math.round(Number(width) || 1280))),
    height: Math.max(160, Math.min(1600, Math.round(Number(height) || 720))),
  };
}

/** How long the viewer may show a still frame before the bridge asks Chrome
 *  for a new one. Chrome stops delivering screencast frames while its window
 *  is behind the IDE, so without this the preview freezes until the user
 *  clicks into Chrome itself. */
export const FRAME_QUIET_MS = 400;

/** How often the bridge checks whether the stream has gone quiet. */
export const FRAME_POLL_MS = 200;

/** A page nobody is touching paints nothing, so a refresh that returns the
 *  same picture means there was nothing to send. Backing off from the first
 *  repeat to this ceiling keeps an idle preview close to free, while any real
 *  change drops straight back to the fast path. */
export const REFRESH_BACKOFF_MAX_MS = 2_000;

export function refreshBackoff(previous) {
  return Math.min(REFRESH_BACKOFF_MAX_MS, Math.max(FRAME_POLL_MS, (Number(previous) || 0) * 2));
}

/** Should the bridge restart Chrome's screencast right now? Only when the
 *  viewer wants pixels, a page is attached, no restart is already running, the
 *  backoff has elapsed, and Chrome itself has been silent. A composing tab
 *  keeps this false, so the restart is the exception rather than the clock. */
export function shouldRefreshStream({ visible, attached, refreshing, lastFrameAt, nextRefreshAt = 0 }, now) {
  if (!visible || !attached || refreshing || now < nextRefreshAt) return false;
  return now - lastFrameAt >= FRAME_QUIET_MS;
}

/** The size a frame is drawn at inside the pane: scaled to fit either way, so
 *  a frame smaller than the pane fills it instead of sitting in a corner.
 *  Aspect is preserved; a frame shaped unlike the pane is centred, which is
 *  honest about Chrome's real viewport rather than stretching the page. */
export function fitContain(frame, box) {
  const width = Number(frame.width) || 0;
  const height = Number(frame.height) || 0;
  if (width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(box.width / width, box.height / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// At most one frame is being decoded by the viewer; intermediate frames are
// replaced with the latest pending frame. Chrome is acknowledged independently, including while
// the iframe is hidden. There is no unbounded image queue on either side.
export class FrameGate {
  busy = false;
  pending;
  offer(send, frame) {
    if (this.busy) { this.pending = { send, frame }; return false; }
    this.busy = true;
    send(frame);
    return true;
  }
  ack() {
    this.busy = false;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) this.offer(pending.send, pending.frame);
  }
  reset() { this.busy = false; this.pending = undefined; }
}
