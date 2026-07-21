// The pure half of collaborative editing: the operation type, the transform,
// and the small helpers that have no business knowing about an editor. Split
// out of collab.ts precisely because it can then be exercised without Monaco
// (or a DOM, or a relay) — a wrong transform diverges two buffers silently, so
// this is the one part of the feature that has to be fuzzed rather than
// eyeballed. See scripts/collab-fuzz.mjs.
//
// Reasoning for OT over a CRDT at all is in docs/collab-editing.md §2.

export type Op =
  | { op: "retain"; n: number }
  | { op: "insert"; s: string }
  | { op: "delete"; n: number };

/// The transform below is a port of ot.js's, which works on a compact
/// encoding: a positive number retains, a negative number deletes, a string
/// inserts. Keeping that encoding for the algorithm and converting only at the
/// wire boundary is deliberate — a literal port of a well-worn algorithm is
/// worth more than a prettier one I'd have to re-derive and might get subtly
/// wrong. Divergence from a wrong transform is silent; see the hash check.
type Prim = number | string;

function toPrims(ops: Op[]): Prim[] {
  return ops.map((o) => (o.op === "retain" ? o.n : o.op === "delete" ? -o.n : o.s));
}

function fromPrims(prims: Prim[]): Op[] {
  return prims.map((p) =>
    typeof p === "string"
      ? ({ op: "insert", s: p } as Op)
      : p > 0
        ? ({ op: "retain", n: p } as Op)
        : ({ op: "delete", n: -p } as Op),
  );
}

/** Accumulates primitives, merging runs and keeping insert-before-delete so
 *  that equal operations have one representation. delete(3),insert("x") and
 *  insert("x"),delete(3) mean the same thing; picking one keeps the transform's
 *  tie-breaks stable. */
class Builder {
  readonly out: Prim[] = [];
  base = 0;
  target = 0;

  retain(n: number) {
    if (n <= 0) return this;
    this.base += n;
    this.target += n;
    const last = this.out[this.out.length - 1];
    if (typeof last === "number" && last > 0) this.out[this.out.length - 1] = last + n;
    else this.out.push(n);
    return this;
  }

  delete(n: number) {
    if (n <= 0) return this;
    this.base += n;
    const last = this.out[this.out.length - 1];
    if (typeof last === "number" && last < 0) this.out[this.out.length - 1] = last - n;
    else this.out.push(-n);
    return this;
  }

  insert(s: string) {
    if (!s) return this;
    this.target += s.length;
    const n = this.out.length;
    const last = this.out[n - 1];
    if (typeof last === "string") {
      this.out[n - 1] = last + s;
    } else if (typeof last === "number" && last < 0) {
      const before = this.out[n - 2];
      if (typeof before === "string") this.out[n - 2] = before + s;
      else {
        this.out[n - 1] = s;
        this.out.push(last);
      }
    } else {
      this.out.push(s);
    }
    return this;
  }

  ops(): Op[] {
    return fromPrims(this.out);
  }
}

/** How long a document must be for these ops to apply to it. */
export function baseLength(ops: Op[]): number {
  let n = 0;
  for (const o of ops) if (o.op !== "insert") n += o.n;
  return n;
}

/** How long the document is afterwards. */
export function targetLength(ops: Op[]): number {
  let n = 0;
  for (const o of ops) {
    if (o.op === "retain") n += o.n;
    else if (o.op === "insert") n += o.s.length;
  }
  return n;
}

/** Reference application, used for the owner's authoritative copy and by the
 *  tests. Throws on a length mismatch rather than limping on — a mismatch is
 *  already corruption, and a loud failure resyncs instead of diverging. */
export function apply(doc: string, ops: Op[]): string {
  if (baseLength(ops) !== doc.length) {
    throw new Error(`collab: ops expect a ${baseLength(ops)}-char doc, got ${doc.length}`);
  }
  let i = 0;
  let out = "";
  for (const o of ops) {
    if (o.op === "retain") {
      out += doc.slice(i, i + o.n);
      i += o.n;
    } else if (o.op === "insert") {
      out += o.s;
    } else {
      i += o.n;
    }
  }
  return out;
}

/** Given `a` and `b` composed against the same document, return `[a', b']`
 *  such that apply(apply(d, a), b') === apply(apply(d, b), a'). `a` wins ties
 *  on concurrent inserts at the same offset, so both sides must agree on which
 *  argument is which: ours first, theirs second. */
