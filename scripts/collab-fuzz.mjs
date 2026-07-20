// Randomised check of the collaborative-editing transform. Run with
//   node scripts/collab-fuzz.mjs [iterations]
//
// This exists because a wrong transform does not throw — it produces two
// buffers that quietly disagree, and the user finds out when they save. The
// convergence property (TP1) is the one thing the whole feature rests on, so
// it gets checked against random operations rather than against three
// hand-written cases that all happen to be inserts.
//
// It also drives the full owner/guest exchange with reordered delivery, which
// is where a state-machine mistake shows up that a pure transform test can't.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "collab-ot.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);
const { apply, transform, transformOffset, baseLength, targetLength } = mod;

let seed = Number(process.argv[3] ?? 12345) >>> 0;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (n) => Math.floor(rnd() * n);
const LETTERS = "abcdefghij\n";

/** A random operation over a document of `len` characters. */
function randomOps(len) {
  const ops = [];
  const push = (o) => {
    const last = ops[ops.length - 1];
    if (o.op === "retain" && last?.op === "retain") last.n += o.n;
    else if (o.op === "delete" && last?.op === "delete") last.n += o.n;
    else if (o.op === "insert" && last?.op === "insert") last.s += o.s;
    else ops.push(o);
  };
  let at = 0;
  while (at < len) {
    const room = len - at;
    const take = 1 + pick(Math.min(room, 6));
    const roll = rnd();
    if (roll < 0.45) {
      push({ op: "retain", n: take });
      at += take;
    } else if (roll < 0.75) {
      push({ op: "delete", n: take });
      at += take;
    } else {
      let s = "";
      for (let i = 0; i < 1 + pick(4); i++) s += LETTERS[pick(LETTERS.length)];
      push({ op: "insert", s });
    }
  }
  if (rnd() < 0.3) {
    let s = "";
    for (let i = 0; i < 1 + pick(4); i++) s += LETTERS[pick(LETTERS.length)];
    push({ op: "insert", s });
  }
  return ops;
}

function randomDoc() {
  let s = "";
  for (let i = 0; i < 1 + pick(40); i++) s += LETTERS[pick(LETTERS.length)];
  return s;
}

let fails = 0;
const iterations = Number(process.argv[2] ?? 20000);

// --- Property 1: TP1 convergence -------------------------------------------
for (let i = 0; i < iterations; i++) {
  const doc = randomDoc();
  const a = randomOps(doc.length);
  const b = randomOps(doc.length);
  try {
    const [a1, b1] = transform(a, b);
    const left = apply(apply(doc, a), b1);
    const right = apply(apply(doc, b), a1);
    if (left !== right) {
      fails++;
      if (fails < 4) {
        console.error("TP1 FAILED");
        console.error("  doc  ", JSON.stringify(doc));
        console.error("  a    ", JSON.stringify(a));
        console.error("  b    ", JSON.stringify(b));
        console.error("  a∘b' ", JSON.stringify(left));
        console.error("  b∘a' ", JSON.stringify(right));
      }
    }
    if (baseLength(a1) !== targetLength(b) || baseLength(b1) !== targetLength(a)) {
      fails++;
      console.error("prime operation has the wrong base length");
    }
  } catch (err) {
    fails++;
    if (fails < 4) console.error("threw:", String(err), JSON.stringify({ doc, a, b }));
  }
}
console.log(`TP1 convergence: ${iterations} random pairs, ${fails} failures`);

// --- Property 2: cursors stay inside the document ---------------------------
let cursorFails = 0;
for (let i = 0; i < 5000; i++) {
  const doc = randomDoc();
  const ops = randomOps(doc.length);
  const after = apply(doc, ops);
  const at = pick(doc.length + 1);
  const moved = transformOffset(at, ops);
  if (moved < 0 || moved > after.length) {
    cursorFails++;
    if (cursorFails < 4) {
      console.error("cursor left the document:", at, "->", moved, "len", after.length);
    }
  }
}
console.log(`cursor transform: 5000 cases, ${cursorFails} out of range`);

