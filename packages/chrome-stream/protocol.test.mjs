import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameGate, viewportSize, websiteUrl } from './protocol.mjs';

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
