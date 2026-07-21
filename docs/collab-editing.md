# Collaborative editing over the team relay

Live shared editing of a file between Canopys, riding the existing team relay.
No server, no new sockets, no new crypto: new `Frame` variants routed through
the paths chat and commands already use.

This document is the design. `src/collab.ts` and the `Frame::Collab` arm in
`src-tauri/src/relay.rs` are the v1 implementation of the slice it describes.

---

## 1. The shape of the problem, and why it is not the usual one

The literature on collaborative text assumes peers that are symmetric and a
network that is not a tree. Canopy's relay is neither.

Two facts about this codebase decide the whole design before any algorithm is
chosen:

**The topology already has a hub.** The host is a star centre. Clients never
talk to each other; `route` (host-side fan-out) and `deliver` (our own frames)
push everything through the host. There is no partition case where two halves of the mesh have to merge
after healing — if the hub is gone, there is no session.

**The file has an owner, and only the owner can persist it.** A shared file is
an absolute path on exactly one machine's disk. Nobody else can save it, ever
(§5 explains why this is a security invariant, not a limitation). So one peer is
*necessarily* the authority for the document's content, because it is the only
peer whose copy can become a fact on disk.

That second fact is the load-bearing one. The hard problem CRDTs solve —
convergence with no authority — is a problem this feature does not have. It has
an authority by construction.

---

## 2. CRDT vs OT

### The recommendation: operational transformation, owner-sequenced (Jupiter), implemented in TypeScript, zero new dependencies.

The document's owner is the sequencer. Every edit any peer makes is sent to the
owner, applied in arrival order, assigned a monotonic revision, and broadcast.
Each peer keeps a queue of its own operations that the owner has not yet
acknowledged, and transforms incoming owner operations against that queue
(and vice versa). This is the Jupiter model — Google Wave's, ShareDB's,
Firepad's.

### Why not a CRDT

Not "CRDTs are bad." Three specific reasons, in descending order of how much
they actually mattered.

**(a) It buys a property we cannot use.** A CRDT's value is that any two
replicas that have seen the same set of operations agree, in any order, with no
coordinator. We have a coordinator we are *forced* to have. Paying for
decentralised convergence and then routing everything through one peer anyway
is paying for the hard half and using the easy half.

**(b) A CRDT is a document format, not a library call.** Adopting `yrs` means
the buffer's truth is a `Y.Text`, and the Monaco model becomes a projection of
it. That is a second document representation living next to Monaco's rope, kept
in sync with observers, in a codebase whose editor story is deliberately "one
model, swapped into one editor instance". And the CRDT would live in Rust while
the model lives in TypeScript, so every keystroke crosses the IPC boundary twice
and the rope exists in duplicate. The IPC round-trip per keystroke is the part
that would actually be felt.

**(c) Dependency weight.** Real numbers, measured on this machine
(rustc 1.92.0, aarch64-apple-darwin) rather than estimated:

| Crate | Unique crates in `cargo tree` | Release binary delta | Notes |
|---|---|---|---|
| *(baseline hello-world)* | 1 | — | 286,176 B |
| `diamond-types` 1.0 | 40 | **+33 KB** | pulls `rand` 0.8, `toml_edit`, `syn` 1.x, two `str_indices` majors |
| `yrs` 0.23 | 40 | **+146 KB** | pulls `dashmap`, `async-lock`, `async-trait`, `arc-swap` |
| `automerge` 0.10 | 46 | **+389 KB** | pulls `flate2`, `tracing`, and `sha2` **0.11** alongside our `sha2` 0.10 |

Measured with `opt-level="s"`, fat LTO, `codegen-units=1`, `panic="abort"`,
stripped. **These are lower bounds and should be read as such** — the probe
binary touches one insert and one read, so LTO strips most of each crate. A
real integration also uses the update encoder/decoder, the observer machinery,
and (for yrs) awareness; expect meaningfully more.

Two findings that don't fit in the table:

- **None of the three pulls tokio.** The strongly-preferred no-tokio option is
  available from all of them. That objection, which was the one I expected to
  be decisive, is not.
- **`yrs` 0.27.3 does not compile on rustc 1.92** (`if let` guards are
  experimental — `yrs-0.27.3/src/block.rs:1019`), let alone this crate's
  declared MSRV of 1.77.2. Pinning to 0.23 works. A dependency whose current
  release is ahead of your toolchain is a maintenance tax that recurs.
