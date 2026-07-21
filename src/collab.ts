// Collaborative editing over the team relay. Design, and the reasoning for
// choosing owner-sequenced OT over a CRDT, is in docs/collab-editing.md — read
// §5 (invariant COLLAB-1) before touching anything here.
//
// The transform lives in TypeScript, not Rust, because the document's truth is
// a Monaco model. Putting it in Rust would mean a second rope next to Monaco's
// and an IPC round-trip on every keystroke. Rust is pure transport for this
// feature and gained no dependency for it.
import { monaco } from "./monaco-setup";
import * as ipc from "./ipc";

import {
  docHash,
  newDocId,
  opsFromChanges,
  peerColour,
  safeName,
  transform,
  transformOffset,
  type Op,
} from "./collab-ot";

export * from "./collab-ot";

const HASH_EVERY = 16;

// ---------- Monaco glue ----------


/** Apply an operation to a live model. The edits are built in pre-edit
 *  coordinates and applied from the end backwards, so an earlier edit can
 *  never be shifted by a later one — the failure mode when you trust a batch
 *  edit to sort itself. */
function applyToModel(model: monaco.editor.ITextModel, ops: Op[]) {
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  let at = 0;
  for (const o of ops) {
    if (o.op === "retain") {
      at += o.n;
    } else if (o.op === "insert") {
      const p = model.getPositionAt(at);
      edits.push({ range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), text: o.s });
    } else {
      const s = model.getPositionAt(at);
      const e = model.getPositionAt(at + o.n);
      edits.push({ range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column), text: "" });
      at += o.n;
    }
  }
  edits.sort((x, y) => model.getOffsetAt({ lineNumber: y.range.startLineNumber, column: y.range.startColumn })
    - model.getOffsetAt({ lineNumber: x.range.startLineNumber, column: x.range.startColumn }));
  model.applyEdits(edits);
}


// ---------- wire bodies ----------

export type CollabBody =
  | { kind: "offer"; name: string; lang: string | null }
  | { kind: "open" }
  | { kind: "snapshot"; rev: number; text: string }
  | { kind: "ops"; rev: number; ops: Op[]; author: string; hash: string | null }
  | { kind: "resync"; reason: string }
  | { kind: "close"; reason: string }
  | { kind: "cursor"; anchor: number; head: number; rev: number }
  | { kind: "project-offer"; name: string }
  | { kind: "project-tree"; paths: string[] }
  | { kind: "project-open"; path: string };

export interface CollabMsg {
  id: string;
  from: string;
  from_name: string;
  to: string | null;
  doc: string;
  body: CollabBody;
  ts: number;
}



// ---------- sessions ----------

/** Presence for one remote participant, as the UI wants to draw it. */
export interface RemoteCursor {
  peer: string;
  name: string;
  colour: string;
  anchor: number;
  head: number;
}

interface Wire {
  selfId: string;
  send: (to: string | null, doc: string, body: CollabBody) => void;
}

/** Shared behaviour: own the model subscription, expose remote cursors, and
 *  make sure a remote application never re-enters as a local edit. */
abstract class Session {
  readonly cursors = new Map<string, RemoteCursor>();
  onCursors: (() => void) | null = null;
  onNotice: ((text: string) => void) | null = null;
  protected applying = false;
  protected sub: monaco.IDisposable | null = null;
  private decorations: string[] = [];

  readonly doc: string;
  readonly model: monaco.editor.ITextModel;
  protected readonly wire: Wire;

  constructor(doc: string, model: monaco.editor.ITextModel, wire: Wire) {
    this.doc = doc;
    this.model = model;
    this.wire = wire;
    this.sub = model.onDidChangeContent((e) => {
      if (this.applying) return;
      try {
        const before = model.getValueLength() - e.changes.reduce((n, c) => n + c.text.length - c.rangeLength, 0);
        this.onLocalChange(opsFromChanges(before, e.changes));
      } catch (err) {
        this.onNotice?.(`Live edit desynchronised: ${String(err)}`);
      }
    });
  }

  protected abstract onLocalChange(ops: Op[]): void;
  abstract receive(msg: CollabMsg): void;
  abstract get rev(): number;

  protected applyRemote(ops: Op[]) {
    this.applying = true;
    try {
      applyToModel(this.model, ops);
    } finally {
      this.applying = false;
    }
    for (const c of this.cursors.values()) {
      c.anchor = transformOffset(c.anchor, ops);
      c.head = transformOffset(c.head, ops);
    }
    this.onCursors?.();
  }

