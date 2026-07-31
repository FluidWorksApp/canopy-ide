import { describe, expect, it } from "vitest";
import {
  createWatchdog,
  conditionsFor,
  LIMITS,
  type Sample,
  type Violation,
} from "./browserWatchdog";

/** A view doing nothing wrong: on screen, nothing over it, a frame in hand, a
 *  capture a moment ago, bounds where its placeholder is. */
const healthy = (o: Partial<Sample> = {}): Sample => ({
  at: 100_000,
  tabId: "tab-1",
  wanted: true,
  visible: true,
  occluder: null,
  hasFrame: true,
  loading: false,
  settled: true,
  lastCaptureOkAt: 99_500,
  capturableSince: 60_000,
  drift: 0,
  unacked: [],
  ...o,
});

/** Feed a timeline and collect everything that fired. */
function run(samples: Sample[]) {
  const dog = createWatchdog();
  const opened: Violation[] = [];
  const closed: Violation[] = [];
  for (const s of samples) {
    const tick = dog.observe(s);
    opened.push(...tick.opened);
    closed.push(...tick.closed);
  }
  return { opened, closed, codes: opened.map((v) => v.code) };
}

/** The same sample repeated across a span, every 50ms — what the sampler does. */
function held(base: Sample, ms: number, o: Partial<Sample> = {}): Sample[] {
  const out: Sample[] = [];
  for (let t = 0; t <= ms; t += 50) out.push({ ...base, ...o, at: base.at + t });
  return out;
}

describe("a healthy view", () => {
  it("never fires", () => {
    expect(run(held(healthy(), 5_000)).opened).toEqual([]);
  });

  it("tolerates a hide that lands quickly", () => {
    const at = 100_000;
    const timeline = [
      healthy({ at, unacked: [{ seq: 1, visible: false, at }] }),
      healthy({ at: at + 200, unacked: [{ seq: 1, visible: false, at }] }),
      healthy({ at: at + 400, unacked: [] }),
    ];
    expect(run(timeline).opened).toEqual([]);
  });
});

// I1 — the bug that started this: the side panel slid in over the page and
// nothing re-checked, so the host went on believing the view was clear.
describe("I1 — something is over a visible view", () => {
  it("ignores a single frame of overlap", () => {
    const base = healthy({ occluder: "side-peek" });
    expect(run(held(base, 100)).opened).toEqual([]);
  });

  it("fires once the overlap outlasts the budget", () => {
    const base = healthy({ occluder: "side-peek (div.side-peek)" });
    const { opened } = run(held(base, 400));
    expect(opened.map((v) => v.code)).toEqual(["I1"]);
    expect(opened[0].detail).toContain("side-peek");
  });

  it("says nothing when the view was hidden for it, which is the correct answer", () => {
    const base = healthy({ occluder: "side-peek", visible: false, hasFrame: true });
    expect(run(held(base, 2_000)).opened).toEqual([]);
  });

  it("clears when the surface goes away, and can fire again", () => {
    const start = healthy({ occluder: "side-peek" });
    const timeline = [
      ...held(start, 400),
      ...held({ ...start, at: start.at + 500 }, 200, { occluder: null }),
      ...held({ ...start, at: start.at + 800 }, 400),
    ];
    const { opened, closed } = run(timeline);
    expect(opened.map((v) => v.code)).toEqual(["I1", "I1"]);
    expect(closed).toHaveLength(1);
  });

  it("counts two different surfaces separately", () => {
    const a = healthy({ occluder: "side-peek" });
    const timeline = [...held(a, 400), ...held({ ...a, at: a.at + 500 }, 400, { occluder: "palette" })];
    expect(run(timeline).codes).toEqual(["I1", "I1"]);
  });
});

// I2 — issued and never acknowledged. A hide the backend never performs leaves
// the page on top of the app and nothing else would ever say so.
describe("I2 — an unacknowledged visibility change", () => {
  it("waits out the ack budget before complaining", () => {
    const at = 100_000;
    const unacked = [{ seq: 7, visible: false, at }];
    expect(run(held(healthy({ at, unacked }), 400)).opened).toEqual([]);
  });

  it("fires when the ack never comes", () => {
    const at = 100_000;
    const unacked = [{ seq: 7, visible: false, at }];
    const { opened } = run(held(healthy({ at, unacked }), 900));
    expect(opened.map((v) => v.code)).toEqual(["I2"]);
    expect(opened[0].detail).toContain("hide #7");
  });

  it("reports a stuck show too", () => {
    const at = 100_000;
    const unacked = [{ seq: 9, visible: true, at }];
    expect(run(held(healthy({ at, unacked }), 900)).opened[0].detail).toContain("show #9");
  });
});

// I3 — hidden with nothing to put in its place: the hole the freeze-frame
// exists to prevent, and what a latched capture gate silently reopens.
describe("I3 — hidden with no freeze-frame", () => {
  it("fires when the pane has nothing to show", () => {
    const base = healthy({ visible: false, occluder: "side-peek", hasFrame: false });
    expect(run(held(base, 400)).codes).toEqual(["I3"]);
  });

  it("forgives a page that is still arriving", () => {
    const base = healthy({ visible: false, occluder: "side-peek", hasFrame: false, loading: true });
    expect(run(held(base, 2_000)).opened).toEqual([]);
  });

  it("forgives the moment between hiding and having the frame up", () => {
    const base = healthy({ visible: false, occluder: "side-peek", hasFrame: false });
    expect(run(held(base, 100)).opened).toEqual([]);
  });
});

