// Stream multiplexing over one tunnel WebSocket. Binary frames:
//   [type:u8][stream:u32 BE][payload...]
// OPEN 0x01 (edge -> desktop, UTF-8 JSON {"auth":"owner"|"none","ip":"<client ip>"})
// DATA 0x02 (both ways, raw bytes)
// END  0x03 (sender finished writing; half-close)
// RESET 0x04 (abort both directions)
// Stream ids are chosen by the edge: odd, increasing. Each stream carries one raw
// HTTP/1.1 connection. There is no per-stream flow control in v1: a slow stream
// can stall the others through WebSocket backpressure.
import { Duplex } from 'node:stream';

export const OPEN = 0x01, DATA = 0x02, END = 0x03, RESET = 0x04;
export const MAX_FRAME = 16 * 1024 * 1024;

export function encodeFrame(type, stream, payload) {
  const body = payload == null ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(stream, 1);
  return Buffer.concat([head, body]);
}

export function decodeFrame(data) {
  const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (buffer.length < 5) return null;
  return { type: buffer.readUInt8(0), stream: buffer.readUInt32BE(1), payload: buffer.subarray(5) };
}

// One tunnel stream as a net.Socket-shaped Duplex, usable as an http.request
// createConnection result or as a connection handed to an http.Server.
export class TunnelStream extends Duplex {
  constructor(mux, id, meta = {}) {
    super({ allowHalfOpen: true });
    this.mux = mux;
    this.id = id;
    this.meta = meta;
    this.remoteAddress = meta.ip || '127.0.0.1';
    this.remotePort = 0;
    this.remoteFamily = this.remoteAddress.includes(':') ? 'IPv6' : 'IPv4';
    this.localEnded = false;
    this.remoteEnded = false;
    this.reset = false;
  }
  _read() {}
  _write(chunk, _encoding, callback) {
    if (this.reset) return callback(new Error('Tunnel stream reset'));
    this.mux.send(DATA, this.id, chunk, callback);
  }
  _final(callback) {
    this.localEnded = true;
    if (this.reset) return callback();
    this.mux.send(END, this.id, null, callback);
  }
  _destroy(error, callback) {
    // Both sides finished cleanly: nothing to abort.
    if (!this.reset && !(this.localEnded && this.remoteEnded)) {
      this.reset = true;
      this.mux.send(RESET, this.id, null);
    }
    this.mux.streams.delete(this.id);
    callback(error);
  }
  remoteData(payload) { if (!this.reset && !this.remoteEnded) this.push(Buffer.from(payload)); }
  remoteEnd() {
    if (this.remoteEnded) return;
    this.remoteEnded = true;
    this.push(null);
  }
  remoteReset() {
    this.reset = true;
    this.destroy(Object.assign(new Error('Tunnel stream reset by peer'), { code: 'ECONNRESET' }));
  }
  setTimeout(ms, callback) { if (callback) this.once('timeout', callback); return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
}

// role "edge" opens streams; role "desktop" accepts them through onOpen(stream, meta).
export class TunnelMux {
  constructor(ws, { role, onOpen } = {}) {
    if (role !== 'edge' && role !== 'desktop') throw new Error('TunnelMux role must be edge or desktop');
    this.ws = ws;
    this.role = role;
    this.onOpen = onOpen;
    this.streams = new Map();
    this.nextId = 1;
    this.closed = false;
    ws.on('message', (data, isBinary) => { if (isBinary) this.receive(data); });
    ws.on('close', () => this.shutdown());
    ws.on('error', () => this.shutdown());
  }
  send(type, stream, payload, callback) {
    if (this.closed || this.ws.readyState !== 1) {
      if (callback) queueMicrotask(() => callback(new Error('Tunnel closed')));
      return;
    }
    this.ws.send(encodeFrame(type, stream, payload), { binary: true }, callback);
  }
  open(meta) {
    if (this.role !== 'edge') throw new Error('Only the edge opens streams');
    if (this.closed) throw new Error('Tunnel closed');
    const id = this.nextId;
    this.nextId += 2;
    if (this.nextId > 0xffffffff) this.ws.close(1011, 'stream ids exhausted');
    const stream = new TunnelStream(this, id, meta);
    this.streams.set(id, stream);
    this.send(OPEN, id, JSON.stringify(meta));
    return stream;
  }
  receive(data) {
    const frame = decodeFrame(data);
    if (!frame) return;
    const stream = this.streams.get(frame.stream);
    switch (frame.type) {
      case OPEN: {
        if (this.role !== 'desktop' || stream || frame.stream % 2 !== 1) return;
        let meta;
        try { meta = JSON.parse(frame.payload.toString('utf8')); } catch { meta = null; }
        if (!meta || typeof meta !== 'object') { this.send(RESET, frame.stream, null); return; }
        const opened = new TunnelStream(this, frame.stream, meta);
        this.streams.set(frame.stream, opened);
        if (this.onOpen) this.onOpen(opened, meta); else opened.destroy();
        return;
      }
      case DATA: if (stream) stream.remoteData(frame.payload); return;
      case END: if (stream) stream.remoteEnd(); return;
      case RESET: if (stream) stream.remoteReset(); return;
      default: return;
    }
  }
  shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams.values()) {
      stream.reset = true;
      stream.destroy(Object.assign(new Error('Tunnel closed'), { code: 'ECONNRESET' }));
    }
    this.streams.clear();
  }
}
