import { describe, expect, it } from "vitest";
import {
  apply,
  baseLength,
  docHash,
  newDocId,
  opsFromChanges,
  type Op,
  safeName,
  targetLength,
  transform,
  transformOffset,
} from "./collab-ot";

// The convergence property (TP1) is the one invariant the whole collab feature
// rests on: a wrong transform diverges two buffers silently. scripts/collab-fuzz.mjs
// runs this against many thousands of random ops for a nightly-style check;
// this suite pins a seeded, bounded run into CI plus targeted unit cases so a
// regression is caught on every PR, not just when someone remembers to fuzz.

// A tiny deterministic PRNG (LCG) so the randomized property is reproducible in
// CI — a failure prints the seed-derived state, never a flake.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const LETTERS = "abcdefghij\n";

/** A random, well-formed operation over a `len`-char document. */
function randomOps(len: number, rnd: () => number): Op[] {
  const ops: Op[] = [];
  const push = (o: Op) => {
    const last = ops[ops.length - 1];
    if (o.op === "retain" && last?.op === "retain") last.n += o.n;
    else if (o.op === "delete" && last?.op === "delete") last.n += o.n;
    else if (o.op === "insert" && last?.op === "insert") last.s += o.s;
    else ops.push(o);
  };
  let left = len;
  while (left > 0) {
    const take = 1 + Math.floor(rnd() * Math.min(left, 4));
    const roll = rnd();
    if (roll < 0.4) {
      push({ op: "retain", n: take });
      left -= take;
    } else if (roll < 0.7) {
      push({ op: "delete", n: take });
      left -= take;
    } else {
      const n = 1 + Math.floor(rnd() * 3);
      let s = "";
      for (let i = 0; i < n; i++) s += LETTERS[Math.floor(rnd() * LETTERS.length)];
      push({ op: "insert", s });
    }
  }
  // A trailing insert keeps some ops end with content rather than always retain.
  if (rnd() < 0.3) push({ op: "insert", s: LETTERS[Math.floor(rnd() * LETTERS.length)] });
  return ops;
}

function randomDoc(rnd: () => number): string {
  const n = Math.floor(rnd() * 20);
  let s = "";
  for (let i = 0; i < n; i++) s += LETTERS[Math.floor(rnd() * LETTERS.length)];
  return s;
}

describe("apply", () => {
  it("retains, inserts and deletes at the right offsets", () => {
    expect(apply("hello", [{ op: "retain", n: 5 }])).toBe("hello");
    expect(apply("hello", [{ op: "insert", s: "X" }, { op: "retain", n: 5 }])).toBe("Xhello");
    expect(
      apply("hello", [{ op: "retain", n: 2 }, { op: "delete", n: 2 }, { op: "retain", n: 1 }]),
    ).toBe("heo");
  });

  it("throws on a length mismatch rather than limping on", () => {
    expect(() => apply("hello", [{ op: "retain", n: 3 }])).toThrow(/expect a 3-char doc/);
  });
});

describe("baseLength / targetLength", () => {
  it("count pre- and post-edit document lengths", () => {
    const ops: Op[] = [{ op: "retain", n: 3 }, { op: "delete", n: 2 }, { op: "insert", s: "xyz" }];
    expect(baseLength(ops)).toBe(5); // retain + delete
    expect(targetLength(ops)).toBe(6); // retain + insert
  });
});

