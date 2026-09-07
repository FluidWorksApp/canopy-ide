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
