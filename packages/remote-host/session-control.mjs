// Ported from T3 Code (MIT) apps/server/src/preview/SessionControl.ts
// (pingdotgg/t3code d5290e9). The browser "lock" between the agent and the
// humans watching a streamed tab: who may act, in what order, and how a
// handoff drains running work before the new owner acts.
//
// Differences forced by Canopy's surroundings, behaviour unchanged:
// - BrowserControlInterrupted is a plain Error subclass instead of an Effect
//   Schema.TaggedError. It keeps `_tag`, the same default `message` and the
//   same default `reason`, and gains `status: 409` so runner.mjs POST /browser
//   answers it as a conflict.

export class BrowserControlInterrupted extends Error {
  constructor({
    message = 'Browser control changed. Refresh the snapshot before trying again.',
    reason = 'interrupted',
  } = {}) {
    super(message);
    this.name = 'BrowserControlInterrupted';
    this._tag = 'BrowserControlInterrupted';
    /** interrupted | humanControl | agentMismatch | closed | dialogPending */
    this.reason = reason;
    this.status = 409;
  }
}

const settle = work =>
  work.then(
    () => undefined,
    () => undefined,
  );

/** Reserves control immediately, but drains running work before the new owner can act. */
export class SessionControl {
  /** @param {string|null} agentId @param {() => void} [onGenerationChange] */
  constructor(agentId, onGenerationChange = () => {}) {
    this.agentId = agentId;
    this.onGenerationChange = onGenerationChange;
    this.tail = Promise.resolve();
    /** @type {{entry:{viewerId:string,key:string,input:unknown,run:(input:any)=>Promise<void>},result:Promise<void>}|null} */
    this.latestHuman = null;
    this.pending = Promise.resolve();
    this.handoff = new Set();
    this.owner = null;
    this.epoch = 0;
    this.closed = false;
  }

  get controller() {
    return this.owner;
  }

  get generation() {
    return this.epoch;
  }

  enqueue(run) {
    this.latestHuman = null;
    const result = this.tail.then(run);
    this.tail = result.then(
      () => this.pending,
      () => this.pending,
    );
    return result;
  }

  /** An action can respond before its navigation commits, while later actions still wait. */
  track(work) {
    this.pending = Promise.all([this.pending, settle(work)]).then(() => undefined);
  }

  /** Viewer input stays responsive, but control handoffs still drain its navigations. */
  trackUntilHandoff(work) {
    const settled = settle(work).finally(() => {
      this.handoff.delete(settled);
    });
    this.handoff.add(settled);
  }

  assertOpen() {
    if (this.closed)
      throw new BrowserControlInterrupted({
        message: 'This browser tab is closed.',
        reason: 'closed',
      });
  }

  changeOwner(owner) {
    this.latestHuman = null;
    this.owner = owner;
    this.epoch++;
    this.onGenerationChange();
  }

  async action(allowed, run, deadlineMs) {
    this.assertOpen();
    if (!allowed())
      throw new BrowserControlInterrupted({ message: 'You do not control this browser tab.' });
    const epoch = this.epoch;
    return this.enqueue(async () => {
      this.assertOpen();
      if (epoch !== this.epoch || !allowed()) throw new BrowserControlInterrupted();
      if (deadlineMs !== undefined && performance.now() >= deadlineMs) {
        throw new DOMException(
          'This browser request expired before it could start.',
          'TimeoutError',
        );
      }
      return run();
    });
  }

  agentMayAct(agentId) {
    return this.agentId === null || this.agentId === agentId;
  }

  agent(agentId, run, deadlineMs) {
    if (!this.agentMayAct(agentId))
      return Promise.reject(
        new BrowserControlInterrupted({
          message: 'This tab belongs to another agent.',
          reason: 'agentMismatch',
        }),
      );
    if (this.owner !== null)
      return Promise.reject(
        new BrowserControlInterrupted({
          message: 'A human controls this tab.',
          reason: 'humanControl',
        }),
      );
    return this.action(() => this.agentMayAct(agentId) && this.owner === null, run, deadlineMs);
  }

  agentCanActNow(agentId) {
    return this.agentMayAct(agentId) && this.owner === null;
  }

  /** Read without control or queueing so agents can observe without delaying human input. */
  observe(run) {
    this.assertOpen();
    return run();
  }

  system(run) {
    this.assertOpen();
    return this.enqueue(async () => {
      this.assertOpen();
      return run();
    });
  }

  human(viewerId, run) {
    return this.action(() => this.owner === viewerId, run);
  }

  /**
   * Merge into only adjacent waiting work with the same key; the running action and
   * intervening actions keep their order. Work sharing a key must share its input type.
   */
  humanLatest(viewerId, key, input, run, merge = (_waiting, next) => next) {
    if (this.closed || this.owner !== viewerId) return this.human(viewerId, () => run(input));
    const latest = this.latestHuman;
    if (latest?.entry.viewerId === viewerId && latest.entry.key === key) {
      latest.entry.input = merge(latest.entry.input, input);
      latest.entry.run = run;
      return latest.result;
    }
    const entry = { viewerId, key, input, run };
    const result = this.human(viewerId, async () => {
      if (this.latestHuman?.entry === entry) this.latestHuman = null;
      await entry.run(entry.input);
    });
    this.latestHuman = { entry, result };
    return result;
  }

  async take(viewerId) {
    this.assertOpen();
    if (this.owner !== null && this.owner !== viewerId) {
      throw new BrowserControlInterrupted({ message: 'Another viewer controls this browser tab.' });
    }
    if (this.owner !== viewerId) this.changeOwner(viewerId);
    return this.human(viewerId, async () => {});
  }

  async release(viewerId, afterDrain = async () => {}) {
    this.assertOpen();
    if (this.owner !== viewerId) {
      throw new BrowserControlInterrupted({
        message: 'Only the controlling viewer can release this browser tab.',
      });
    }
    this.changeOwner(null);
    await this.enqueue(async () => {
      await Promise.all(this.handoff);
      await afterDrain();
    });
  }

  async disconnect(viewerId, afterDrain) {
    if (!this.closed && this.owner === viewerId) await this.release(viewerId, afterDrain);
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      this.changeOwner(null);
    }
    await this.tail;
  }
}