- `automerge` bringing `sha2` 0.11 next to our `sha2` 0.10 means two hash
  implementations compiled into a binary that already ships one, in a crypto
  path we deliberately kept minimal.

The honest weighting: (a) and (b) decide this. (c) confirms it. If the topology
were a real mesh, +146 KB and 40 crates would be worth paying and this document
would recommend `yrs`.

### What OT costs — stated plainly

**OT is only tractable because of the star.** The reputation OT has for being
unimplementable comes from n-way transform: peer-to-peer OT needs a transform
function correct against every other peer's concurrent history, and the
published algorithms for it have a track record of being wrong. What we need is
one-dimensional — client's pending queue against the owner's authoritative
stream — over exactly two operation types (insert, delete) on plain text. That
is roughly 150 lines and is exhaustively testable against a random-op fuzzer.

**The real risk is silent divergence.** A wrong transform does not throw; it
produces two buffers that disagree and stay disagreeing, and the user finds out
when they save. A CRDT's correctness lives in a crate that thousands of
people fuzz; ours lives in our repo.

This is not hypothetical. The first version of `GuestSession.receive` passed
the local pending operation to `transform` as the first argument while
`OwnerSession.receive` passed the owner's history first. `transform` breaks a
tie between two inserts at the same offset in favour of its first argument, so
the two sides silently disagreed about the order of concurrent inserts at the
same position — and only that. Every hand-written two-peer test passed.
`scripts/collab-fuzz.mjs` failed 709 of 2000 randomised sessions and named the
exact characters. **Anyone changing the transform or either state machine
should run the fuzzer, and should not trust a passing manual test.**

Mitigation, and it is not optional: **every owner broadcast carries a hash of
the owner's full document at that revision.** A peer that applies an operation
and computes a different hash has diverged, says so, and requests a fresh
snapshot. That converts the failure mode from "silent corruption discovered at
save time" into "a visible flicker and a resync". Divergence becomes a bug
report rather than a data-loss incident. Anyone changing `transform()` should
assume they have broken it and rely on this net.

---

## 3. Wire protocol

One new `Frame` variant, following `Chat`/`Command` so it inherits the existing
`from` re-stamping and the per-peer `Arc<Mutex<Sender>>` that keeps the AEAD
counter nonce serialised.

It deviates from them in one place, deliberately. `route` and `deliver` write
sockets with the global relay mutex held, which costs nothing for a chat
message. Collab is a frame per keystroke per open editor, so the same shape
would park the one lock the whole app shares behind the slowest peer's TCP
window. `collab_targets` is therefore pure and runs under the lock; the writes
happen after it is dropped.

```rust
Collab(CollabMsg)
```

```rust
pub struct CollabMsg {
    pub id: String,
    pub from: String,        // re-stamped by the host; never trusted from the wire
    pub from_name: String,   // likewise
    pub to: Option<String>,  // None = the doc's whole roster, Some(id) = one peer
    /// The document this concerns. Opaque, 128-bit, CSPRNG, minted by the owner.
    pub doc: String,
    pub body: CollabBody,
    pub ts: u64,
}
```

`CollabBody` is `#[serde(tag = "kind", rename_all = "kebab-case")]`:

| Variant | Direction | Payload | Meaning |
|---|---|---|---|
| `offer` | owner → peer | `name: String`, `lang: Option<String>`, `size: u64` | "I am sharing a file live. Want in?" `name` is a **basename for display only**. |
| `open` | peer → owner | *(none)* | "Yes." Rejected unless the sender is on that doc's allow-list. |
| `snapshot` | owner → peer | `rev: u64`, `text: String`, `hash: String`, `roster: Vec<DocPeer>` | Full state. Sent on `open` and on any resync. |
| `ops` | both | `rev: u64`, `ops: Vec<Op>`, `author: String`, `hash: Option<String>` | The edit stream. See below. |
| `cursor` | both | `anchor: u32`, `head: u32`, `rev: u64` | Presence. Unsequenced, droppable. |
| `resync` | peer → owner | `reason: String` | "My hash disagrees / I fell behind. Send me a snapshot." |
| `close` | either | `reason: String` | Owner unshares, or a peer leaves the doc. |

