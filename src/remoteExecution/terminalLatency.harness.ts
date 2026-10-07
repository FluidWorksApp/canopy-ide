/* Drives the shipping NativeWorkspaceHost against the real gateway/runner in
 * packages/remote-host/test-support/latency-fixture.mjs (a separate Node process, behind a
 * proxy with a fixed RTT) and breaks each keystroke's echo latency down. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error ws ships no types; Node's ws stands in for the browser WebSocket.
import { WebSocket as UntypedWebSocket } from 'ws';
const NodeWebSocket = UntypedWebSocket as typeof WebSocket;
import { NativeWorkspaceHost } from './NativeWorkspaceHost';
import type { Host } from '../host/contract';

const clock = () => performance.timeOrigin + performance.now();
type Event = { stage: string; at: number; detail?: string };
export type Marks = { written: number; sent?: number; transport?: 'socket' | 'http'; delivered?: number; clientMessage?: number; events: Event[] };

export async function startHarness(options: { rttMs?: number; openCostMs?: number; openCacheMs?: number } = {}) {
  // CANOPY_LATENCY_FIXTURE runs this client against another runtime checkout
  // (e.g. the production gateway) to verify compatibility and compare.
  const fixturePath = process.env.CANOPY_LATENCY_FIXTURE ?? join(dirname(fileURLToPath(import.meta.url)), '../../packages/remote-host/test-support/latency-fixture.mjs');
  const child = spawn(process.execPath, [fixturePath, JSON.stringify(options)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const [line] = await once(createInterface({ input: child.stdout! }), 'line') as [string];
  const fixture = JSON.parse(line) as { endpoint: string; token: string; workspaceId: string; control: string };
  let current: Marks | undefined;
  class TimedWebSocket extends NodeWebSocket {
    constructor(url: string) {
      super(url);
      this.addEventListener('message', () => { if (current && current.sent != null && current.clientMessage == null) current.clientMessage = clock(); });
    }
    send(data: Parameters<WebSocket["send"]>[0]) { if (current && current.sent == null && String(data).includes('"input"')) { current.sent = clock(); current.transport = 'socket'; } super.send(data); }
  }
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = TimedWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = ((url: string, init?: RequestInit) => { if (current && current.sent == null && String(url).endsWith('/input')) { current.sent = clock(); current.transport = 'http'; } return originalFetch(url, init); }) as typeof fetch;
  const desktop = { kind: 'native', invoke: async () => ({ generation: 1 }), listen: async () => () => {}, channel: () => ({ onmessage() {} }) } as unknown as Host;
  const host = new NativeWorkspaceHost({ endpoint: fixture.endpoint, token: fixture.token, workspaceId: fixture.workspaceId, workspaceName: 'Latency' }, desktop);
  let received = '';
  let onReceive: (() => void) | undefined;
  let session: { id: number; generation: number } | undefined;
  let snapshot!: () => void;
  const snapshotSeen = new Promise<void>(resolve => { snapshot = resolve; });
  const channel = { onmessage: (buffer: ArrayBuffer) => {
    const flags = new Uint8Array(buffer)[4];
    if (flags & 2) snapshot(); else received += new TextDecoder().decode(new Uint8Array(buffer, 32));
    if (session) void host.invoke('pty_ack', { id: session.id, generation: session.generation, bytes: buffer.byteLength - 32 });
    onReceive?.();
  } };
  const spawned = await host.invoke<{ id: number; generation: number }>('pty_spawn', { cwd: '/workspace', command: '/bin/bash', onData: channel });
  session = { id: spawned.id, generation: spawned.generation };
  await snapshotSeen;
  await host.invoke('pty_ack', { id: session.id, generation: session.generation, bytes: 0 });
  const events = async () => (await originalFetch(fixture.control + '/events')).json() as Promise<Event[]>;
  const until = (predicate: () => boolean) => new Promise<void>(resolve => { if (predicate()) return resolve(); onReceive = () => { if (predicate()) { onReceive = undefined; resolve(); } }; });
  /** Type one key; resolve once its echo reached the terminal channel. */
  const keystroke = async (key: string) => {
    await events();
    received = ''; const marks: Marks = { written: clock(), events: [] }; current = marks;
    const echoed = until(() => received.includes(key));
    void host.invoke('pty_write', { id: session!.id, data: key });
    await echoed; marks.delivered = clock(); current = undefined;
    marks.events = await events(); return marks;
  };
  /** Type keys `gapMs` apart; per-key latency from press to its echo. */
  const burst = async (keys: string[], gapMs: number) => {
    received = ''; const started: number[] = []; const done: number[] = []; let next = 0;
    const all = until(() => { while (next < started.length && received.includes(keys.slice(0, next + 1).join(''))) done[next++] = clock(); return next === keys.length; });
    for (const key of keys) { started.push(clock()); void host.invoke('pty_write', { id: session!.id, data: key }); onReceive?.(); await new Promise(r => setTimeout(r, gapMs)); }
    await all; return started.map((t, i) => done[i] - t);
  };
  const writes = async () => ((await (await originalFetch(fixture.control + '/writes')).json()) as { writes: string[] }).writes;
  return {
    host, keystroke, burst, writes, fixture, session,
    async close() { host.dispose(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalWebSocket; child.stdin!.end(); await once(child, 'exit'); },
  };
}

export function breakdown(samples: Marks[], rttMs: number) {
  const first = (m: Marks, stage: string, after = m.sent ?? m.written) => m.events.find(e => e.stage === stage && e.at >= after)?.at ?? NaN;
  const rows = samples.map(m => {
    const gatewayReceived = first(m, 'gatewayReceived'), ptyWrite = first(m, 'ptyWrite'), ptyEcho = first(m, 'ptyEcho'), parsed = first(m, 'screenParsed', ptyEcho), gatewaySent = first(m, 'gatewaySent', parsed);
    return {
      clientQueue: m.sent! - m.written,
      uplink: gatewayReceived - m.sent!,
      gatewayToPty: ptyWrite - gatewayReceived,
      ptyEcho: ptyEcho - ptyWrite,
      screenParse: parsed - ptyEcho,
      gatewayRelay: gatewaySent - parsed,
      downlink: m.clientMessage! - gatewaySent,
      clientDeliver: m.delivered! - m.clientMessage!,
      total: m.delivered! - m.written,
    };
  });
  const pick = (values: number[], q: number) => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? +v[Math.min(v.length - 1, Math.floor(v.length * q))].toFixed(1) : NaN; };
  const keys = Object.keys(rows[0] ?? {}) as Array<keyof (typeof rows)[number]>;
  return { rttMs, transport: samples[0]?.transport, median: Object.fromEntries(keys.map(k => [k, pick(rows.map(r => r[k]), 0.5)])), p95: Object.fromEntries(keys.map(k => [k, pick(rows.map(r => r[k]), 0.95)])) };
}