describe("transform (TP1 convergence)", () => {
  it("converges on hand-picked concurrent edits", () => {
    const doc = "hello";
    const a: Op[] = [{ op: "insert", s: "X" }, { op: "retain", n: 5 }];
    const b: Op[] = [{ op: "retain", n: 5 }, { op: "insert", s: "Y" }];
    const [aPrime, bPrime] = transform(a, b);
    expect(apply(apply(doc, a), bPrime)).toBe(apply(apply(doc, b), aPrime));
  });

  it("lets `a` win ties on inserts at the same offset", () => {
    const doc = "ab";
    const a: Op[] = [{ op: "retain", n: 1 }, { op: "insert", s: "A" }, { op: "retain", n: 1 }];
    const b: Op[] = [{ op: "retain", n: 1 }, { op: "insert", s: "B" }, { op: "retain", n: 1 }];
    const [aPrime, bPrime] = transform(a, b);
    const left = apply(apply(doc, a), bPrime);
    const right = apply(apply(doc, b), aPrime);
    expect(left).toBe(right);
    // `a` first means A lands before B.
    expect(left).toBe("aABb");
  });

  it("holds over a seeded random battery (property: apply∘transform commutes)", () => {
    const rnd = makeRng(0x5eed);
    for (let round = 0; round < 2000; round++) {
      const doc = randomDoc(rnd);
      const a = randomOps(doc.length, rnd);
      const b = randomOps(doc.length, rnd);
      const [aPrime, bPrime] = transform(a, b);
      const left = apply(apply(doc, a), bPrime);
      const right = apply(apply(doc, b), aPrime);
      expect(left, `diverged in round ${round} on doc ${JSON.stringify(doc)}`).toBe(right);
    }
  });

  it("rejects two ops built against different-length documents", () => {
    expect(() => transform([{ op: "retain", n: 3 }], [{ op: "retain", n: 4 }])).toThrow(
      /same document/,
    );
  });
});

describe("transformOffset", () => {
  it("shifts an offset right past an earlier insert", () => {
    // insert 2 chars at the front, offset 3 -> 5
    expect(transformOffset(3, [{ op: "insert", s: "XY" }, { op: "retain", n: 10 }])).toBe(5);
  });

  it("pulls an offset back over an earlier delete", () => {
    expect(transformOffset(5, [{ op: "delete", n: 2 }, { op: "retain", n: 10 }])).toBe(3);
  });

  it("clamps to the deletion boundary when the offset is inside the deleted span", () => {
    // deleting 4 from the front with offset 2: the char it sat on is gone, so
    // it collapses to the start of the deletion.
    expect(transformOffset(2, [{ op: "delete", n: 4 }, { op: "retain", n: 6 }])).toBe(0);
  });
});

describe("opsFromChanges", () => {
  it("turns a Monaco change batch into one whole-document op", () => {
    // Replace chars [1,3) of a 5-char doc with "XY".
    const ops = opsFromChanges(5, [{ rangeOffset: 1, rangeLength: 2, text: "XY" }]);
    expect(apply("hello", ops)).toBe("hXYlo");
  });

  it("orders unsorted changes by offset and applies them together", () => {
    const ops = opsFromChanges(5, [
      { rangeOffset: 4, rangeLength: 1, text: "!" },
      { rangeOffset: 0, rangeLength: 1, text: "H" },
    ]);
    expect(apply("hello", ops)).toBe("Hell!");
  });

  it("throws on overlapping changes in one edit", () => {
    expect(() =>
      opsFromChanges(5, [
        { rangeOffset: 0, rangeLength: 3, text: "x" },
        { rangeOffset: 1, rangeLength: 1, text: "y" },
      ]),
    ).toThrow(/overlapping/);
  });
});

describe("docHash", () => {
  it("is stable and distinguishes different documents", () => {
    expect(docHash("hello")).toBe(docHash("hello"));
    expect(docHash("hello")).not.toBe(docHash("hellO"));
  });
});

describe("safeName", () => {
  it("reduces a path to a basename", () => {
    expect(safeName("/etc/passwd")).toBe("passwd");
    expect(safeName("a\\b\\c.txt")).toBe("c.txt");
  });

  it("falls back to 'shared' for empty, dot, or dot-dot names", () => {
    expect(safeName("")).toBe("shared");
    expect(safeName(".")).toBe("shared");
    expect(safeName("..")).toBe("shared");
    expect(safeName("/")).toBe("shared");
  });

  it("caps length at 120 chars", () => {
    expect(safeName("x".repeat(500)).length).toBe(120);
  });
});

describe("newDocId", () => {
  it("returns 32 hex chars (128 bits) and is unguessably unique", () => {
    const a = newDocId();
    const b = newDocId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
