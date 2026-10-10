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

/** One owner serializes all screencast transitions for a CDP page session.
 * A timed-out command has an unknown remote outcome: fence this session rather
 * than starting again while the old request may still complete in Chromium. */
export class ScreencastLifecycle {
  constructor(session, shouldRun, { timeoutMs = 10_000 } = {}) {
    Object.assign(this, { session, shouldRun, timeoutMs });
    this.running = false;
    this.queue = Promise.resolve();
    this.fault = null;
  }
  enqueue(operation) {
    const request = this.queue.then(() => {
      if (this.fault) throw this.fault;
      return operation();
    });
    this.queue = request.catch(() => {});
    return request;
  }
  async command(method, args) {
    if (this.fault) throw this.fault;
    let timer;
    try {
      return await Promise.race([
        this.session.send(method, args),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            this.fault = new Error(`Chrome screencast command timed out (${method}). Reconnect to open a new tab.`);
            reject(this.fault);
          }, this.timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async stopNow() {
    if (!this.running) return;
    await this.command('Page.stopScreencast');
    this.running = false;
  }
  async startNow() {
    if (!this.shouldRun() || this.running) return;
    // Older extension-backed Chrome may refuse these hints. A refusal is
    // harmless, whereas an unresolved command must retain the timeout fence.
    for (const [method, args] of [
      ['Page.setWebLifecycleState', { state: 'active' }],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
    ]) {
      try { await this.command(method, args); }
      catch (error) { if (this.fault) throw error; }
    }
    if (!this.shouldRun()) return;
    await this.command('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 3840, maxHeight: 2400, everyNthFrame: 1 });
    this.running = true;
    if (!this.shouldRun()) await this.stopNow();
  }
  start() { return this.enqueue(() => this.startNow()); }
  stop() { return this.enqueue(() => this.stopNow()); }
  restart() {
    return this.enqueue(async () => {
      if (!this.shouldRun()) return this.stopNow();
      await this.stopNow();
      await this.startNow();
    });
  }
}

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

/** Bounded socket/ticket recovery shared by local and workspace viewers.
 * Only navigation is replayable: stale clicks and keystrokes are never queued. */
export class ViewerConnection {
  constructor({remote=false,url,requestTicket,onReady=()=>{},onMessage=()=>{},onDisconnect=()=>{},onReopen=()=>false,WebSocketImpl=globalThis.WebSocket,setTimer=(fn,delay)=>setTimeout(fn,delay),clearTimer=timer=>clearTimeout(timer),timeoutMs=15_000}={}) {
    Object.assign(this,{remote,url,requestTicket,onReady,onMessage,onDisconnect,onReopen,WebSocketImpl,setTimer,clearTimer,timeoutMs});
    this.visible=true;this.ready=false;this.failures=0;this.phase='idle';this.socket=null;this.disposed=false;this.ticketSequence=0;
  }
  clearTimers(){this.clearTimer(this.retryTimer);this.clearTimer(this.timeoutTimer);this.retryTimer=this.timeoutTimer=undefined;}
  setVisible(visible){
    this.visible=visible;
    if(!visible){this.clearTimer(this.retryTimer);this.retryTimer=undefined;}
    this.send({type:'visible',visible});
    if(visible&&!this.ready)this.connect();
  }
  connect(){
    if(this.disposed||!this.visible||this.phase!=='idle')return;
    this.clearTimer(this.retryTimer);this.retryTimer=undefined;
    if(this.remote){
      this.phase='ticket';this.pendingTicket=++this.ticketSequence;
      this.timeoutTimer=this.setTimer(()=>this.fail('Workspace stream ticket timed out'),this.timeoutMs);
      if(this.requestTicket?.(this.pendingTicket)===false){this.clearTimers();this.phase='idle';}
    }else this.open(this.url);
  }
  ticket(url,requestId=this.pendingTicket){
    if(this.phase!=='ticket'||this.disposed||requestId!==this.pendingTicket)return;
    try{const target=new URL(url);if(!['ws:','wss:'].includes(target.protocol)||target.username||target.password)throw Error();this.open(target.href);}
    catch{this.fail('Workspace stream connection is unavailable');}
  }
  ticketFailed(requestId=this.pendingTicket){if(this.phase==='ticket'&&requestId===this.pendingTicket)this.fail('Workspace stream ticket is unavailable');}
  open(url){
    this.clearTimers();this.phase='socket';this.ready=false;
    const socket=this.socket=new this.WebSocketImpl(url);
    this.timeoutTimer=this.setTimer(()=>this.fail('Preview connection timed out'),this.timeoutMs);
    const initialize=()=>{
      if(this.socket!==socket||this.ready||this.disposed)return;
      this.clearTimer(this.timeoutTimer);this.timeoutTimer=undefined;
      this.ready=true;this.failures=0;this.phase='ready';
      this.onReady();
      if(this.pendingNavigation){const message=this.pendingNavigation;this.pendingNavigation=undefined;this.send(message);}
    };
    socket.onopen=()=>{if(!this.remote)initialize();};
    socket.onmessage=event=>{
      if(this.socket!==socket||this.disposed)return;
      let message;try{message=JSON.parse(event.data);}catch{return;}
      if(this.remote)initialize();
      Promise.resolve(this.onMessage(message,socket)).catch(()=>{if(this.socket===socket)this.fail('Preview stream interrupted');});
    };
    socket.onerror=()=>{if(this.socket===socket)this.fail('Preview connection interrupted');};
    socket.onclose=()=>{if(this.socket===socket)this.fail('Preview disconnected; reconnecting…');};
  }
  fail(reason){
    if(this.disposed)return;
    this.clearTimers();const socket=this.socket;this.socket=null;this.ready=false;this.phase='idle';socket?.close();
    this.onDisconnect(reason);this.failures++;
    if(!this.visible)return;
    if(this.failures>=3&&this.onReopen()!==false){this.phase='reopening';return;}
    this.retryTimer=this.setTimer(()=>{this.retryTimer=undefined;this.connect();},Math.min(500*2**Math.min(this.failures-1,5),10_000));
  }
  reconnect(){
    if(this.disposed)return;
    this.clearTimers();const socket=this.socket;this.socket=null;this.ready=false;this.phase='idle';this.failures=0;socket?.close();this.connect();
  }
  reopen(){if(this.onReopen()!==false){this.clearTimers();const socket=this.socket;this.socket=null;socket?.close();this.phase='reopening';this.ready=false;}else this.reconnect();}
  send(message){
    if(this.ready&&this.socket?.readyState===1){this.socket.send(JSON.stringify(message));return true;}
    if(message.canopy==='navigate'){this.pendingNavigation=message;this.connect();}
    return false;
  }
  dispose(){this.disposed=true;this.clearTimers();const socket=this.socket;this.socket=null;this.ready=false;socket?.close();}
}

/** Match physical display pixels without unbounded retina allocations. */
export function streamPixelRatio(width,height,ratio=1){
 const size=viewportSize(width,height),requested=Number(ratio);
 return Math.max(1,Math.min(Number.isFinite(requested)?requested:1,2,3840/size.width,2400/size.height));
}
