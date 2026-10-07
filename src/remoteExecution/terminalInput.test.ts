import { describe, expect, it } from 'vitest';
import { TerminalInput, type InputBody } from './terminalInput';
// @ts-expect-error untyped host runtime module: the gateway's real dedupe ledger.
import { InputLedger } from '../../packages/remote-host/terminal-input.mjs';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
type Frame = { t: string; id: string; seq: number; data: string };

/** A gateway model: socket and HTTP batches go through the real ledger, and
 * `applied` is exactly what reached the PTY. */
function gateway() {
  const ledger = new InputLedger();
  const applied: string[] = [];
  const apply = (frame: { id: string; seq: number; data: string }) => ledger.apply(frame.id, frame.seq, async () => { applied.push(frame.data); });
  const http: Array<{ body: InputBody; resolve: () => void; reject: (error: unknown) => void }> = [];
  const post = (body: InputBody) => new Promise<void>((resolve, reject) => {
    http.push({ body, resolve: () => { void (body.id ? apply(body as Frame) : Promise.resolve(applied.push(body.data))).then(() => resolve(), reject); }, reject });
  });
  class Socket {
    readyState = 1; frames: Frame[] = [];
    send(text: string) { if (this.readyState !== 1) throw Error('closed'); this.frames.push(JSON.parse(text)); }
    /** Gateway receives every frame sent so far, in order; returns their acks. */
    async deliver() { const acks: number[] = []; for (const frame of this.frames.splice(0)) { await apply(frame); acks.push(frame.seq); } return acks; }
  }
  return { applied, http, post, Socket };
}

describe('TerminalInput', () => {
  it('uses one HTTP request at a time with the legacy body when the gateway never offered socket input', async () => {
    const g = gateway(); const input = new TerminalInput(g.post);
    const done = Promise.all(['p', 'w', 'd', '\r'].map(key => input.write(key)));
    await flush();
    expect(g.http.map(r => r.body)).toEqual([{ data: 'pwd\r' }]);
    input.write('ls'); await flush(); expect(g.http).toHaveLength(1); // ordered: waits for the first
    g.http[0].resolve(); await done; await flush();
    expect(g.http[1].body).toEqual({ data: 'ls' });
    g.http[1].resolve(); await flush();
    expect(g.applied.join('')).toBe('pwd\rls');
  });

  it('enforces the 32 KB queue bound across queued and unacknowledged input', async () => {
    const g = gateway(); const input = new TerminalInput(g.post);
    const first = input.write('x'.repeat(32768));
    await expect(input.write('y')).rejects.toThrow('queue is full');
    let settled = false; void first.then(() => { settled = true; });
    for (let i = 0; !settled; i++) { await flush(); g.http[i]?.resolve(); await flush(); }
    expect(g.http).toHaveLength(16); // 2 KB batches, strictly one after another
    const after = input.write('y'); await flush(); g.http[16].resolve(); await expect(after).resolves.toBeUndefined();
  });

  it('streams keystrokes over the socket without waiting for acknowledgements, in order', async () => {
    const g = gateway(); const input = new TerminalInput(g.post); const socket = new g.Socket();
    input.hello(socket, 1);
    const typed = 'echo hi\r'.split('');
    const writes = [];
    for (const key of typed) { writes.push(input.write(key)); await flush(); }
    expect(socket.frames.map(f => f.data)).toEqual(typed); // one frame per keystroke, none waited for acks
    expect(socket.frames.map(f => f.seq)).toEqual(typed.map((_, i) => i + 1));
    expect(g.http).toHaveLength(0);
    const id = socket.frames[0].id;
    for (const seq of await socket.deliver()) input.acknowledge(id, seq);
    await Promise.all(writes);
    expect(g.applied.join('')).toBe('echo hi\r');
  });

  it('falls back to HTTP while reconnecting and resends unacknowledged input exactly once', async () => {
    const g = gateway(); const input = new TerminalInput(g.post); const first = new g.Socket();
    input.hello(first, 1);
    input.write('ab'); await flush(); input.write('cd'); await flush();
    const id = first.frames[0].id;
    // The gateway applied 'ab' and 'cd' but both acks were lost with the socket.
    await first.deliver(); first.readyState = 3; input.closed(first);
    await flush();
    expect(g.http.map(r => r.body)).toEqual([{ data: 'ab', id, seq: 1 }]);
    input.write('ef');
    const second = new g.Socket(); input.hello(second, 1); await flush();
    expect(second.frames).toEqual([]); // an HTTP batch in flight is an ordering barrier
    g.http[0].resolve(); await flush(); await flush();
    expect(second.frames.map(f => [f.seq, f.data])).toEqual([[2, 'cd'], [3, 'ef']]);
    for (const seq of await second.deliver()) input.acknowledge(id, seq);
    expect(g.applied.join('')).toBe('abcdef');
    expect(input.idle).toBe(true);
  });

  it('keeps sending new input over HTTP with sequence numbers while no socket is available', async () => {
    const g = gateway(); const input = new TerminalInput(g.post); const socket = new g.Socket();
    input.hello(socket, 1); socket.readyState = 3; input.closed(socket);
    const done = input.write('x'); await flush();
    expect(g.http[0].body).toMatchObject({ data: 'x', seq: 1 });
    g.http[0].resolve(); await done; expect(g.applied).toEqual(['x']);
  });

  it('treats input:0 as HTTP-only (viewer) and ignores stale acknowledgements', async () => {
    const g = gateway(); const input = new TerminalInput(g.post); const socket = new g.Socket();
    input.hello(socket, 0); input.write('q'); await flush();
    expect(socket.frames).toEqual([]); expect(g.http[0].body).toMatchObject({ data: 'q', seq: 1 });
    input.acknowledge('another-queue', 1); expect(input.idle).toBe(false);
  });

  it('rejects queued input after a gateway error and continues on a fresh queue identity', async () => {
    const g = gateway(); const input = new TerminalInput(g.post); const socket = new g.Socket();
    input.hello(socket, 1);
    const failed = input.write('a'); await flush(); const oldId = socket.frames[0].id;
    input.rejected(oldId, 'Forbidden');
    await expect(failed).rejects.toThrow('Forbidden');
    const next = input.write('b'); await flush();
    expect(socket.frames[1].seq).toBe(1); expect(socket.frames[1].id).not.toBe(oldId);
    input.dispose(); await expect(next).rejects.toThrow('disconnected'); await expect(input.write('c')).rejects.toThrow('disconnected');
  });

  it('never splits a surrogate pair across batches', async () => {
    const g = gateway(); const input = new TerminalInput(g.post); const socket = new g.Socket();
    input.hello(socket, 1);
    input.write('a'.repeat(2047) + '😀' + 'b'); await flush();
    expect(socket.frames.map(f => f.data.length)).toEqual([2047, 3]);
    expect(socket.frames.map(f => f.data).join('')).toBe('a'.repeat(2047) + '😀' + 'b');
  });
});