  protected noteCursor(from: string, name: string, anchor: number, head: number) {
    this.cursors.set(from, { peer: from, name, colour: peerColour(from), anchor, head });
    this.onCursors?.();
  }

  dropPeer(id: string) {
    if (this.cursors.delete(id)) this.onCursors?.();
  }

  /** Local caret out to everyone on the document. Throttled by the caller. */
  sendCursor(anchor: number, head: number) {
    this.wire.send(null, this.doc, { kind: "cursor", anchor, head, rev: this.rev });
  }

  /** Remote carets as Monaco decorations. Model-level so this works without a
   *  handle on the editor instance, and so it survives the model being swapped
   *  between editors. */
  paint() {
    const next: monaco.editor.IModelDeltaDecoration[] = [];
    for (const c of this.cursors.values()) {
      const a = this.model.getPositionAt(Math.min(c.anchor, this.model.getValueLength()));
      const h = this.model.getPositionAt(Math.min(c.head, this.model.getValueLength()));
      if (c.anchor !== c.head) {
        const [s, e] = c.anchor < c.head ? [a, h] : [h, a];
        next.push({
          range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column),
          options: { className: "collab-selection", hoverMessage: { value: c.name } },
        });
      }
      next.push({
        range: new monaco.Range(h.lineNumber, h.column, h.lineNumber, h.column),
        options: {
          className: "collab-cursor",
          hoverMessage: { value: c.name },
          beforeContentClassName: "collab-cursor-caret",
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    this.decorations = this.model.deltaDecorations(this.decorations, next);
  }

  dispose() {
    this.sub?.dispose();
    this.sub = null;
    this.decorations = this.model.deltaDecorations(this.decorations, []);
  }
}

/** The owner: the peer whose disk the file is on, and therefore the only peer
 *  that can persist it and the only one that can order operations. */
export class OwnerSession extends Session {
  private revision = 0;
  /** history[r] took the document from revision r to r+1. Kept only as far
   *  back as the slowest peer's base — but v1 keeps all of it, because a
   *  session is one file for one sitting and the memory is not the problem
   *  worth solving before the feature has users. */
  private history: Op[][] = [];
  /** Members allowed to open this document. Populated ONLY from an explicit
   *  local share; an `open` from anyone else is dropped. This is the access
   *  control, and it is on the owner because the owner is the only party whose
   *  copy matters. */
  readonly allowed = new Set<string>();
  readonly roster = new Set<string>();

  /** The absolute path. Stays here, in this process, in this object — it is
   *  never put in a frame. See COLLAB-1. */
  readonly path: string;

  constructor(doc: string, model: monaco.editor.ITextModel, wire: Wire, path: string) {
    super(doc, model, wire);
    this.path = path;
  }

  get rev() {
    return this.revision;
  }

  private broadcast(ops: Op[], author: string) {
    this.revision += 1;
    this.history.push(ops);
    this.wire.send(null, this.doc, {
      kind: "ops",
      rev: this.revision,
      ops,
      author,
      hash: this.revision % HASH_EVERY === 0 ? docHash(this.model.getValue()) : null,
    });
  }

  protected onLocalChange(ops: Op[]) {
    this.broadcast(ops, this.wire.selfId);
  }

  receive(msg: CollabMsg) {
    const b = msg.body;
    if (b.kind === "open") {
      if (!this.allowed.has(msg.from)) return;
      this.roster.add(msg.from);
      this.wire.send(msg.from, this.doc, {
        kind: "snapshot",
        rev: this.revision,
        text: this.model.getValue(),
      });
      return;
    }
    if (b.kind === "resync") {
      if (!this.roster.has(msg.from)) return;
      this.wire.send(msg.from, this.doc, {
        kind: "snapshot",
        rev: this.revision,
        text: this.model.getValue(),
      });
      return;
    }
    if (b.kind === "cursor") {
      if (!this.roster.has(msg.from)) return;
      this.noteCursor(msg.from, msg.from_name, b.anchor, b.head);
      return;
    }
    if (b.kind === "close") {
      this.roster.delete(msg.from);
      this.dropPeer(msg.from);
      return;
    }
    if (b.kind !== "ops") return;
    if (!this.roster.has(msg.from)) return;
    if (b.rev > this.revision) return;
    try {
      // Transform the peer's operation forward over everything sequenced
      // since the base it was composed against. Ours is the authoritative
      // side, so it is the FIRST argument on every step.
      let theirs = b.ops;
      for (let r = b.rev; r < this.revision; r++) {
        [, theirs] = transform(this.history[r], theirs);
      }
      this.applyRemote(theirs);
      this.broadcast(theirs, msg.from);
    } catch (err) {
      this.onNotice?.(`Dropped an edit from ${msg.from_name}: ${String(err)}`);
    }
  }

  /** Offer the document to a member. This is the only thing that grants
   *  access, and it can only be reached from an explicit local UI action. */
  offerTo(member: string, name: string, lang: string | null) {
    this.allowed.add(member);
    this.wire.send(member, this.doc, { kind: "offer", name: safeName(name), lang });
  }

  dispose() {
    this.wire.send(null, this.doc, { kind: "close", reason: "The owner stopped sharing." });
    super.dispose();
  }
}

/** A peer editing someone else's file. Its model is detached — it has no path
 *  and cannot be saved — which is the whole security story in one sentence. */
export class GuestSession extends Session {
  private revision = 0;
  /** The one operation the owner has not yet acknowledged. Exactly one is in
   *  flight at a time, so the owner never has to transform two of ours against
   *  each other and we never need `compose`. */
  private outstanding: Op[] | null = null;
  private queued: Op[][] = [];
  /** True once the owner is gone: the buffer becomes a local scratch copy. */
  orphaned = false;
  onOrphaned: (() => void) | null = null;

  readonly owner: string;

  constructor(doc: string, model: monaco.editor.ITextModel, wire: Wire, owner: string, rev: number) {
    super(doc, model, wire);
    this.owner = owner;
    this.revision = rev;
  }

  get rev() {
    return this.revision;
  }

  protected onLocalChange(ops: Op[]) {
    if (this.orphaned) return;
    this.queued.push(ops);
    this.flush();
  }

  private flush() {
    if (this.outstanding || this.queued.length === 0) return;
    this.outstanding = this.queued.shift()!;
    this.wire.send(this.owner, this.doc, {
      kind: "ops",
      rev: this.revision,
      ops: this.outstanding,
      author: this.wire.selfId,
      hash: null,
    });
  }

  private resync(reason: string) {
    this.outstanding = null;
    this.queued = [];
    this.wire.send(this.owner, this.doc, { kind: "resync", reason });
  }

  receive(msg: CollabMsg) {
    const b = msg.body;
    if (b.kind === "cursor") {
      if (msg.from !== this.wire.selfId) this.noteCursor(msg.from, msg.from_name, b.anchor, b.head);
      return;
    }
    if (b.kind === "close") {
      this.orphaned = true;
      this.onOrphaned?.();
      return;
    }
    if (b.kind === "snapshot") {
      // A resync answer: adopt the owner's copy wholesale. Anything local and
      // unacknowledged is gone, which is the point — we had diverged.
      this.applying = true;
      try {
        this.model.setValue(b.text);
      } finally {
        this.applying = false;
      }
      this.revision = b.rev;
      this.outstanding = null;
      this.queued = [];
      return;
    }
    if (b.kind !== "ops") return;
    if (b.rev !== this.revision + 1) {
      // A gap means a frame went missing, which TCP through the star should
      // make impossible — so if it happens, something is wrong enough that
      // guessing is the wrong response.
      this.resync(`expected revision ${this.revision + 1}, got ${b.rev}`);
      return;
    }
    try {
      if (b.author === this.wire.selfId) {
        // Our own operation coming back. We already applied it locally and, by
        // TP1, transformed it to exactly what the owner applied — so there is
        // nothing to do but advance and send the next one.
        this.revision = b.rev;
        this.outstanding = null;
        this.flush();
      } else {
        // The owner's operation is the FIRST argument at every step, matching
        // the order the owner used in `OwnerSession.receive`. This is not
        // cosmetic: `transform` breaks a tie between two inserts at the same
        // offset in favour of its first argument, so if the two sides disagree
        // about which operation is "first", concurrent inserts at the same
        // position land in opposite orders and the buffers diverge by exactly
        // those characters. Written the other way round first; scripts/
        // collab-fuzz.mjs caught it in 709 of 2000 randomised sessions, and
        // nothing about it is visible in a hand-written two-peer test.
        let theirs = b.ops;
        if (this.outstanding) [theirs, this.outstanding] = transform(theirs, this.outstanding);
        for (let i = 0; i < this.queued.length; i++) {
          [theirs, this.queued[i]] = transform(theirs, this.queued[i]);
        }
        this.applyRemote(theirs);
        this.revision = b.rev;
      }
      if (b.hash && docHash(this.model.getValue()) !== b.hash && !this.outstanding && this.queued.length === 0) {
        // Only meaningful when we have nothing in flight — with a pending
        // operation our copy is legitimately ahead of the owner's.
        this.resync("document hash disagreed with the owner");
      }
    } catch (err) {
      this.resync(String(err));
    }
  }

  dispose() {
    if (!this.orphaned) {
      this.wire.send(this.owner, this.doc, { kind: "close", reason: "left" });
    }
    super.dispose();
  }
}

// ---------- manager ----------

/** Routes relay frames to sessions and owns the doc -> session table. There is
 *  one of these per app. Note what it does NOT have: any way to turn a `doc`
 *  from the wire into a path. The only path in the whole module is
 *  `OwnerSession.path`, set from a local share. */
export class CollabManager {
  private sessions = new Map<string, Session>();
  /** Offers we have received and not yet accepted or dismissed. */
  readonly offers = new Map<string, { from: string; fromName: string; name: string; lang: string | null }>();
  /** Guest sessions that exist, with just enough to label a tab. Separate from
   *  the session itself so a view can be opened without reaching into one. */
  private guests = new Map<string, { name: string; ownerName: string }>();
  /** Projects we are sharing: project doc id -> its root, display name, and the
   *  members we've invited (one project, many members — not one per member). */
  private ownedProjects = new Map<
    string,
    { root: string; name: string; members: Set<string> }
  >();
  /** Project invitations received, awaiting accept or dismiss. */
  readonly projectOffers = new Map<string, { from: string; fromName: string; name: string }>();
  /** Projects we have joined (as a guest): doc id -> owner + the file tree. */
  readonly joinedProjects = new Map<
    string,
    { from: string; fromName: string; name: string; paths: string[] }
  >();
  /** Owners whose file offers we auto-accept, because we asked for the file by
   *  opening it from their shared tree. Without this a project open would pop a
   *  manual "accept?" for a file the guest explicitly clicked. */
  private autoAccept = new Set<string>();
  onOffer: ((doc: string) => void) | null = null;
  onNotice: ((text: string) => void) | null = null;
  /** Fires whenever the set of live sessions changes, so a view can re-read
   *  `activeCount` for the global "collaborating" indicator. */
  onChange: (() => void) | null = null;
  /** Owner: list a shared project's files, as paths RELATIVE to its root. */
  onListProject: ((root: string) => Promise<string[]>) | null = null;
  /** Owner: a peer asked for `relPath`; read it and share it live to `to`. */
  onServeFile: ((root: string, relPath: string, to: string) => void) | null = null;
  /** A project invitation arrived (peer wants to share their project). */
  onProjectOffer: ((doc: string) => void) | null = null;
  /** A project's tree arrived; open its browser. */
  onProjectJoined: ((doc: string) => void) | null = null;
  selfId = "";

  /** Whether any collaboration is live: an open file session, a project we're
   *  sharing (even before a file is opened), or one we've joined. Drives the
   *  "Collaborating" pill — and so the only place to stop, its cross. */
  get activeCount(): number {
    return this.sessions.size + this.ownedProjects.size + this.joinedProjects.size;
  }

  private wire: Wire = {
    selfId: "",
    send: (to, doc, body) => {
      void ipc.relaySendCollab(to, doc, body).catch((err) => this.onNotice?.(String(err)));
    },
  };

  setSelf(id: string) {
    this.selfId = id;
    this.wire = { ...this.wire, selfId: id };
  }

  get(doc: string): Session | undefined {
    return this.sessions.get(doc);
  }

  /** Start sharing an open file. The document id is minted here and the path
   *  never leaves this object. */
  share(path: string, model: monaco.editor.ITextModel): OwnerSession {
    const doc = newDocId();
    const s = new OwnerSession(doc, model, this.wire, path);
    s.onNotice = (t) => this.onNotice?.(t);
    this.sessions.set(doc, s);
    this.onChange?.();
    return s;
  }

  /** Accept an offer: ask the owner to let us in. The reply is a snapshot,
   *  which is where the guest session is actually created. */
  accept(doc: string) {
    const offer = this.offers.get(doc);
    if (!offer) return;
    this.wire.send(offer.from, doc, { kind: "open" });
  }

  dismiss(doc: string) {
    this.offers.delete(doc);
  }

  /** Start (or extend) sharing a whole project with a member. Sharing the same
   *  project with a second member reuses the one project doc rather than
   *  minting another; inviting someone already invited is a no-op. The root
   *  never leaves this object — only relative paths cross the wire. */
  shareProject(root: string, name: string, to: string): string {
    let doc = this.ownedProjectFor(root);
    if (!doc) {
      doc = newDocId();
      this.ownedProjects.set(doc, { root, name, members: new Set() });
    }
    const owned = this.ownedProjects.get(doc)!;
    if (!owned.members.has(to)) {
      owned.members.add(to);
      this.wire.send(to, doc, { kind: "project-offer", name: safeName(name) });
    }
    this.onChange?.();
    return doc;
  }

  /** Members a project (by root) is already shared with, so the share menu can
   *  mark them instead of offering a duplicate invite. */
  projectSharedWith(root: string): ReadonlySet<string> {
    const doc = this.ownedProjectFor(root);
    return doc ? this.ownedProjects.get(doc)!.members : new Set<string>();
  }

  /** Accept a project invitation: ask the owner for its file tree. */
  acceptProject(doc: string) {
    const offer = this.projectOffers.get(doc);
    if (!offer) return;
    this.wire.send(offer.from, doc, { kind: "open" });
  }

  dismissProject(doc: string) {
    this.projectOffers.delete(doc);
    this.onChange?.();
  }

  /** Guest: open one file from a joined project's tree. The owner answers with
   *  an ordinary file offer, which we auto-accept (see `autoAccept`). */
  openProjectFile(projectDoc: string, relPath: string) {
    const joined = this.joinedProjects.get(projectDoc);
    if (!joined) return;
    this.wire.send(joined.from, projectDoc, { kind: "project-open", path: relPath });
  }

  /** The project doc we are sharing for `root`, if any — so a view can tell
   *  whether to offer "Share project" or "Stop sharing". */
  ownedProjectFor(root: string): string | undefined {
    for (const [doc, p] of this.ownedProjects) if (p.root === root) return doc;
    return undefined;
  }

  /** Owner: stop sharing a project and end every live file under it. The guest
   *  gets a close on the project (their tree tab goes) and on each open file. */
  stopSharingProject(projectDoc: string) {
    const owned = this.ownedProjects.get(projectDoc);
    if (!owned) return;
    this.ownedProjects.delete(projectDoc);
    this.wire.send(null, projectDoc, {
      kind: "close",
      reason: "The owner stopped sharing the project.",
    });
    const prefix = owned.root.endsWith("/") ? owned.root : `${owned.root}/`;
    for (const [doc, s] of [...this.sessions]) {
      if (s instanceof OwnerSession && s.path.startsWith(prefix)) this.close(doc);
    }
    if (this.ownedProjects.size === 0) this.onServeFile = null;
    this.onChange?.();
  }

  /** End every collaboration this app is part of: unshare our projects and
   *  files, leave every project we joined, and close every live session. Peers
   *  are told, so their tabs end too. This is what the "Collaborating" pill's
   *  cross triggers. */
  stopAll() {
    for (const doc of [...this.ownedProjects.keys()]) this.stopSharingProject(doc);
    for (const doc of [...this.joinedProjects.keys()]) this.leaveProject(doc);
    for (const doc of [...this.sessions.keys()]) this.close(doc);
    this.onChange?.();
  }

  /** Guest: leave a project we joined (its tree tab is closing). */
  leaveProject(projectDoc: string) {
    const joined = this.joinedProjects.get(projectDoc);
    if (!joined) return;
    this.joinedProjects.delete(projectDoc);
    // Stop auto-accepting this owner's file offers once no joined project of
    // theirs remains.
    if (![...this.joinedProjects.values()].some((p) => p.from === joined.from)) {
      this.autoAccept.delete(joined.from);
    }
    this.onChange?.();
  }

  receive(msg: CollabMsg) {
    const existing = this.sessions.get(msg.doc);
    if (existing) {
      existing.receive(msg);
      existing.paint();
      return;
    }
    // Project-scope frames. A project doc has no OT session of its own — it is
    // a directory, not a document.
    if (msg.body.kind === "project-offer") {
      this.projectOffers.set(msg.doc, {
        from: msg.from,
        fromName: msg.from_name,
        name: safeName(msg.body.name),
      });
      this.onChange?.();
      this.onProjectOffer?.(msg.doc);
      return;
    }
    if (msg.body.kind === "project-tree") {
      const known = this.projectOffers.get(msg.doc);
      this.projectOffers.delete(msg.doc);
      this.joinedProjects.set(msg.doc, {
        from: msg.from,
        fromName: msg.from_name,
        name: known?.name ?? "project",
        paths: msg.body.paths,
      });
      this.autoAccept.add(msg.from);
      this.onChange?.();
      this.onProjectJoined?.(msg.doc);
      return;
    }
    if (msg.body.kind === "project-open") {
      const owned = this.ownedProjects.get(msg.doc);
      if (owned) this.onServeFile?.(owned.root, msg.body.path, msg.from);
      return;
    }
    if (msg.body.kind === "close" && this.joinedProjects.has(msg.doc)) {
      const joined = this.joinedProjects.get(msg.doc)!;
      this.joinedProjects.delete(msg.doc);
      if (![...this.joinedProjects.values()].some((p) => p.from === joined.from)) {
        this.autoAccept.delete(joined.from);
      }
      this.onChange?.();
      return;
    }
    if (msg.body.kind === "open" && this.ownedProjects.has(msg.doc)) {
      // A peer accepted our project invite; answer with the file tree.
      const { root } = this.ownedProjects.get(msg.doc)!;
      const from = msg.from;
      const doc = msg.doc;
      void (async () => {
        const paths = (await this.onListProject?.(root)) ?? [];
        this.wire.send(from, doc, { kind: "project-tree", paths });
      })();
      return;
    }
    if (msg.body.kind === "offer") {
      this.offers.set(msg.doc, {
        from: msg.from,
        fromName: msg.from_name,
        name: safeName(msg.body.name),
        lang: msg.body.lang,
      });
      // A file we asked for by clicking it in a shared tree: open it without a
      // second prompt.
      if (this.autoAccept.has(msg.from)) this.accept(msg.doc);
      this.onOffer?.(msg.doc);
      return;
    }
    if (msg.body.kind === "snapshot") {
      const offer = this.offers.get(msg.doc);
      // A snapshot we did not ask for is either a stale frame or a peer
      // probing; either way there is no offer, so there is nothing to open.
      if (!offer || offer.from !== msg.from) return;
      this.offers.delete(msg.doc);
      // Deliberately NOT a file: URI. A collab model has no path, cannot be
      // matched to one by `modelFor`, and has nowhere to be saved to.
      const uri = monaco.Uri.parse(`canopy-collab:/${msg.doc}/${encodeURIComponent(offer.name)}`);
      const model =
        monaco.editor.getModel(uri) ??
        monaco.editor.createModel(msg.body.text, offer.lang ?? undefined, uri);
      const s = new GuestSession(msg.doc, model, this.wire, msg.from, msg.body.rev);
      s.onNotice = (t) => this.onNotice?.(t);
      this.sessions.set(msg.doc, s);
      this.guests.set(msg.doc, { name: offer.name, ownerName: msg.from_name });
      this.onChange?.();
      this.onOffer?.(msg.doc);
      return;
    }
    // Anything else for a document we don't know about is dropped on the
    // floor. This one line is why a peer cannot address a file we never shared.
  }

  /** A member vanished: clear their caret everywhere. */
  dropMember(id: string) {
    for (const s of this.sessions.values()) {
      s.dropPeer(id);
      s.paint();
    }
  }

  /** Guest sessions currently open, for whoever renders their tabs. */
  liveGuests(): ReadonlyMap<string, { name: string; ownerName: string }> {
    return this.guests;
  }

  close(doc: string) {
    const s = this.sessions.get(doc);
    if (!s) return;
    s.dispose();
    this.sessions.delete(doc);
    this.guests.delete(doc);
    this.onChange?.();
  }

  /** The relay went away. Every session is over; guests keep their buffer as a
   *  local scratch copy, owners just stop broadcasting. */
  reset() {
    for (const [doc, s] of this.sessions) {
      if (s instanceof GuestSession) {
        s.orphaned = true;
        s.onOrphaned?.();
      }
      s.dispose();
      this.sessions.delete(doc);
      this.guests.delete(doc);
    }
    this.offers.clear();
    this.ownedProjects.clear();
    this.projectOffers.clear();
    this.joinedProjects.clear();
    this.autoAccept.clear();
  }
}