`Op` is the minimal text-operation pair, offsets in UTF-16 code units to match
Monaco's coordinate space without a conversion layer:

```rust
enum Op {
    Retain { n: u32 },
    Insert { s: String },
    Delete { n: u32 },
}
```

Semantics of `rev` on `ops`, which is the only subtle field:

- **peer → owner**: `rev` is the last owner revision the peer had applied when
  it composed these ops. The owner transforms them against everything it has
  sequenced since `rev`, applies the result, and broadcasts at `rev + 1`.
- **owner → all**: `rev` is the new authoritative revision and `author` is the
  member whose operation it is. Recipients apply in strict `rev` order; a gap
  means a dropped frame, which triggers `resync`. `author` is what lets a peer
  recognise its own operation coming back: the star never echoes a frame to its
  sender, so the acknowledgement arrives re-stamped as the *owner's* broadcast
  and would otherwise be indistinguishable from someone else's edit.

`hash` is present on owner broadcasts only, and only every N revisions
(N = 16 in v1) — hashing a large buffer per keystroke is the kind of
per-item cost the detail-view performance work exists to avoid.

### Limits, enforced on receipt

`secure::MAX_FRAME` already caps a frame at 2 MB, which bounds `snapshot.text`
and any `ops` batch for free. On top of that, v1 refuses to *share* a file over
1 MB or 20,000 lines and caps a peer at 8 concurrently open docs. These are not
security boundaries (the frame cap is); they are there so a shared minified
bundle doesn't make the app unusable.

---

## 4. Session lifecycle

**Sharing.** The owner picks *Share live* on an open editor tab. Locally, and
only locally, Canopy mints `doc = 128 random bits from the OS CSPRNG` and
records `doc → { absolute path, allow-list }` in an in-memory table. It then
sends `offer` to the chosen member (or the whole relay). The path is not in the
offer and never goes on the wire.

**Opening.** The recipient sees the offer in the Team panel's *For you* list —
the same inbox `file-offer` and `open-pr` use. Accepting sends `open`. The owner
checks the sender against that doc's allow-list, adds them to the roster, and
replies with `snapshot`. The peer creates a **detached Monaco model** — one
whose URI is `canopy-collab:/<doc>/<sanitised basename>`, deliberately *not* a
`file:` URI, so it cannot collide with or be mistaken for a local file model —
and opens it as a tab. Editing is live from that moment.

**Joining mid-edit.** Falls out of the snapshot mechanism at no extra cost: the
owner serialises `snapshot` under the same lock that assigns revisions, so the
snapshot is exactly the state at `rev`, and every subsequent broadcast the
newcomer receives is `> rev`. There is no catch-up window and no operation
buffering on the joining side.

**Leaving.** A peer sends `close`; the owner drops it from the roster and
broadcasts a roster update so its cursor disappears. The peer's model is
disposed and its tab closed.

---

## 5. Trust boundary

This is the part of the feature that can go badly wrong, so it is stated as an
invariant rather than a set of checks.

### The threat

A peer on the relay is a person who typed a 7-digit code. The existing model
calls this "a same-team convenience on a network you already share". Chat and a
PR link are inert. A file offer is already stronger — but it is *pull-based and
user-directed*: the receiver chooses whether to accept and picks the
destination path from a native save dialog, so the sender never names a
location on the receiver's disk.

Live editing is the first feature where a remote peer's bytes flow continuously
into a buffer that corresponds to a real path. The obvious ways to build it are
all wrong:

- If the offer carried a path, a peer could offer `~/.ssh/authorized_keys` or
  `../../../etc/hosts` and let you "open" it.
- If ops named a path, a peer could send ops for a file you never shared.
- If the receiving side wrote through to disk, a peer could modify your working
  tree while you were looking at a different tab — and a `git commit -a` later
  would launder it into your history.
- Path validation alone (`is workspace root a prefix?`) is the weak version of
  this. It is a check, and checks get bypassed by symlinks, by `..` segments
  normalised in the wrong order, by a second caller added later that forgets to
  call the validator.

### The invariant

