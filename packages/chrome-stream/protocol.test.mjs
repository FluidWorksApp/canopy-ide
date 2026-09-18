import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_QUIET_MS, FrameGate, REFRESH_BACKOFF_MAX_MS, fitContain, refreshBackoff, shouldRefreshStream, viewportSize, websiteUrl } from './protocol.mjs';

test('website navigation cannot open local files or execute a URL script', () => {
  assert.equal(websiteUrl('https://example.com'), 'https://example.com/');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,x']) assert.throws(() => websiteUrl(url));
});
test('slow consumers never accumulate decoded frames', () => {
  const gate = new FrameGate();
  const delivered = [];
  for (let i = 0; i < 10000; i++) gate.offer(frame => delivered.push(frame), i);
  assert.deepEqual(delivered, [0]);
  gate.ack();
  assert.deepEqual(delivered, [0, 9999]);
  gate.reset();
  gate.offer(frame => delivered.push(frame), 10000);
  assert.deepEqual(delivered, [0, 9999, 10000]);
});
test('untrusted iframe sizes cannot allocate enormous Chrome viewports', () => {
  assert.deepEqual(viewportSize(Infinity, -100), { width: 2560, height: 160 });
  assert.deepEqual(viewportSize(900.3, 650.9), { width: 900, height: 651 });
  assert.deepEqual(viewportSize('invalid', null), { width: 1280, height: 720 });
});
test('the bridge nudges Chrome only once the stream has gone quiet', () => {
  const now = 10_000;
  const live = { visible: true, attached: true, refreshing: false, lastFrameAt: now - FRAME_QUIET_MS };
  assert.equal(shouldRefreshStream(live, now), true);
  // A tab that is still composing needs no help, and a hidden pane, a detached
  // browser or a capture already in flight must never start another.
  assert.equal(shouldRefreshStream({ ...live, lastFrameAt: now - 1 }, now), false);
  assert.equal(shouldRefreshStream({ ...live, visible: false }, now), false);
  assert.equal(shouldRefreshStream({ ...live, attached: false }, now), false);
  assert.equal(shouldRefreshStream({ ...live, refreshing: true }, now), false);
  assert.equal(shouldRefreshStream({ ...live, nextRefreshAt: now + 1 }, now), false);
});
test('an unchanging page backs off instead of nudging forever', () => {
  let delay = 0;
  const seen = [];
  for (let i = 0; i < 6; i++) { delay = refreshBackoff(delay); seen.push(delay); }
  assert.deepEqual(seen, [200, 400, 800, 1600, REFRESH_BACKOFF_MAX_MS, REFRESH_BACKOFF_MAX_MS]);
});
test('a frame is scaled to fill the pane in either direction', () => {
  // Smaller than the pane: it grows rather than sitting in the middle.
  assert.deepEqual(fitContain({ width: 640, height: 360 }, { width: 1280, height: 720 }), { width: 1280, height: 720 });
  // Larger: it shrinks to fit.
  assert.deepEqual(fitContain({ width: 2560, height: 1440 }, { width: 1280, height: 720 }), { width: 1280, height: 720 });
  // A different shape keeps its aspect, limited by the tighter axis.
  assert.deepEqual(fitContain({ width: 1000, height: 1000 }, { width: 1280, height: 720 }), { width: 720, height: 720 });
  for (const bad of [{ width: 0, height: 10 }, { width: NaN, height: 10 }]) {
    assert.deepEqual(fitContain(bad, { width: 100, height: 100 }), { width: 0, height: 0 });
  }
});