// I4 — the page painting somewhere other than its placeholder. No bug here
// yet; one CSS change away from one.
describe("I4 — bounds drift", () => {
  it("allows a pixel of rounding", () => {
    expect(run(held(healthy({ drift: 2 }), 2_000)).opened).toEqual([]);
  });

  it("fires on a real divergence that persists", () => {
    const { opened } = run(held(healthy({ drift: 40 }), 500));
    expect(opened.map((v) => v.code)).toEqual(["I4"]);
    expect(opened[0].detail).toContain("40px");
  });

  it("ignores a drift that resolves inside a resize", () => {
    const drifting = held(healthy({ drift: 40 }), 200);
    const settled = held({ ...healthy(), at: 100_250 }, 500);
    expect(run([...drifting, ...settled]).opened).toEqual([]);
  });

  it("says nothing about a view that isn't on screen", () => {
    expect(run(held(healthy({ visible: false, drift: 400 }), 2_000)).opened).toEqual([]);
  });
});

// I5 — the capture path being dead. This is the one that would have caught the
// gate that latched shut, within ten seconds of the build that broke it.
describe("I5 — no frame captured from a settled page", () => {
  it("stays quiet while captures keep landing", () => {
    const samples = held(healthy(), 30_000).map((s) => ({ ...s, lastCaptureOkAt: s.at - 900 }));
    expect(run(samples).opened).toEqual([]);
  });

  it("fires when nothing has been captured for ten seconds", () => {
    const at = 100_000;
    const samples = held(healthy({ at, lastCaptureOkAt: at }), 11_000);
    expect(run(samples).codes).toEqual(["I5"]);
  });

  it("does not blame a page that is still moving", () => {
    const at = 100_000;
    const samples = held(healthy({ at, lastCaptureOkAt: at, settled: false }), 30_000);
    expect(run(samples).opened).toEqual([]);
  });

  it("does not blame a view nobody is showing", () => {
    const at = 100_000;
    const samples = held(healthy({ at, lastCaptureOkAt: at, visible: false }), 30_000);
    expect(run(samples).opened).toEqual([]);
  });

  // The false alarm this cost a user: a tab in the background for half a minute
  // has correctly not photographed itself for half a minute, and the capture it
  // triggers on the way back lands tens of milliseconds AFTER the first sample.
  it("does not blame a view for the time it spent off screen", () => {
    const at = 100_000;
    const back = healthy({ at, lastCaptureOkAt: at - 26_000, capturableSince: at });
    expect(run(held(back, 5_000)).opened).toEqual([]);
  });

  it("still fires if nothing arrives once it is back", () => {
    const at = 100_000;
    const back = healthy({ at, lastCaptureOkAt: at - 26_000, capturableSince: at });
    expect(run(held(back, 11_000)).codes).toEqual(["I5"]);
  });

  it("starts the clock when a long load settles, not before", () => {
    const at = 100_000;
    // Twenty seconds of loading with the view up, then a settled page: the
    // budget begins at the moment it became photographable.
    const loading = held(healthy({ at, lastCaptureOkAt: at, settled: false }), 20_000);
    const settled = held(
      healthy({ at: at + 20_050, lastCaptureOkAt: at, capturableSince: at + 20_050 }),
      5_000,
    );
    expect(run([...loading, ...settled]).opened).toEqual([]);
  });
});


describe("bookkeeping", () => {
  it("reports one breach once, however long it lasts", () => {
    // Captures keep landing throughout, so I1 is the only thing wrong.
    const samples = held(healthy({ occluder: "side-peek" }), 10_000).map((s) => ({
      ...s,
      lastCaptureOkAt: s.at - 500,
    }));
    expect(run(samples).opened).toHaveLength(1);
  });

  it("keeps two tabs' breaches apart", () => {
    const one = held(healthy({ occluder: "side-peek" }), 400);
    const two = held(healthy({ tabId: "tab-2", occluder: "palette" }), 400);
    const dog = createWatchdog();
    const opened: Violation[] = [];
    // Interleaved, as the sampler would deliver them.
    for (let i = 0; i < one.length; i++) {
      opened.push(...dog.observe(one[i]).opened, ...dog.observe(two[i]).opened);
    }
    expect(opened.map((v) => v.tabId).sort()).toEqual(["tab-1", "tab-2"]);
    expect(dog.open()).toHaveLength(2);
  });

  it("a tab that closes stops being in breach", () => {
    const dog = createWatchdog();
    for (const s of held(healthy({ occluder: "side-peek" }), 400)) dog.observe(s);
    expect(dog.open()).toHaveLength(1);
    const tick = dog.forget("tab-1", 101_000);
    expect(tick.closed.map((v) => v.code)).toEqual(["I1"]);
    expect(dog.open()).toEqual([]);
  });

  it("holds the whole timeline against all five invariants at once", () => {
    const at = 100_000;
    const broken = healthy({
      at,
      visible: false,
      wanted: true,
      occluder: "side-peek",
      hasFrame: false,
      lastCaptureOkAt: at - 60_000,
      unacked: [{ seq: 1, visible: false, at: at - 5_000 }],
    });
    // Hidden, no frame, and an ack that never came: I2 and I3, and nothing
    // about a view that is off screen.
    expect(new Set(run(held(broken, 500)).codes)).toEqual(new Set(["I2", "I3"]));
  });
});

describe("conditionsFor", () => {
  it("is where the whole judgement lives, and is pure", () => {
    const s = healthy({ occluder: "x" });
    expect(conditionsFor(s, LIMITS)).toEqual(conditionsFor(s, LIMITS));
    expect(conditionsFor(healthy(), LIMITS)).toEqual([]);
  });
});
