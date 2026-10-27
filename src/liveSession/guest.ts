// The joiner's side of a live session: watching a teammate's running agent
// session from their live-session card, hand-off card or a shared cloud
// terminal.
//
// Joining says "I'm watching" to the owner's Canopy and repeats it every 30 s
// (that is the presence everyone sees); the owner's Canopy answers with the
// room as it stands and then streams each turn. A message for the agent goes
// to the owner, who sends, edits or declines it — unless they let teammates
// talk to the agent directly. Nothing here can reach the agent itself.
import type { LiveJoin } from "../sessionDoc/events";
import type { LiveOp, LiveTerminal, LiveTurn } from "../teamMessaging/liveEvents";
import { LIVE_LIMITS } from "../teamMessaging/liveEvents";
import type { TeamLiveEvent } from "../teamMessaging/session";

export type GuestStatus = "connecting" | "live" | "quiet" | "unreachable" | "ended" | "removed" | "not-allowed";
export interface GuestRequest {
  id: string;
  text: string;
  state: "waiting" | "sent" | "declined" | "failed";
  /** The owner changed it before sending. */
  sentAs?: string;
}
export interface GuestSnapshot {
  status: GuestStatus;
  title: string;
  agent: string;
  direct: boolean;
  viewers: string[];
  turns: LiveTurn[];
  terminal?: LiveTerminal;
  requests: GuestRequest[];
}
export interface GuestDeps {
  send(team: string, peer: string, room: string, op: LiveOp, reachAll?: boolean): Promise<number>;
  subscribe(fn: (e: TeamLiveEvent) => void): () => void;
  now(): number;
}

export const HEARTBEAT_MS = 30_000;
/** No word from the owner's Canopy for this long: say so. */
export const QUIET_MS = 75_000;
const KEEP_TURNS = 200;

export class LiveGuest {
  private snapshot: GuestSnapshot;
  private listeners = new Set<() => void>();
  private stopFns: (() => void)[] = [];
  private heard = 0;
  private started = 0;
  private stopped = false;
  readonly join: LiveJoin;
  private deps: GuestDeps;
  constructor(join: LiveJoin, deps: GuestDeps) {
    this.join = join;
    this.deps = deps;
    this.snapshot = {
      status: "connecting",
      title: join.title,
      agent: join.agent,
      direct: false,
      viewers: [],
      turns: [],
      ...(join.terminal ? { terminal: join.terminal } : {}),
      requests: [],
    };
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snapshot;
  private update(change: Partial<GuestSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((fn) => fn());
  }
  private closed() {
    return ["ended", "removed", "not-allowed"].includes(this.snapshot.status);
  }

  start() {
    this.started = this.deps.now();
    this.stopFns.push(this.deps.subscribe((e) => this.receive(e)));
    const ping = (first: boolean) => {
      if (this.stopped || this.closed()) return;
      void this.deps
        .send(this.join.team, this.join.owner, this.join.room, { op: "join" }, first)
        .then((devices) => {
          if (first && !devices && !this.stopped) this.update({ status: "unreachable" });
        })
        .catch(() => {
          if (first && !this.stopped) this.update({ status: "unreachable" });
        });
    };
    ping(true);
    const timer = setInterval(() => {
      ping(false);
      this.check();
    }, HEARTBEAT_MS);
    this.stopFns.push(() => clearInterval(timer));
  }
  /** Marks the owner as quiet when their Canopy stopped answering. */
  check() {
    if (this.closed() || this.snapshot.status === "unreachable") return;
    const since = this.heard || this.started;
    if (this.deps.now() - since > QUIET_MS) this.update({ status: "quiet" });
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (!this.closed()) void this.deps.send(this.join.team, this.join.owner, this.join.room, { op: "leave" }).catch(() => {});
    this.stopFns.splice(0).forEach((fn) => fn());
  }

  /** Ask for (or, when the owner allows it, give) the agent a message. */
  async say(text: string): Promise<void> {
    const body = text.trim();
    if (!body) throw new Error("Write a message first.");
    if (new TextEncoder().encode(body).length > LIVE_LIMITS.sayBytes) throw new Error("Keep it under 4 KB.");
    if (this.closed()) throw new Error("This session is closed to you.");
    const id = crypto.randomUUID();
    this.update({ requests: [...this.snapshot.requests, { id, text: body, state: "waiting" }] });
    try {
      const devices = await this.deps.send(this.join.team, this.join.owner, this.join.room, { op: "say", request: id, text: body });
      if (!devices) throw new Error("not reachable");
    } catch {
      this.update({ requests: this.snapshot.requests.map((r) => (r.id === id ? { ...r, state: "failed" } : r)) });
      throw new Error(`Couldn't reach ${this.join.ownerName ?? "the owner"}'s Canopy. Try again in a moment.`);
    }
  }

  private receive(e: TeamLiveEvent) {
    if (this.stopped || e.team !== this.join.team || e.sender !== this.join.owner || e.event.target !== this.join.room) return;
    this.heard = this.deps.now();
    const ev = e.event;
    switch (ev.op) {
      case "state":
        if (this.closed()) return;
        this.update({
          status: "live",
          title: ev.title,
          agent: ev.agent,
          direct: ev.direct,
          viewers: ev.viewers,
          terminal: ev.terminal ?? this.join.terminal,
          ...(ev.turns ? { turns: ev.turns } : {}),
        });
        return;
      case "turn": {
        const turns = [...this.snapshot.turns.filter((t) => t.id !== ev.turn.id), ev.turn].slice(-KEEP_TURNS);
        this.update({ turns, ...(this.snapshot.status === "quiet" ? { status: "live" as const } : {}) });
        return;
      }
      case "answer":
        this.update({
          requests: this.snapshot.requests.map((r) =>
            r.id === ev.request ? { ...r, state: ev.outcome, ...(ev.text ? { sentAs: ev.text } : {}) } : r,
          ),
        });
        return;
      case "bye":
        this.update({ status: ev.reason === "ended" ? "ended" : ev.reason });
        return;
      default:
        return;
    }
  }
}