> **COLLAB-1 — A filesystem path never crosses the wire, and no frame received
> from a peer can reach a filesystem write.**
>
> A document is addressed on the wire only by `doc`, a 128-bit CSPRNG token
> minted by the owner. The mapping `doc → absolute path` exists in exactly one
> process — the owner's — in one in-memory table, and an entry is created only
> by an explicit local user action on an already-open editor tab. On every other
> peer, `doc` maps to a detached Monaco model with a `canopy-collab:` URI and no
> path at all. Persistence of a shared document happens only when the **owner**
> presses save.

This is structural, not a check. Ask the questions:

- *Can a peer edit a file I never shared?* No. It can only name a `doc`. Docs
  that exist are ones I created by picking a tab. An op for an unknown `doc` is
  dropped at the top of the handler.
- *Can a peer write outside the workspace?* The question does not typecheck. A
  peer cannot express a path. `offer.name` is passed through a sanitiser that
  strips everything up to the last separator and is used only as a tab label
  and for syntax highlighting.
- *Can a peer cause any write at all?* No. There is no `fs::write` reachable
  from the collab handler. On the owner's side a save is `Cmd-S` in the owner's
  own window, exactly as it was before. On every other side the model is
  detached; there is nowhere to write it. This is greppable and should stay so.
- *Can a peer join a doc it wasn't offered?* No, twice over: the owner checks
  `open` against that doc's allow-list, and `doc` is unguessable anyway. The
  allow-list is the real control; the entropy is defence in depth for the same
  reason `relay_offer_file`'s token is CSPRNG.
- *Can a peer speak as someone else?* No — the host re-stamps `from` from the
  connection identity before routing, which is what makes the existing chat
  attribution meaningful, and `Collab` goes through that same code.

### What this does *not* protect against, stated honestly

**The host can forge and suppress.** The host is the hub; it decrypts and
re-encrypts every relayed frame. It can drop your ops, reorder them (harmless —
the owner defines order), or fabricate ops attributed to you. This is already
true of chat and of `open-pr` today; live editing does not make it worse, but it
does make it more consequential, because forged ops land in a buffer the owner
may then save. Fixing it means end-to-end signing each op batch with the
existing Ed25519 identity key, which the `identity` module already has
everything for. It is out of scope for v1 and is the first thing to add in v2.

**A peer you invited can write garbage into the file you shared.** That is what
sharing is. The mitigation is social plus `Cmd-Z` plus the fact that you have to
press save. Do not share a file with someone you would not let type on your
keyboard.

**Divergence is not a security property.** The hash check catches bugs, not
attackers — a hostile peer computes whatever hash it likes. Only the owner's
copy matters, and only the owner's hash is authoritative.

---

## 6. Conflict and disconnect semantics

**Two peers edit the same line.** Owner arrival order wins. Each peer's
in-flight ops are transformed against the owner's stream, so both converge to
the same text; what they lose is intent, in the classic way (two people typing
at the same offset interleave rather than one winning). Cursors are adjusted
through the same transform so a remote cursor does not drift off its word.

**A peer drops mid-edit.** Its unacknowledged ops were never applied by the
owner, so there is nothing to roll back — this is a real benefit of the
owner-sequenced model over a CRDT, where a partially-merged peer's state has to
be reasoned about. The owner notices via the existing dead-peer sweep
(`PING_EVERY`, 30 s) or the read failure, removes it from every doc roster it
was on, and broadcasts the update; its cursor disappears.

**The owner drops.** The document is over. Every other peer's tab flips to a
banner: *the owner left; this copy is local only — Save As to keep it.* The
model stays open and editable so nobody loses work in progress, but it is
explicitly a scratch buffer.

There is deliberately **no leader election**. Electing a new owner would mean
electing a new *path*, on a different machine, for a file that peer may not
even have a checkout of. The file lives on the owner's disk; when the owner
leaves, the file leaves. This falls directly out of COLLAB-1 and is the correct
behaviour, not a shortcut.

**The host drops, and the host is not the owner.** The whole relay dies, so
every peer including the owner sees "owner gone" for every doc. `stop_client`
already handles the transport side; collab state is torn down from the same
`relay:state` transition to `role: "off"`.

**A frame is lost.** It can't be, per-link — TCP, and a broken link drops the
peer entirely. But a peer that is slow enough to be shut down mid-fan-out, or
any future non-TCP path, shows up as a `rev` gap, which triggers `resync`.
The gap check is cheap and worth keeping regardless.

