// The owner's side of a live session: the rooms this Canopy holds open for
// teammates to join one of its running agent sessions.
//
// A room is in memory only. It holds who is watching (presence), what they
// asked to tell the agent (requests the owner sends, edits or declines), the
// recent turns a joiner sees on arrival, and the conversations the owner
// invited from. Nothing is shared until the owner posts a live-session card
// (or shares the agent's cloud terminal with the room); a join from anyone
// that card did not reach is refused. Closing Canopy closes every room — the
// joiners' views say the owner stopped answering.
//
// Traffic goes over the team chat's encrypted message path as live events
// (teamMessaging/liveEvents.ts); this module only decides what to send.
import { fitState, LIVE_LIMITS, type LiveOp, type LiveTerminal, type LiveTurn } from "../teamMessaging/liveEvents";
import { clipBytes, stripAnsi } from "../teamMessaging/cardSchema";

/** A conversation a live-session card was posted in: the team's channel
 *  (`peer` null, everyone in it) or a direct message with one person. */
export interface Audience {
  team: string;
  peer: string | null;
}
export interface Viewer {
  id: string;
  team: string;
  name: string;
  since: number;
  seen: number;
}
export interface LiveRequest {
  id: string;
  from: string;
  team: string;
  name: string;
  text: string;
  at: number;
}
export interface Room {
  id: string;
  sessionId: string;
  title: string;
  agent: string;
  /** Teammates may talk to the agent without the owner approving each message. */
  direct: boolean;
  viewers: Viewer[];
  requests: LiveRequest[];
  turns: LiveTurn[];
  audiences: Audience[];
  /** Anyone in these teams who knows the room may join: it rides on a cloud
   *  terminal shared through Shared sessions, whose list the workspace only
   *  shows to members with access. */
  openTo: string[];
  terminal?: LiveTerminal;
  removed: string[];
  /** The last thing that happened that the owner should read. */
  notice?: string;
}

export interface RoomDeps {
  send(team: string, peer: string, room: string, op: LiveOp): Promise<number>;
  /** The team's people by account id, or null when this Canopy is not in it. */
  members(team: string): Record<string, string> | null;
  now(): number;
}
export type Deliver = (text: string) => Promise<{ delivered: boolean; note: string }>;

/** A viewer who has not said they are watching for this long has left. */
export const VIEWER_TTL_MS = 90_000;
const MAX_REQUESTS = 20;
const MAX_PENDING_PER_VIEWER = 3;
const KEEP_TURNS = 40;

const clip = (text: string, maxBytes: number = LIVE_LIMITS.turnBytes) => {
  const clean = stripAnsi(text).trim();
  const { text: out, clipped } = clipBytes(clean, maxBytes - 4);
  return clipped ? `${out}…` : out;
};
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();
/** A changed file as a joiner sees it: repo-relative as given, or only its
 *  name when it is an absolute path on this computer. */
export function shownFile(path: string): string {
  const abs = path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
  const out = abs ? (path.split(/[\\/]/).pop() ?? "") : path.replace(/\\/g, "/");
  return [...out].slice(-LIVE_LIMITS.fileChars).join("");
}

/** What the agent is given for a joiner's message: who said it, then the words.
 *  One line, because it is typed into a terminal where Enter submits. */
export function attributed(name: string, text: string): string {
  return `[${oneLine(name)}, watching this session live in Canopy, says:] ${oneLine(text)}`;
}

