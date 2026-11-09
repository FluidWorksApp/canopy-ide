import { describe, expect, it, vi } from "vitest";
import {
  bannerText,
  canSendInput,
  clampScroll,
  contentRect,
  createFrameBus,
  createThrottle,
  deskReducer,
  isBeingViewed,
  mapKeyCode,
  needsConsent,
  pointerToNormalized,
  viewerStatus,
  type DeskStateEvent,
  type DeskView,
} from "./desk";

const ev = (o: Partial<DeskStateEvent> = {}): DeskStateEvent => ({
  session: "s1",
  state: "requested",
  role: "target",
  peer: "ada",
  peer_name: "Ada",
  mode: null,
  ...o,
});

describe("deskReducer", () => {
  it("tracks the session lifecycle", () => {
    let s: DeskView = null;
    s = deskReducer(s, { type: "state", event: ev() });
    expect(needsConsent(s)).toBe(true);
    s = deskReducer(s, { type: "state", event: ev({ state: "active", mode: "control" }) });
    expect(needsConsent(s)).toBe(false);
    expect(isBeingViewed(s)).toBe(true);
    s = deskReducer(s, { type: "state", event: ev({ state: "ended", reason: "bye" }) });
    expect(isBeingViewed(s)).toBe(false);
  });

  it("ignores a foreign session while one is live", () => {
    const live = ev({ state: "active", mode: "view-only" });
    const s = deskReducer(live, { type: "state", event: ev({ session: "other" }) });
    expect(s).toBe(live);
  });

  it("lets a new session replace an ended one", () => {
    const s = deskReducer(ev({ state: "ended" }), { type: "state", event: ev({ session: "s2" }) });
    expect(s?.session).toBe("s2");
  });

  it("dismisses only the matching session", () => {
    const live = ev({ state: "ended" });
    expect(deskReducer(live, { type: "dismiss", session: "x" })).toBe(live);
    expect(deskReducer(live, { type: "dismiss", session: "s1" })).toBeNull();
  });
});

describe("grants", () => {
  it("allows input only for an active control viewer", () => {
    const base = ev({ role: "viewer", state: "active", mode: "control" });
    expect(canSendInput(base)).toBe(true);
    expect(canSendInput({ ...base, mode: "view-only" })).toBe(false);
    expect(canSendInput({ ...base, state: "requested" })).toBe(false);
    expect(canSendInput({ ...base, role: "target" })).toBe(false);
    expect(canSendInput(null)).toBe(false);
  });

  it("words the banner and status", () => {
    expect(bannerText(ev({ mode: "view-only" }))).toBe("Ada is viewing your screen");
    expect(bannerText(ev({ mode: "control" }))).toBe("Ada is controlling your screen");
    expect(viewerStatus(ev({ role: "viewer" }))).toBe("Waiting for consent");
    expect(viewerStatus(ev({ state: "ended", reason: "Declined." }))).toBe("Denied: Declined.");
    expect(viewerStatus(ev({ state: "ended", reason: "peer left" }))).toBe("Ended: peer left");
  });
});

describe("pointer mapping", () => {
  const box = { left: 100, top: 50, width: 800, height: 600 };

  it("maps corners of an exactly fitting frame", () => {
    expect(pointerToNormalized(100, 50, box, 1600, 1200)).toEqual({ x: 0, y: 0 });
    expect(pointerToNormalized(900, 650, box, 1600, 1200)).toEqual({ x: 1, y: 1 });
    expect(pointerToNormalized(500, 350, box, 1600, 1200)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("accounts for letterboxing and rejects the bars", () => {
    // 2:1 frame in a 4:3 box: bars above and below.
    const r = contentRect(box, 1600, 800);
    expect(r).toEqual({ left: 100, top: 150, width: 800, height: 400 });
    expect(pointerToNormalized(500, 60, box, 1600, 800)).toBeNull();
    expect(pointerToNormalized(500, 350, box, 1600, 800)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("returns null with no frame yet", () => {
    expect(pointerToNormalized(500, 350, box, 0, 0)).toBeNull();
  });
});

describe("mapKeyCode", () => {
  it("passes the allowed set", () => {
    for (const c of ["KeyA", "Digit5", "F12", "Enter", "ArrowLeft", "Backquote"]) {
      expect(mapKeyCode(c)).toBe(c);
    }
  });
  it("drops everything else", () => {
    for (const c of ["F13", "F0", "Key1", "KeyAB", "AudioVolumeUp", "", "Numpad1"]) {
      expect(mapKeyCode(c)).toBeNull();
    }
  });
});

describe("throttle and scroll", () => {
  it("limits to one event per gap", () => {
    const ok = createThrottle(25);
    expect(ok(0)).toBe(true);
    expect(ok(10)).toBe(false);
    expect(ok(25)).toBe(true);
  });
  it("clamps scroll", () => {
    expect(clampScroll(5000)).toBe(1000);
    expect(clampScroll(-5000)).toBe(-1000);
    expect(clampScroll(NaN)).toBe(0);
    expect(clampScroll(2.6)).toBe(3);
  });
});

describe("frame bus", () => {
  it("delivers frames only", () => {
    const bus = createFrameBus();
    const cb = vi.fn();
    const off = bus.subscribe(cb);
    const base = { id: "i", from: "a", from_name: "A", to: "b", session: "s1", ts: 1 };
    bus.publish({ ...base, body: { kind: "ping" } });
    expect(cb).not.toHaveBeenCalled();
    bus.publish({ ...base, body: { kind: "frame", seq: 1, w: 2, h: 3, jpeg_b64: "QQ==" } });
    expect(cb).toHaveBeenCalledWith({ session: "s1", w: 2, h: 3, jpeg_b64: "QQ==" });
    off();
    bus.publish({ ...base, body: { kind: "frame", seq: 2, w: 2, h: 3, jpeg_b64: "QQ==" } });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