**The file changes on disk under the owner.** v1 suspends the external-change
watcher's auto-reload for a shared file and shows the existing "changed on disk"
diff only when sharing stops. Reconciling a live OT stream with a
whole-file replacement from `git checkout` is genuinely hard and is not
attempted.

---

## 7. Presence

Remote cursors and selections are Monaco decorations, not a second rendering
layer:

- One `deltaDecorations` set per remote peer, replaced on each `cursor` frame.
- A zero-width selection renders as a 2px `::before` border on the character
  (`.collab-cursor`), a non-empty one as a translucent background
  (`.collab-selection`). The peer's name rides in an `after` content attachment
  on the cursor, so it appears inline rather than as an overlay widget — overlay
  widgets need layout coordinates and re-measurement on every scroll.
- Colour is `hsl(hash(peerId) * 137.5°, 65%, 60%)` — golden-angle spacing, so
  any two peers are far apart in hue without a palette to run out of.
- `cursor` frames are throttled to 20/s and dropped rather than queued. They
  carry `rev` so a receiver can transform a cursor that was composed against an
  older revision instead of showing it in the wrong place.

Cursor frames are the only unsequenced traffic in the protocol. Losing one is
invisible; the next one is 50 ms away.

---

## 8. Deliberately out of scope for v1

- **More than one file per share.** The plumbing is per-`doc` and takes many,
  but the UI is one tab and the tested path is one file.
- **Anything that isn't plain text.** Notebooks, sheets, images, PDFs — the
  viewers in `viewers.tsx` are read-only projections and have no operation model.
- **Mixed line endings.** The offsets on the wire are Monaco model offsets, and
  a model normalises EOL. An owner on CRLF and a guest whose model resolves to
  LF would disagree about every offset after the first newline. The hash check
  turns this into a resync loop rather than corruption, but it is not handled
  and it is the most likely thing to go wrong in real use.
- **Cross-peer undo.** Monaco's undo stack is local and knows nothing about
  transformation, so `Cmd-Z` on a shared buffer can undo *your* edit into a
  position that has since moved. This is a known wart. Correct multi-peer undo
  needs an undo manager that transforms the inverse op, and that is a v2 feature
  in its own right.
- **Saving by a non-owner.** Structurally excluded — see COLLAB-1.
- **End-to-end op signatures.** See §5. First item in v2.
- **Reconnect and resume.** A dropped peer rejoins with a fresh `open` and a
  fresh snapshot. There is no operation log to replay against, by design: the
  owner keeps only enough history to transform, not a durable log.
- **LSP, diagnostics and formatting on a `canopy-collab:` model.** The
  language client is wired to `file:` URIs against the local workspace; a
  detached model gets syntax highlighting only.
- **Git operations on a shared file** while it is shared.
- **Files over 1 MB.**

---

## 9. What v1 actually implements

A narrow vertical slice: one shared file, an owner and one peer, text
convergence and one remote cursor.

- `src-tauri/src/relay.rs` — `Frame::Collab`, `CollabMsg`/`CollabBody`/`CollabOp`,
  `collab_targets`, the host relay arm, the client reader arm, and the
  `relay_send_collab` command. Plus unit tests that parse the exact JSON the
  frontend emits, because a serde tag mismatch between the two definitions
  presents as "the feature does nothing" with no error anywhere.
- `src/collab-ot.ts` — the operation type, the transform, cursor transform, the
  document hash and the Monaco-change conversion. Deliberately free of any
  Monaco or relay import so it can be exercised head­less.
- `scripts/collab-fuzz.mjs` — TP1 convergence over random operation pairs,
  cursor bounds, and a full owner/two-guest exchange with reordered delivery.
- `src/collab.ts` — `OwnerSession`, `GuestSession`, `CollabManager`, the model
  binding and the cursor decorations.
- UI: `Share live` in the editor's pane actions, the invitation in the Team
  panel, and `CollabView` for a guest's tab.

The OT lives in TypeScript on purpose. Rust is pure transport for this feature
and gains no dependency. The alternative — document state in Rust — puts a
second rope next to Monaco's and an IPC round-trip on every keystroke, for
nothing.
