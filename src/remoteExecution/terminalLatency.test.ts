import { afterEach, expect, it } from 'vitest';
import { breakdown, startHarness } from './terminalLatency.harness';

const RTT = 55;
let harness: Awaited<ReturnType<typeof startHarness>> | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });
const keys = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(0x41 + (i % 26)) + String.fromCharCode(0x61 + Math.floor(i / 26)));

it('echoes each interactive keystroke in about one network round trip', async () => {
  harness = await startHarness({ rttMs: RTT });
  await harness.keystroke('warm');
  const samples = [];
  for (const key of keys(20)) { samples.push(await harness.keystroke(key)); await new Promise(r => setTimeout(r, 40)); }
  const result = breakdown(samples, RTT);
  console.info('[latency] isolated keystrokes', JSON.stringify(result));
  expect(result.transport).toBe('socket');
  expect(result.median.clientQueue).toBeLessThan(5);
  expect(result.median.total).toBeLessThan(RTT * 1.5);
}, 30_000);

it('keeps fast typing at about one round trip per key instead of queueing behind HTTP', async () => {
  harness = await startHarness({ rttMs: RTT });
  await harness.keystroke('warm');
  const latencies = await harness.burst(keys(30), 25);
  const sorted = [...latencies].sort((a, b) => a - b);
  console.info('[latency] 40 keys/s burst', JSON.stringify({ median: +sorted[15].toFixed(1), p95: +sorted[28].toFixed(1), max: +sorted[29].toFixed(1) }));
  expect(sorted[15]).toBeLessThan(RTT * 1.5);
  expect(sorted[28]).toBeLessThan(RTT * 2);
}, 30_000);

it('does not pay the gateway runtime-admission refresh on keystrokes', async () => {
  // Production DockerWorkspaces.open re-checks admission (control-plane HTTPS
  // + docker inspect under the resource lock) when its 2 s cache expires.
  harness = await startHarness({ rttMs: RTT, openCostMs: 120, openCacheMs: 2000 });
  await harness.keystroke('warm');
  await new Promise(r => setTimeout(r, 2100));
  const marks = await harness.keystroke('Zz');
  console.info('[latency] after admission cache expiry', JSON.stringify(breakdown([marks], RTT)));
  expect(marks.delivered! - marks.written!).toBeLessThan(RTT * 2);
}, 30_000);