export class LiveRooms {
  private rooms: Room[] = [];
  private delivers = new Map<string, Deliver>();
  /** Joiner messages delivered lately, so the agent's own report of the same
   *  prompt does not show twice. */
  private delivered = new Map<string, { text: string; by: string; at: number }[]>();
  private listeners = new Set<() => void>();
  /** Rooms this instance closed, so a late joiner hears that it ended. */
  private closed = new Set<string>();
  private deps: RoomDeps;
  constructor(deps: RoomDeps) {
    this.deps = deps;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.rooms;
  room(id: string) {
    return this.rooms.find((r) => r.id === id);
  }
  forSession(sessionId: string) {
    return this.rooms.find((r) => r.sessionId === sessionId);
  }
  private set(id: string, change: (r: Room) => Room) {
    this.rooms = this.rooms.map((r) => (r.id === id ? change(r) : r));
    this.listeners.forEach((fn) => fn());
  }

  /** Opens (or returns) the room for a running session. `turns` seed what a
   *  joiner sees on arrival. */
  open(args: { sessionId: string; title: string; agent: string; turns?: LiveTurn[]; deliver: Deliver }): Room {
    this.delivers.set(args.sessionId, args.deliver);
    const existing = this.forSession(args.sessionId);
    if (existing) return existing;
    const room: Room = {
      id: crypto.randomUUID(),
      sessionId: args.sessionId,
      title: clip(args.title, 400).replace(/\s+/g, " ") || "Agent session",
      agent: clip(args.agent, 60).replace(/\s+/g, " ") || "agent",
      direct: false,
      viewers: [],
      requests: [],
      turns: (args.turns ?? []).slice(-KEEP_TURNS),
      audiences: [],
      openTo: [],
      removed: [],
    };
    this.rooms = [...this.rooms, room];
    this.listeners.forEach((fn) => fn());
    return room;
  }

  /** A live-session card went to this conversation. */
  allow(id: string, audience: Audience) {
    this.set(id, (r) =>
      r.audiences.some((a) => a.team === audience.team && a.peer === audience.peer)
        ? r
        : { ...r, audiences: [...r.audiences, audience] },
    );
  }
  /** The agent's terminal is shared with the room through a workspace's
   *  Shared sessions; members of `team` who see it there may join. */
  setTerminal(id: string, terminal: LiveTerminal | undefined, team?: string) {
    this.set(id, (r) => ({
      ...r,
      terminal,
      openTo: terminal ? (team && !r.openTo.includes(team) ? [...r.openTo, team] : r.openTo) : [],
    }));
    this.broadcastState(id);
  }
  setDirect(id: string, direct: boolean) {
    this.set(id, (r) => ({ ...r, direct }));
    this.broadcastState(id);
  }

  private allowed(r: Room, team: string, user: string) {
    if (r.removed.includes(`${team}:${user}`)) return false;
    const members = this.deps.members(team);
    const member = !!members && user in members;
    if (r.audiences.some((a) => a.team === team && a.peer === user)) return true;
    if (!member) return false;
    return r.audiences.some((a) => a.team === team && a.peer === null) || r.openTo.includes(team);
  }

  private send(team: string, peer: string, room: string, op: LiveOp) {
    void this.deps.send(team, peer, room, op).catch(() => {});
  }
  private state(r: Room, turns: boolean): LiveOp {
    const { type: _t, target: _r, ...op } = fitState({
      type: "live",
      target: r.id,
      op: "state",
      title: r.title,
      agent: r.agent,
      direct: r.direct,
      viewers: r.viewers.map((v) => v.id),
      ...(turns ? { turns: r.turns.slice(-LIVE_LIMITS.turns) } : {}),
      ...(r.terminal ? { terminal: r.terminal } : {}),
    });
    return op as LiveOp;
  }
  private broadcastState(id: string) {
    const r = this.room(id);
    if (!r) return;
    const op = this.state(r, false);
    for (const v of r.viewers) this.send(v.team, v.id, r.id, op);
  }
  private broadcast(id: string, op: LiveOp) {
    const r = this.room(id);
    if (r) for (const v of r.viewers) this.send(v.team, v.id, r.id, op);
  }

  /** A live event from a teammate. */
  handle(e: { team: string; sender: string; senderName?: string; event: { target: string } & LiveOp }) {
    const { team, sender, event } = e;
    const r = this.room(event.target);
    if (!r) {
      // A room this Canopy closed. Any other unknown room may be held by
      // another of the owner's devices (they share one account), so stay
      // silent: a joiner whose owner never answers sees that it went quiet.
      if (this.closed.has(event.target) && (event.op === "join" || event.op === "say"))
        this.send(team, sender, event.target, { op: "bye", reason: "ended" });
      return;
    }
    const now = this.deps.now();
    const viewer = r.viewers.find((v) => v.id === sender && v.team === team);
    switch (event.op) {
      case "join": {
        if (!this.allowed(r, team, sender)) {
          const removed = r.removed.includes(`${team}:${sender}`);
          this.send(team, sender, r.id, { op: "bye", reason: removed ? "removed" : "not-allowed" });
          return;
        }
        if (viewer) {
          this.set(r.id, (x) => ({ ...x, viewers: x.viewers.map((v) => (v === viewer ? { ...v, seen: now } : v)) }));
          this.send(team, sender, r.id, this.state(this.room(r.id)!, false));
          return;
        }
        const name = e.senderName || this.deps.members(team)?.[sender] || "A teammate";
        if (r.viewers.length >= LIVE_LIMITS.viewers) {
          this.send(team, sender, r.id, { op: "bye", reason: "not-allowed" });
          return;
        }
        this.set(r.id, (x) => ({
          ...x,
          viewers: [...x.viewers, { id: sender, team, name, since: now, seen: now }],
          notice: `${name} joined.`,
        }));
        this.send(team, sender, r.id, this.state(this.room(r.id)!, true));
        const others = this.room(r.id)!;
        const op = this.state(others, false);
        for (const v of others.viewers) if (v.id !== sender || v.team !== team) this.send(v.team, v.id, r.id, op);
        return;
      }
      case "leave":
        if (!viewer) return;
        this.set(r.id, (x) => ({ ...x, viewers: x.viewers.filter((v) => v !== viewer), notice: `${viewer.name} left.` }));
        this.broadcastState(r.id);
        return;
      case "say": {
        if (!viewer || !this.allowed(r, team, sender)) {
          this.send(team, sender, r.id, { op: "answer", request: event.request, outcome: "declined" });
          return;
        }
        this.set(r.id, (x) => ({ ...x, viewers: x.viewers.map((v) => (v === viewer ? { ...v, seen: now } : v)) }));
        if (r.direct) {
          void this.deliverRequest(r.id, { id: event.request, from: sender, team, name: viewer.name, text: event.text, at: now });
          return;
        }
        const pending = r.requests.filter((q) => q.from === sender && q.team === team).length;
        if (pending >= MAX_PENDING_PER_VIEWER || r.requests.length >= MAX_REQUESTS || r.requests.some((q) => q.id === event.request)) {
          this.send(team, sender, r.id, { op: "answer", request: event.request, outcome: "declined" });
          return;
        }
        this.set(r.id, (x) => ({
          ...x,
          requests: [...x.requests, { id: event.request, from: sender, team, name: viewer.name, text: event.text, at: now }],
          notice: `${viewer.name} wants to tell the agent something.`,
        }));
        return;
      }
      default:
        // Owner-to-joiner ops are never valid inbound here.
        return;
    }
  }

  private async deliverRequest(id: string, q: LiveRequest, edited?: string): Promise<boolean> {
    const r = this.room(id);
    const deliver = r && this.delivers.get(r.sessionId);
    const text = (edited ?? q.text).trim();
    if (!r || !deliver || !text) {
      this.send(q.team, q.from, id, { op: "answer", request: q.id, outcome: "failed" });
      return false;
    }
    let result: { delivered: boolean; note: string };
    try {
      result = await deliver(attributed(q.name, text));
    } catch (e) {
      result = { delivered: false, note: e instanceof Error ? e.message : String(e) };
    }
    const changed = edited !== undefined && edited.trim() !== q.text.trim();
    this.send(q.team, q.from, id, {
      op: "answer",
      request: q.id,
      outcome: result.delivered ? "sent" : "failed",
      ...(changed && result.delivered ? { text: clip(text, LIVE_LIMITS.sayBytes) } : {}),
    });
    if (!result.delivered) {
      this.set(id, (x) => ({ ...x, notice: `Couldn't give ${q.name}'s message to the agent: ${result.note}` }));
      return false;
    }
    const at = this.deps.now();
    const list = (this.delivered.get(r.sessionId) ?? []).filter((d) => at - d.at < 120_000);
    list.push({ text: oneLine(text), by: q.name, at });
    this.delivered.set(r.sessionId, list);
    this.addTurn(r.sessionId, { id: `say:${q.id}`, at, kind: "prompt", text: clip(text), by: q.name });
    return true;
  }

  /** Send a joiner's message to the agent, as written or as edited. */
  async approve(id: string, requestId: string, edited?: string): Promise<boolean> {
    const q = this.room(id)?.requests.find((x) => x.id === requestId);
    if (!q) return false;
    this.set(id, (x) => ({ ...x, requests: x.requests.filter((y) => y.id !== requestId) }));
    return this.deliverRequest(id, q, edited);
  }
  decline(id: string, requestId: string) {
    const q = this.room(id)?.requests.find((x) => x.id === requestId);
    if (!q) return;
    this.set(id, (x) => ({ ...x, requests: x.requests.filter((y) => y.id !== requestId) }));
    this.send(q.team, q.from, id, { op: "answer", request: q.id, outcome: "declined" });
  }
  /** Removes a joiner. They are told, their requests are dropped, and a later
   *  join from them is refused for as long as this room is open. */
  kick(id: string, team: string, user: string) {
    const r = this.room(id);
    if (!r) return;
    const viewer = r.viewers.find((v) => v.id === user && v.team === team);
    this.set(id, (x) => ({
      ...x,
      viewers: x.viewers.filter((v) => !(v.id === user && v.team === team)),
      requests: x.requests.filter((q) => !(q.from === user && q.team === team)),
      removed: [...x.removed, `${team}:${user}`],
      notice: `${viewer?.name ?? "They"} can no longer watch or join this session.${
        x.terminal ? " The terminal stays visible in Shared sessions to everyone with access to the project until you stop showing it." : ""
      }`,
    }));
    this.send(team, user, id, { op: "bye", reason: "removed" });
    this.broadcastState(id);
  }
  /** Ends the live session for everyone watching it. */
  close(id: string) {
    const r = this.room(id);
    if (!r) return;
    for (const v of r.viewers) this.send(v.team, v.id, id, { op: "bye", reason: "ended" });
    for (const q of r.requests) this.send(q.team, q.from, id, { op: "answer", request: q.id, outcome: "declined" });
    this.rooms = this.rooms.filter((x) => x.id !== id);
    this.closed.add(id);
    this.delivers.delete(r.sessionId);
    this.delivered.delete(r.sessionId);
    this.listeners.forEach((fn) => fn());
  }

  private addTurn(sessionId: string, turn: LiveTurn) {
    const r = this.forSession(sessionId);
    if (!r) return;
    this.set(r.id, (x) => ({ ...x, turns: [...x.turns.filter((t) => t.id !== turn.id), turn].slice(-KEEP_TURNS) }));
    this.broadcast(r.id, { op: "turn", turn });
  }
  /** The agent started a turn (agentTurns.ts). A prompt that is a joiner's
   *  message just delivered is already in the transcript, under their name. */
  turnStarted(sessionId: string, prompt: string | undefined, at: number) {
    if (!this.forSession(sessionId)) return;
    const text = clip(prompt ?? "");
    if (!text) return;
    const recent = this.delivered.get(sessionId) ?? [];
    const flat = oneLine(prompt ?? "");
    if (recent.some((d) => flat.includes(d.text))) return;
    this.addTurn(sessionId, { id: `p:${at}`, at, kind: "prompt", text });
  }
  turnEnded(sessionId: string, lastMessage: string | undefined, files: string[], at: number) {
    if (!this.forSession(sessionId)) return;
    const text = clip(lastMessage ?? "") || "Finished the turn.";
    const shown = files.slice(0, LIVE_LIMITS.files).map(shownFile).filter(Boolean);
    this.addTurn(sessionId, { id: `r:${at}`, at, kind: "reply", text, ...(shown.length ? { files: shown } : {}) });
  }

  /** Drops viewers who stopped saying they are watching. */
  prune() {
    const now = this.deps.now();
    for (const r of this.rooms) {
      const gone = r.viewers.filter((v) => now - v.seen > VIEWER_TTL_MS);
      if (!gone.length) continue;
      this.set(r.id, (x) => ({ ...x, viewers: x.viewers.filter((v) => !gone.includes(v)) }));
      this.broadcastState(r.id);
    }
  }
  clearNotice(id: string) {
    this.set(id, (x) => ({ ...x, notice: undefined }));
  }
}
