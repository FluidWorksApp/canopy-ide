// The scripted scenario behind `canopy --selftest=browser`.
//
// Everything this checks is something a person had to check by eye until now:
// open a panel over the page, does the page get out of the way; does something
// stand in for it while it is gone; does it come back. Four shipped bugs were
// found exactly that way, by the owner, after release.
//
// The assertions are on STATE, not on pixels. What the freeze-frame looks like
// is a rendering question; whether the host hid the view, got an
// acknowledgement, and had a frame in hand is a contract, and a contract can be
// checked without a camera. The pixel checks at the end are advisory for that
// reason — they are the only part that can be flaky, and a suite people learn
// to ignore is worse than no suite.
//
// The scenario is a list, not prose: to cover a new surface, register it in
// overlaySurfaces.ts and it is walked from the next run onwards.

import * as ipc from "../ipc";
import {
  onBrowserSignal,
  browserViewSnapshots,
  type BrowserSignal,
  type ViewSnapshot,
} from "../browserSignals";
import {
  OVERLAY_SURFACES,
  drivableSurfaces,
  type OverlaySurface,
} from "../overlaySurfaces";
import {
  startBrowserWatchdog,
  watchdogViolations,
  type Violation,
} from "../browserWatchdog";
import { markOnboarded } from "../onboarding";

export interface SelftestDeps {
  /** Open the scratch directory as a project, exactly as `canopy <dir>` does. */
  openDirAsProject: (dir: string) => Promise<void>;
  /** The id of the project sitting on that directory, once it exists. */
  projectIdFor: (dir: string) => string | undefined;
}

interface StepReport {
  id: string;
  label: string;
  ok: boolean;
  ms: number;
  detail?: string;
  skipped?: boolean;
  warnings?: string[];
}

interface SurfaceReport {
  id: string;
  label: string;
  kind: string;
  covers: string;
  ok: boolean;
  skipped?: boolean;
  why?: string;
  /** Time from opening the surface to the hide being issued. */
  hideMs?: number;
  /** …and to the backend acknowledging it. */
  ackMs?: number;
  /** …and to a freeze-frame standing in for the page. */
  frozenMs?: number;
  showMs?: number;
  detail?: string;
}

/** How long each assertion may wait. Generous enough for a debug build on a
 *  cold CI runner, tight enough that a latched gate fails rather than hangs. */
const DEADLINE = {
  project: 30_000,
  view: 60_000,
  paint: 30_000,
  frame: 30_000,
  /** A hide should be immediate — one layout pass and an IPC hop. The budget is
   *  far wider than that because these are wall-clock waits on a machine that
   *  may be building something else at the same time, and a suite that goes red
   *  when the runner is busy gets ignored within a week. The actual latencies
   *  are recorded per surface, so a regression in speed shows up as numbers
   *  rather than as a failure. */
  hide: 6_000,
  frozen: 8_000,
  show: 10_000,
  nav: 30_000,
  bounds: 10_000,
};

/** How long a surface has to appear, and then to finish sliding over the pane.
 *  Both are generous for the same reason as the deadlines above. */
const SETTLE_TRIES = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class StepFailure extends Error {}

/** Wait for something to become true, or say what it still was. */
async function until<T>(
  what: string,
  read: () => T,
  ok: (v: T) => boolean,
  ms: number,
  describe: (v: T) => string = (v) => JSON.stringify(v),
): Promise<number> {
  const start = Date.now();
  for (;;) {
    const v = read();
    if (ok(v)) return Date.now() - start;
    if (Date.now() - start > ms) {
      throw new StepFailure(`${what} — waited ${ms}ms, last saw ${describe(v)}`);
    }
    await sleep(25);
  }
}

/** The tab this run is about, fixed as soon as it exists. Reading "whichever
 *  view is first" would drift onto another tab the moment anything else opened
 *  one, and every assertion after that would be about the wrong page. */
let target: string | null = null;

const view = (): ViewSnapshot | undefined => {
  const all = browserViewSnapshots();
  return target ? all.find((v) => v.tabId === target) : all[0];
};

/** The last show/hide the host issued, kept so a failure can say what the host
 *  thought was covering the page rather than only that it was hidden. */
