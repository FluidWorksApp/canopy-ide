/** Ordered, bounded terminal input for one remote PTY.
 *
 * Keystrokes go over the session's stream socket once the gateway announces
 * {t:'hello',input:1}: no per-keystroke HTTP request, and several batches may
 * be in flight in order. While that socket is missing (older gateway, viewer
 * grant, reconnecting) input falls back to the HTTP input route, one request
 * at a time. A gateway that announced the protocol dedupes batches by
 * (id, seq) on both transports, so batches whose acknowledgement was lost to a
 * reconnect are resent and applied exactly once. */
export const INPUT_QUEUE_CHARS = 32768;
const BATCH_CHARS = 2048;
const MAX_WAITERS = 4096;
export const TERMINAL_INPUT_PROTOCOL = 1;

type Batch = { seq: number; data: string; end: number; binary?: boolean; sentOn?: unknown };
type Waiter = { end: number; resolve: () => void; reject: (error: unknown) => void };
export type InputBody = { data: string; id?: string; seq?: number; encoding?: "latin1" };
export interface InputSocket { readonly readyState: number; send(data: string): void }

export class TerminalInput {
  private id = crypto.randomUUID();
  private seq = 0;
  private pending: {data:string;binary:boolean}[] = [];
  private binarySupported = false;
  private unacked: Batch[] = [];
  private pushed = 0;
  private waiters: Waiter[] = [];
  private socket?: InputSocket;
  private sequenced = false;
  private http = false;
  private scheduled = false;
  private disposed = false;
  private readonly post: (body: InputBody) => Promise<unknown>;
  private readonly limit: number;
  constructor(post: (body: InputBody) => Promise<unknown>, limit = INPUT_QUEUE_CHARS) { this.post = post; this.limit = limit; }

  /** Characters not yet acknowledged; the queue bound applies to these. */
  get queued() { return this.pending.reduce((sum,part)=>sum+part.data.length,0) + this.unacked.reduce((sum, batch) => sum + batch.data.length, 0); }
  get idle() { return !this.queued && !this.http; }
  get transport() { return this.socket ? 'socket' as const : 'http' as const; }

  write(data: string): Promise<void> { return this.enqueue(data,false); }
  writeBinary(data:string):Promise<void>{
    if(!this.binarySupported)return Promise.reject(Error('Binary terminal input requires an updated workspace runtime'));
    if([...data].some(value=>value.charCodeAt(0)>255))return Promise.reject(Error('Invalid binary terminal input'));
    return this.enqueue(data,true);
  }
  private enqueue(data:string,binary:boolean):Promise<void>{
    if (this.disposed) return Promise.reject(Error('Workspace disconnected'));
    if(!data)return Promise.resolve();
    if (this.queued + data.length > this.limit || this.waiters.length >= MAX_WAITERS) return Promise.reject(Error('Remote terminal input queue is full'));
    const last=this.pending.at(-1);
    if(last?.binary===binary)last.data+=data;else if(data)this.pending.push({data,binary});
    this.pushed += data.length;
    const end = this.pushed;
    const done = new Promise<void>((resolve, reject) => this.waiters.push({ end, resolve, reject }));
    // Coalesce one synchronous burst (a paste split by xterm) without a timer.
    if (!this.scheduled) { this.scheduled = true; queueMicrotask(() => { this.scheduled = false; this.pump(); }); }
    return done;
  }

  /** Called for every stream hello. Only input>=1 makes the socket a transport. */
  hello(socket: InputSocket, input: unknown) {
    this.sequenced = true;
    this.binarySupported=input===2;
    if (input === TERMINAL_INPUT_PROTOCOL || input === 2) { this.socket = socket; this.pump(); }
    else if (this.socket === socket) this.socket = undefined;
  }

  /** The socket closed: anything it did not acknowledge is resent elsewhere. */
  closed(socket: InputSocket) {
    if (this.socket !== socket) return;
    this.socket = undefined; this.pump();
  }

  /** Acknowledgement from the socket; stale queue identities are ignored. */
  acknowledge(id: unknown, seq: unknown) { if (id === this.id && typeof seq === 'number') this.ack(seq); }
  rejected(id: unknown, error: unknown) { if (id === this.id) this.fail(Error(typeof error === 'string' ? error : 'Terminal input failed')); }

  private ack(seq: number) {
    let acked = -1;
    while (this.unacked.length && this.unacked[0].seq <= seq) acked = this.unacked.shift()!.end;
    if (acked < 0) return;
    const ready = this.waiters.filter(w => w.end <= acked);
    this.waiters = this.waiters.filter(w => w.end > acked);
    ready.forEach(w => w.resolve());
  }

  /** Input failed for good: reject waiters, drop the queue and start a new
   * input identity so a later write is not refused as out of order. */
  fail(error: unknown) {
    this.pending = []; this.unacked = []; this.id = crypto.randomUUID(); this.seq = 0;
    this.waiters.splice(0).forEach(w => w.reject(error));
  }

  dispose(error: unknown = Error('Workspace disconnected')) { this.disposed = true; this.socket = undefined; this.fail(error); }

  private take(): Batch {
    const part=this.pending[0];
    let size = Math.min(BATCH_CHARS, part.data.length);
    const last = part.data.charCodeAt(size - 1);
    if (!part.binary && size < part.data.length && last >= 0xd800 && last <= 0xdbff) size--;
    const data = part.data.slice(0,size);part.data=part.data.slice(size);
    if(!part.data)this.pending.shift();
    const end = this.pushed - this.pending.reduce((sum,part)=>sum+part.data.length,0);
    const batch:Batch = { seq: ++this.seq, data, end, ...(part.binary?{binary:true}:{}) };
    this.unacked.push(batch); return batch;
  }

  private pump() {
    if (this.disposed) return;
    // An HTTP batch in flight is the ordering barrier for either transport.
    if (this.http) return;
    const socket = this.socket;
    if (socket && socket.readyState === 1) {
      try {
        for (const batch of this.unacked) if (batch.sentOn !== socket) this.send(socket, batch);
        while (this.pending.length) this.send(socket, this.take());
        return;
      } catch { this.socket = undefined; }
    }
    const batch = this.unacked[0] ?? (this.pending.length ? this.take() : undefined);
    if (!batch) return;
    this.http = true; batch.sentOn = 'http';
    const id = this.id;
    const body:InputBody = {data:batch.data,...(batch.binary?{encoding:"latin1" as const}:{}),...(this.sequenced?{id,seq:batch.seq}:{})};
    Promise.resolve().then(() => this.post(body)).then(
      () => { this.http = false; if (id === this.id) this.ack(batch.seq); this.pump(); },
      error => { this.http = false; if (id === this.id) this.fail(error); this.pump(); },
    );
  }

  private send(socket: InputSocket, batch: Batch) {
    socket.send(JSON.stringify({ t: 'input', id: this.id, seq: batch.seq, data: batch.data, ...(batch.binary?{encoding:'latin1'}:{}) }));
    batch.sentOn = socket;
  }
}