export function transform(a: Op[], b: Op[]): [Op[], Op[]] {
  if (baseLength(a) !== baseLength(b)) {
    throw new Error("collab: transform needs two ops against the same document");
  }
  const pa = toPrims(a);
  const pb = toPrims(b);
  const outA = new Builder();
  const outB = new Builder();
  let i = 0;
  let j = 0;
  let opA: Prim | undefined = pa[i++];
  let opB: Prim | undefined = pb[j++];
  for (;;) {
    if (opA === undefined && opB === undefined) break;
    // An insert on either side is uncontested: it survives in its own prime
    // operation and is retained over in the other.
    if (typeof opA === "string") {
      outA.insert(opA);
      outB.retain(opA.length);
      opA = pa[i++];
      continue;
    }
    if (typeof opB === "string") {
      outA.retain(opB.length);
      outB.insert(opB);
      opB = pb[j++];
      continue;
    }
    if (opA === undefined) throw new Error("collab: transform ran off the end of a");
    if (opB === undefined) throw new Error("collab: transform ran off the end of b");
    let take: number;
    if (opA > 0 && opB > 0) {
      if (opA > opB) {
        take = opB;
        opA = opA - opB;
        opB = pb[j++];
      } else if (opA < opB) {
        take = opA;
        opB = opB - opA;
        opA = pa[i++];
      } else {
        take = opA;
        opA = pa[i++];
        opB = pb[j++];
      }
      outA.retain(take);
      outB.retain(take);
    } else if (opA < 0 && opB < 0) {
      // Both deleted the same span. Neither prime operation has to do
      // anything — the characters are already gone in the other's result.
      if (-opA > -opB) {
        opA = opA - opB;
        opB = pb[j++];
      } else if (-opA < -opB) {
        opB = opB - opA;
        opA = pa[i++];
      } else {
        opA = pa[i++];
        opB = pb[j++];
      }
    } else if (opA < 0 && opB > 0) {
      if (-opA > opB) {
        take = opB;
        opA = opA + opB;
        opB = pb[j++];
      } else if (-opA < opB) {
        take = -opA;
        opB = opB + opA;
        opA = pa[i++];
      } else {
        take = opB;
        opA = pa[i++];
        opB = pb[j++];
      }
      outA.delete(take);
    } else {
      if (opA > -opB) {
        take = -opB;
        opA = opA + opB;
        opB = pb[j++];
      } else if (opA < -opB) {
        take = opA;
        opB = opB + opA;
        opA = pa[i++];
      } else {
        take = opA;
        opA = pa[i++];
        opB = pb[j++];
      }
      outB.delete(take);
    }
  }
  return [outA.ops(), outB.ops()];
}

/** Where an offset ends up after `ops` are applied — used to keep a remote
 *  cursor on the word it was on rather than letting it drift. */
export function transformOffset(offset: number, ops: Op[]): number {
  let index = offset;
  let moved = offset;
  for (const o of ops) {
    if (o.op === "retain") {
      index -= o.n;
    } else if (o.op === "insert") {
      moved += o.s.length;
    } else {
      moved -= Math.min(index, o.n);
      index -= o.n;
    }
    if (index < 0) break;
  }
  return moved;
}

/** FNV-1a over the document, as a divergence tripwire — not security (a
 *  hostile peer sends whatever hash it likes; only the owner's copy counts).
 *  Cheap enough that the every-16-revisions decimation is about respecting the
 *  main thread on a large file, not about the hash itself. */
export function docHash(doc: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < doc.length; i++) {
    h ^= doc.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Monaco reports a batch of changes with offsets all relative to the
 *  pre-edit document, ordered from the end backwards. Sorting ascending and
 *  walking once turns the batch into one operation over the whole document. */
export function opsFromChanges(
  docLength: number,
  changes: readonly { rangeOffset: number; rangeLength: number; text: string }[],
): Op[] {
  const sorted = [...changes].sort((x, y) => x.rangeOffset - y.rangeOffset);
  const b = new Builder();
  let at = 0;
  for (const c of sorted) {
    if (c.rangeOffset < at) throw new Error("collab: overlapping changes in one edit");
    b.retain(c.rangeOffset - at);
    b.delete(c.rangeLength);
    b.insert(c.text);
    at = c.rangeOffset + c.rangeLength;
  }
  b.retain(docLength - at);
  return b.ops();
}
/** Golden-angle hue per peer: any two peers land far apart without a palette
 *  that can run out. */
export function peerColour(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${(h * 137.508) % 360}deg 65% 60%)`;
}
/** Everything a peer can put in `offer.name` is attacker-controlled, so it is
 *  reduced to a basename here and used only as a tab label and a language hint.
 *  This is belt-and-braces: a name can't become a path because nothing on the
 *  receiving side ever opens one (COLLAB-1). */
export function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[ -]/g, "").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned.slice(0, 120) : "shared";
}
/** 128 bits from the platform CSPRNG. A document id must be unguessable for
 *  the same reason a file-offer token is: the allow-list is the real control,
 *  but an id nobody can name is one fewer thing to get right. */
export function newDocId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