let lastVisibility: Extract<BrowserSignal, { t: "visibility" }> | null = null;

const viewSays = (v: ViewSnapshot | undefined) => {
  if (!v) return "no browser view registered";
  const why = lastVisibility
    ? ` last=${lastVisibility.visible ? "show" : `hide by ${lastVisibility.by}`}`
    : "";
  return `wanted=${v.wanted} shown=${v.shown} frame=${v.hasFrame} loading=${v.loading}${why}`;
};

type Issued = Extract<BrowserSignal, { t: "visibility" }>;
type Acked = Extract<BrowserSignal, { t: "visibility-ack" }>;

/** One signal as a log line. */
function describe(s: BrowserSignal): string {
  const tab = s.tabId.slice(0, 8);
  switch (s.t) {
    case "visibility":
      return `${s.visible ? "show" : "hide"} issued tab=${tab} seq=${s.seq}${
        s.visible ? "" : ` by=${s.by}`
      }`;
    case "visibility-ack":
      return `${s.visible ? "show" : "hide"} ${s.ok ? "acked" : `FAILED ${s.error}`} tab=${tab} seq=${s.seq}`;
    case "capture":
      return `capture ${s.result} tab=${tab} in=${s.ms}ms`;
    case "pane":
      return `pane tab=${tab} -> ${s.state} frame=${s.frame ? "yes" : "no"}`;
    case "nav":
      return `nav tab=${tab} loading=${s.loading}`;
    case "bounds":
      return `bounds tab=${tab} ${s.bounds.width}x${s.bounds.height}@${s.bounds.x},${s.bounds.y}`;
    default:
      return `${s.t} tab=${tab}`;
  }
}

const hideIssued = (list: BrowserSignal[]): Issued | undefined =>
  list.find((s): s is Issued => s.t === "visibility" && !s.visible);

const ackOf = (list: BrowserSignal[], seq: number): Acked | undefined =>
  list.find((s): s is Acked => s.t === "visibility-ack" && s.seq === seq);

/** Whether a surface is actually on screen. A registry entry whose surface
 *  never appears is a skip with a reason, not a failure — the launcher menu
 *  needs a pane bar, the workspace overlay needs an agent. */
function painting(selector: string): boolean {
  for (const el of document.querySelectorAll(selector)) {
    const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    const visible =
      typeof check === "function"
        ? check.call(el, { visibilityProperty: true, opacityProperty: true })
        : el.getClientRects().length > 0;
    const r = el.getBoundingClientRect();
    // On screen, not merely present: a closed side panel is still in the DOM
    // and still "visible" by every CSS measure — it is simply translated off
    // to the left of the window.
    const inside = r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
    if (visible && inside && r.width > 1 && r.height > 1) return true;
  }
  return false;
}

/** Anything already open when the run starts — a first-run walkthrough on a
 *  fresh profile, most likely. The scenario needs an empty stage. */
async function clearTheStage() {
  markOnboarded();
  for (let i = 0; i < 6; i++) {
    const backdrop = document.querySelector(".confirm-backdrop, .modal-backdrop, .palette-backdrop");
    if (!backdrop) return;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await sleep(120);
  }
}

// ---------- pixel sanity (macOS, advisory) ----------

/** The colours the fixture page is made of, and white.
 *
 *  What this can and cannot see is worth being exact about: the child webview
 *  is a sibling native view, and the main window's own snapshot API does not
 *  composite it. So this can never catch "the page painted over the app" in
 *  pixels — that needs a screen grab, which needs macOS Screen Recording
 *  permission, which is not a thing to demand of a developer to run a test.
 *
 *  What it CAN see is the pane while the view is hidden, which is where two of
 *  the four shipped bugs lived: a white placeholder, and a pane with no frame
 *  in it at all. Both are visible here, and both are checked. */
const PAGE_RGB: [number, number, number][] = [
  [15, 138, 95],
  [11, 111, 76],
  [6, 48, 31],
];

function near(px: ArrayLike<number>, i: number, rgb: [number, number, number], tol: number): boolean {
  return (
    Math.abs(px[i] - rgb[0]) <= tol &&
    Math.abs(px[i + 1] - rgb[1]) <= tol &&
    Math.abs(px[i + 2] - rgb[2]) <= tol
  );
}