// --- Property 3: the owner/guest exchange converges under reordering --------
// A miniature of the real thing: one owner, two guests, edits interleaved and
// guest->owner delivery deliberately delayed, which is exactly the case the
// pending-queue transform in GuestSession exists for.
class Owner {
  constructor() {
    this.doc = randomDoc();
    this.rev = 0;
    this.history = [];
    this.out = [];
  }
  local(ops) {
    this.doc = apply(this.doc, ops);
    this.rev++;
    this.history.push(ops);
    this.out.push({ rev: this.rev, ops, author: "owner" });
  }
  fromGuest(base, ops, author) {
    let theirs = ops;
    for (let r = base; r < this.rev; r++) [, theirs] = transform(this.history[r], theirs);
    this.doc = apply(this.doc, theirs);
    this.rev++;
    this.history.push(theirs);
    this.out.push({ rev: this.rev, ops: theirs, author });
  }
}

class Guest {
  constructor(id, doc, rev) {
    this.id = id;
    this.doc = doc;
    this.rev = rev;
    this.outstanding = null;
    this.queued = [];
    this.sent = [];
  }
  local(ops) {
    this.doc = apply(this.doc, ops);
    this.queued.push(ops);
    this.flush();
  }
  flush() {
    if (this.outstanding || this.queued.length === 0) return;
    this.outstanding = this.queued.shift();
    this.sent.push({ base: this.rev, ops: this.outstanding, author: this.id });
  }
  receive(m) {
    if (m.rev !== this.rev + 1) throw new Error(`gap at ${this.id}: ${this.rev} -> ${m.rev}`);
    if (m.author === this.id) {
      this.rev = m.rev;
      this.outstanding = null;
      this.flush();
      return;
    }
    let theirs = m.ops;
    if (this.outstanding) [theirs, this.outstanding] = transform(theirs, this.outstanding);
    for (let i = 0; i < this.queued.length; i++) {
      [theirs, this.queued[i]] = transform(theirs, this.queued[i]);
    }
    this.doc = apply(this.doc, theirs);
    this.rev = m.rev;
  }
}

let sessionFails = 0;
for (let round = 0; round < 2000; round++) {
  const owner = new Owner();
  const guests = [new Guest("g1", owner.doc, 0), new Guest("g2", owner.doc, 0)];
  const inflight = [];
  const delivered = [0, 0];
  for (let step = 0; step < 30; step++) {
    const who = pick(3);
    if (who === 0) {
      owner.local(randomOps(owner.doc.length));
    } else {
      const g = guests[who - 1];
      g.local(randomOps(g.doc.length));
      // Guest -> owner is delayed by a random number of steps, so the owner
      // sequences other traffic in between and has to transform it forward.
      while (g.sent.length) inflight.push(g.sent.shift());
    }
    // Deliver a random prefix of the guest traffic to the owner.
    while (inflight.length && rnd() < 0.6) {
      const m = inflight.shift();
      owner.fromGuest(m.base, m.ops, m.author);
      const g = guests.find((x) => x.id === m.author);
      while (g.sent.length) inflight.push(g.sent.shift());
    }
    // The owner's broadcast is ordered and lossless (TCP through the star).
    for (let i = 0; i < guests.length; i++) {
      while (delivered[i] < owner.out.length) {
        guests[i].receive(owner.out[delivered[i]++]);
        while (guests[i].sent.length) inflight.push(guests[i].sent.shift());
      }
    }
  }
  // Drain everything still in flight, then flush the broadcast to both guests.
  while (inflight.length) {
    const m = inflight.shift();
    owner.fromGuest(m.base, m.ops, m.author);
    const g = guests.find((x) => x.id === m.author);
    while (g.sent.length) inflight.push(g.sent.shift());
    for (let i = 0; i < guests.length; i++) {
      while (delivered[i] < owner.out.length) {
        guests[i].receive(owner.out[delivered[i]++]);
        while (guests[i].sent.length) inflight.push(guests[i].sent.shift());
      }
    }
  }
  for (const g of guests) {
    if (g.doc !== owner.doc || g.outstanding || g.queued.length) {
      sessionFails++;
      if (sessionFails < 3) {
        console.error(`round ${round}: ${g.id} diverged`);
        console.error("  owner", JSON.stringify(owner.doc));
        console.error("  guest", JSON.stringify(g.doc));
      }
      break;
    }
  }
}
console.log(`owner/guest sessions: 2000 rounds, ${sessionFails} divergent`);

const total = fails + cursorFails + sessionFails;
console.log(total === 0 ? "\nall properties held" : `\n${total} FAILURES`);
process.exit(total === 0 ? 0 : 1);