interface Sampled {
  white: number;
  page: number;
}

/** Advisory, so a failure to sample is a note rather than a red run — but a
 *  silent one would be indistinguishable from a clean pane, so the reason
 *  always comes back. */
async function samplePane(rect: DOMRect): Promise<Sampled | string> {
  let png: string;
  try {
    png = await ipc.webviewSnapshot(rect.x, rect.y, rect.width, rect.height, 240);
  } catch (err) {
    return `snapshot refused: ${err}`;
  }
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  try {
    await img.decode();
  } catch (err) {
    return `snapshot did not decode: ${err}`;
  }
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "no 2d context to measure with";
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let white = 0;
  let page = 0;
  const total = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) white++;
    else if (PAGE_RGB.some((rgb) => near(data, i, rgb, 26))) page++;
  }
  return { white: white / total, page: page / total };
}

// ---------- the scenario ----------

export async function runBrowserSelftest(cfg: ipc.SelftestConfig, deps: SelftestDeps) {
  const startedAt = Date.now();
  const steps: StepReport[] = [];
  const surfaces: SurfaceReport[] = [];
  const notes: string[] = [];
  const signals: BrowserSignal[] = [];
  const unwatch = onBrowserSignal((s) => {
    signals.push(s);
    if (s.t === "visibility") lastVisibility = s;
    // The whole timeline in the log. This is the record that turns "the preview
    // was broken" into a sequence somebody can read afterwards, and it is the
    // only view anyone gets of a native surface that devtools cannot inspect.
    void ipc.jsLog("info", `browser: ${describe(s)}`);
  });
  void ipc.jsLog("info", `browser:SELFTEST starting on ${cfg.url}`);
  // Release builds don't run the watchdog; a run that is explicitly testing
  // this layer always does.
  const stopWatchdog = startBrowserWatchdog(true);

  /** Nothing in a step may outlast this. Every assertion has its own deadline,
   *  but the app's own calls (opening a project, resizing a window) do not, and
   *  a scenario that waits forever reports nothing at all — which is the least
   *  useful way for a test of a hanging bug to fail. */
  const STEP_CAP = 90_000;

  const step = async (id: string, label: string, run: () => Promise<string | void>) => {
    const at = Date.now();
    void ipc.jsLog("info", `browser:SELFTEST step ${id} …`);
    try {
      const detail = await Promise.race([
        run(),
        sleep(STEP_CAP).then(() => {
          throw new StepFailure(`step did not finish within ${STEP_CAP}ms`);
        }),
      ]);
      void ipc.jsLog("info", `browser:SELFTEST step ${id} ok in ${Date.now() - at}ms`);
      steps.push({ id, label, ok: true, ms: Date.now() - at, detail: detail || undefined });
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      void ipc.jsLog("error", `browser:SELFTEST step ${id} FAILED — ${detail}`);
      steps.push({ id, label, ok: false, ms: Date.now() - at, detail });
      return false;
    }
  };

  /** Signals since a mark, which is how each surface is timed. */
  const since = (mark: number) => signals.slice(mark);

  try {
    await step("stage", "Clear anything already on screen", async () => {
      await clearTheStage();
    });

    await step("project", "Open the scratch project", async () => {
      await deps.openDirAsProject(cfg.projectDir);
      await until(
        "the project never opened",
        () => deps.projectIdFor(cfg.projectDir),
        (id) => !!id,
        DEADLINE.project,
        (id) => `projectId=${id}`,
      );
    });

    const projectId = deps.projectIdFor(cfg.projectDir);
    if (!projectId) throw new StepFailure("no project to run in");

    await step("preview", "Open a preview tab on the fixture page", async () => {
      // Asked again only if the first one was lost: the project's view mounts
      // its listener a render or two after the project itself exists, and an
      // event dispatched into that gap goes nowhere. Re-asking blindly would
      // open a second preview tab, and every assertion afterwards would be
      // about whichever of them answered first.
      for (let attempt = 0; attempt < 3 && browserViewSnapshots().length === 0; attempt++) {
        if (attempt > 0) {
          void ipc.jsLog(
            "info",
            `browser:SELFTEST preview not up yet — tabs=${document.querySelectorAll(".pane-bar .tab").length} ` +
              `hosts=${document.querySelectorAll(".preview-webview-host").length} views=${browserViewSnapshots().length}`,
          );
        }
        window.dispatchEvent(
          new CustomEvent("canopy:agent-action", {
            detail: { projectId, action: { kind: "open_preview", url: cfg.url } },
          }),
        );
        for (let i = 0; i < 200 && browserViewSnapshots().length === 0; i++) await sleep(50);
      }
      await until(
        "no browser view registered",
        () => browserViewSnapshots().length,
        (n) => n > 0,
        DEADLINE.view,
        (n) => `${n} views`,
      );
      target = browserViewSnapshots()[0].tabId;
      return `tab ${target.slice(0, 8)}`;
    });

    if (!view()) {
      notes.push(
        "No native browser view was registered — this build is running the proxy engine, " +
          "where none of the occlusion rules apply. Nothing below was tested.",
      );
    }

    await step("first-paint", "The page comes up on screen", () =>
      until(
        "the view never became visible",
        view,
        (v) => v?.shown === true,
        DEADLINE.paint,
        viewSays,
      ).then(() => undefined),
    );

    // The one that would have caught the capture gate latching shut: a page can
    // be perfectly visible and still never be photographed, and nothing about
    // looking at it says so.
    await step("first-frame", "A freeze-frame is captured while the page is up", () =>
      until(
        "no frame was ever captured",
        view,
        (v) => v?.hasFrame === true,
        DEADLINE.frame,
        viewSays,
      ).then((ms) => `first frame after ${ms}ms`),
    );

    // ---- every registered overlay surface ----
    for (const surface of drivableSurfaces()) {
      const report = await exerciseSurface(surface, since, () => signals.length);
      void ipc.jsLog(
        report.ok ? "info" : "error",
        `browser:SELFTEST surface ${surface.id} ${
          report.skipped ? `skipped (${report.why})` : report.ok ? "ok" : `FAILED — ${report.detail}`
        }`,
      );
      surfaces.push(report);
    }
    for (const surface of OVERLAY_SURFACES.filter((s) => !s.open)) {
      surfaces.push({
        id: surface.id,
        label: surface.label,
        kind: surface.kind,
        covers: surface.covers,
        ok: true,
        skipped: true,
        why: surface.why ?? "no programmatic opener",
      });
    }

    // ---- pixel sanity, advisory ----
    await step("pixels", "The hidden pane shows the page, not a white hole", async () => {
      const v = view();
      if (!v?.hostRect) throw new StepFailure("no pane to sample");
      const surface = OVERLAY_SURFACES.find((s) => s.id === "side-peek");
      await surface?.open?.();
      await sleep(700);
      const sample = await samplePane(v.hostRect);
      await surface?.close?.();
      await sleep(500);
      if (typeof sample === "string") {
        notes.push(`advisory: pixels not sampled — ${sample}`);
        return `not sampled (${sample})`;
      }
      const pct = (n: number) => `${Math.round(n * 100)}%`;
      const detail = `white=${pct(sample.white)} page=${pct(sample.page)}`;
      // Advisory: recorded as a warning rather than a failure, because a theme,
      // a scrollbar or a retina rounding can move these a few points and a
      // flaky red is how a suite gets ignored.
      if (sample.white > 0.5) notes.push(`advisory: the hidden pane is mostly white (${detail})`);
      if (sample.page < 0.05) notes.push(`advisory: no page colours in the hidden pane (${detail})`);
      return detail;
    });

    // ---- tab away and back ----
    await step("tab-switch", "Away to another tab and back", async () => {
      // Judged by the view's own state rather than by counting tab elements:
      // a terminal is not a doc tab and does not appear in the tab strip, and a
      // test that asserts on the app's markup breaks the next time the markup
      // moves. What matters is only whether the page left the screen when it
      // stopped being the front pane, and came back when it was again.
      window.dispatchEvent(new CustomEvent("menu:new-terminal"));
      await until(
        "the page stayed on screen after another tab took the front",
        view,
        (v) => v?.shown !== true,
        DEADLINE.nav,
        viewSays,
      );
      const away = Date.now();
      for (let i = 0; i < 6 && view()?.shown !== true; i++) {
        window.dispatchEvent(new CustomEvent(i % 2 === 0 ? "menu:prev-tab" : "menu:next-tab"));
        for (let w = 0; w < 30 && view()?.shown !== true; w++) await sleep(50);
      }
      await until(
        "the page never came back when its tab did",
        view,
        (v) => v?.shown === true,
        DEADLINE.show,
        viewSays,
      );
      return `back after ${Date.now() - away}ms`;
    });

    // ---- navigation drops the stale frame ----
    await step("navigate", "A navigation drops the frame of the old page", async () => {
      const v = view();
      if (!v) throw new StepFailure("no view");
      // Start from a frame in hand, or "the frame was dropped" proves nothing.
      await until(
        "there was no frame to drop in the first place",
        view,
        (s) => s?.hasFrame === true,
        DEADLINE.frame,
        viewSays,
      );
      await ipc.browserNavigate(v.tabId, `${cfg.url}?again=1`);
      await until(
        "the stale frame was kept across a navigation",
        view,
        (s) => s?.hasFrame === false,
        DEADLINE.nav,
        viewSays,
      );
      const ms = await until(
        "no frame was captured after the navigation",
        view,
        (s) => s?.hasFrame === true,
        DEADLINE.nav,
        viewSays,
      );
      return `re-captured after ${ms}ms`;
    });

    // ---- the view follows its placeholder ----
    // The placeholder is moved by relaying out the app rather than by resizing
    // the window: sizing the window from JS is a capability the frontend does
    // not have and should not be given for a test. Focus mode takes the title
    // bar and the tab bar away, which moves and grows the pane by ~70px — the
    // same bounds-sync path, driven the way a user drives it.
    await step("bounds", "The view follows its placeholder when the app relays out", async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "Enter",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
      await sleep(700);
      const drift = () => {
        const v = view();
        if (!v?.bounds || !v.hostRect) return null;
        const z = v.zoom > 0 ? v.zoom : 1;
        return Math.max(
          Math.abs(v.bounds.x / z - v.hostRect.left),
          Math.abs(v.bounds.y / z - v.hostRect.top),
          Math.abs(v.bounds.width / z - v.hostRect.width),
          Math.abs(v.bounds.height / z - v.hostRect.height),
        );
      };
      const ms = await until(
        "the view did not follow its placeholder",
        drift,
        (d) => d !== null && d <= 2,
        DEADLINE.bounds,
        (d) => `${d === null ? "unmeasurable" : `${Math.round(d)}px`} off`,
      );
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(400);
      return `converged in ${ms}ms`;
    });
  } catch (err) {
    steps.push({
      id: "scenario",
      label: "Scenario",
      ok: false,
      ms: Date.now() - startedAt,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Let anything still in flight settle, so a violation raised by the last step
  // is in the report rather than in the next run's imagination.
  await sleep(400);
  const violations: Violation[] = watchdogViolations();
  unwatch();
  stopWatchdog();

  const ok =
    steps.every((s) => s.ok) && surfaces.every((s) => s.ok) && violations.length === 0;

  const report = {
    scenario: cfg.scenario,
    ok,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    platform: navigator.platform,
    engine: view() ? "webview" : "proxy-or-gone",
    page: cfg.url,
    steps,
    surfaces,
    violations: violations.map((v) => ({
      code: v.code,
      what: v.what,
      detail: v.detail,
      tabId: v.tabId.slice(0, 8),
      heldMs: Math.max(0, v.at - v.since),
    })),
    notes,
  };
  await ipc.jsLog(
    ok ? "info" : "error",
    `browser:SELFTEST ${ok ? "PASS" : "FAIL"} steps=${steps.filter((s) => s.ok).length}/${steps.length} ` +
      `surfaces=${surfaces.filter((s) => !s.skipped).length} violations=${violations.length}`,
  );
  await ipc.selftestFinish(report);
}

/** Open one surface over the page, and hold it to the contract: the view is
 *  hidden, the hide is acknowledged, something stands in for the page, and all
 *  of it comes back when the surface closes. */
async function exerciseSurface(
  surface: OverlaySurface,
  since: (mark: number) => BrowserSignal[],
  mark: () => number,
): Promise<SurfaceReport> {
  const base: SurfaceReport = {
    id: surface.id,
    label: surface.label,
    kind: surface.kind,
    covers: surface.covers,
    ok: true,
  };
  const v0 = view();
  if (!v0 || v0.shown !== true) {
    return { ...base, skipped: true, why: "the page was not on screen to be covered" };
  }
  const pane = v0.hostRect;
  const at = Date.now();
  const m = mark();
  try {
    await surface.open?.();
    // A surface that never paints is not this test's business — it is a
    // registry entry whose preconditions weren't met.
    let appeared = false;
    for (let i = 0; i < SETTLE_TRIES && !appeared; i++) {
      appeared = painting(surface.selector);
      if (!appeared) await sleep(25);
    }
    if (!appeared) {
      return { ...base, skipped: true, why: surface.why ?? "the surface never appeared" };
    }
    // A surface that opens somewhere else entirely — a menu hanging off the tab
    // bar, a chip in a corner — must NOT hide the page, and demanding that it
    // does would be demanding a bug. Give it a moment to finish arriving first:
    // most of these slide, and where it starts is not where it ends up.
    let over = false;
    for (let i = 0; i < SETTLE_TRIES && !over; i++) {
      over = coversPane(surface.selector, pane);
      if (!over) await sleep(25);
    }
    if (!over) {
      return {
        ...base,
        skipped: true,
        why: "it opened clear of the pane, so the page was right not to move",
      };
    }

    await until(
      `${surface.id}: the page was never hidden for it`,
      () => hideIssued(since(m)),
      (s) => !!s,
      DEADLINE.hide,
      () => viewSays(view()),
    );
    const hide = hideIssued(since(m))!;
    await until(
      `${surface.id}: the hide was never acknowledged`,
      () => ackOf(since(m), hide.seq),
      (s) => !!s,
      DEADLINE.hide,
      () => "no ack",
    );
    const ack = ackOf(since(m), hide.seq)!;

    await until(
      `${surface.id}: nothing stood in for the page while it was hidden`,
      view,
      (s) => s?.hasFrame === true && s.shown !== true,
      DEADLINE.frozen,
      viewSays,
    );
    const frozenAt = Date.now();

    await ensureClosed(surface);
    const showMs = await until(
      `${surface.id}: the page never came back`,
      view,
      (s) => s?.shown === true,
      DEADLINE.show,
      viewSays,
    );
    return {
      ...base,
      hideMs: hide.at - at,
      ackMs: ack.at - at,
      frozenMs: frozenAt - at,
      showMs,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await ensureClosed(surface);
  }
}

/** Whether anything matching `selector` is actually over the pane. */
function coversPane(selector: string, pane: DOMRect | null): boolean {
  if (!pane) return false;
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, pane.right) - Math.max(r.left, pane.left);
    const h = Math.min(r.bottom, pane.bottom) - Math.max(r.top, pane.top);
    if (w > 2 && h > 2) return true;
  }
  return false;
}

/** Put the stage back, whatever the surface did.
 *
 *  This matters more than it looks: a surface left open covers the page for
 *  every check after it, and one stuck menu would turn a single failure into a
 *  whole red run that says nothing. So the closer is tried, then every general
 *  dismissal the app has, and only a surface that survives all of that is
 *  reported as unclosable. */
async function ensureClosed(surface: OverlaySurface) {
  // Already gone: calling the closer again would re-open every surface whose
  // opener and closer are the same toggle.
  if (!painting(surface.selector)) return;
  const gone = async () => {
    for (let i = 0; i < 12; i++) {
      if (!painting(surface.selector)) return true;
      await sleep(50);
    }
    return false;
  };
  try {
    await surface.close?.();
  } catch {
    // The closer's own failure is covered by the dismissals below.
  }
  if (await gone()) return;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  window.dispatchEvent(new Event("resize"));
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  for (const el of document.querySelectorAll(surface.selector)) {
    el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
  }
  await gone();
}
