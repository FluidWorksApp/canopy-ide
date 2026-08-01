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
  describeBrowserSignal,
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
import { BROWSER_INPUT_EVENT } from "../components/PreviewView";
import { refreshBrowserViews, suppressBrowserViews } from "../browserHost";
import { getSettings, updateSettings } from "../settings";
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
 *  Measured in time rather than in tries: a busy machine stretches every
 *  setTimeout, and a loop of "300 tries at 25ms" then takes minutes instead of
 *  seconds — patient in a way that turns a short run into a stuck one. */
const SETTLE_MS = 6_000;

/** Poll `read` until it is true or the budget runs out. */
async function settle(read: () => boolean, ms = SETTLE_MS): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (read()) return true;
    if (Date.now() > until) return false;
    await sleep(25);
  }
}

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
    const backdrop = document.querySelector(".confirm-backdrop, .dlg-scrim, .modal-backdrop, .palette-backdrop");
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
    void ipc.jsLog("info", `browser: ${describeBrowserSignal(s)}`);
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
      // Everything below tests the webview engine's contract, and that engine
      // is no longer the default — so it is asked for by name. Without this
      // the whole scenario would quietly pass by testing nothing, which is
      // the failure mode this suite exists to prevent.
      updateSettings({ browserEngine: "webview" });
      refreshBrowserViews();
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
      // The project's view mounts its listener a render or two after the
      // project itself exists, and an event dispatched into that gap goes
      // nowhere at all. Waiting for its chrome to be on screen is what makes
      // the first ask land — re-asking blindly opens a second preview tab, and
      // every assertion afterwards would be about whichever answered first.
      await until(
        "the project never finished opening",
        () => document.querySelector(".pane-bar"),
        (el) => !!el,
        DEADLINE.project,
        () => "no pane bar yet",
      );
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

    // The reported bug, as a step. Opening a preview with a panel over it
    // showed a blank white pane, and only a manual reload fixed it: the page
    // loaded entirely while its view was hidden, and a hidden WKWebView does
    // not render — nor does WebKit go back and paint a document whose first
    // commit never happened.
    //
    // "Loaded" cannot answer this and neither can a snapshot, which forces the
    // render it would be measuring. The page is asked instead, from its own
    // first requestAnimationFrame (preview_picker.js) — a callback that only
    // runs when the view is actually being drawn.
    await step("hidden-load", "A page loaded while the view is hidden paints when it returns", async () => {
      const v = view();
      if (!v) throw new StepFailure("no view");
      // Hidden imperatively rather than by opening a panel: the mechanism
      // under test is "the view was off screen while the document loaded",
      // and driving that through the app's own surfaces makes the
      // measurement depend on whichever of them happens to be open already.
      const release = suppressBrowserViews();
      let released = false;
      try {
        if (!(await settle(() => view()?.shown === false))) {
          throw new StepFailure("the view never went hidden");
        }
        await ipc.browserNavigate(v.tabId, `${cfg.url}?hidden=1`);
        await sleep(2500);
        const whileHidden = await ipc.browserPainted(v.tabId).catch(() => false);
        release();
        released = true;
        await until(
          "the page never came back on screen",
          view,
          (s) => s?.shown === true,
          DEADLINE.show,
          viewSays,
        );
        // Being shown is its own chance to paint; give it one before judging.
        await sleep(1200);
        const afterShow = await ipc.browserPainted(v.tabId).catch(() => false);
        if (!afterShow) {
          throw new StepFailure(
            `the page never rendered a frame — a blank pane (painted while hidden: ${whileHidden})`,
          );
        }
        return `painted — while hidden: ${whileHidden}, after reveal: ${afterShow}`;
      } finally {
        if (!released) release();
      }
    });

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

    // ---- clicking the page dismisses what is over it ----
    await step("dismiss", "A press in the page closes the panel covering it", async () => {
      const surface = OVERLAY_SURFACES.find((s) => s.id === "side-peek");
      if (!surface?.open) throw new StepFailure("no side panel to open");
      // On screen, not merely present. The panel is always in the DOM — closed
      // is a class that translates it off to the left — so asking whether the
      // element exists is asking a question whose answer is always yes. It
      // made this step fail on every run, and the `finally` below then toggled
      // the panel back OPEN over the page, taking the next three steps with
      // it. A red step that fabricates its own failure and poisons its
      // neighbours is worse than no step.
      const up = () => painting(surface.selector);
      await surface.open();
      if (!(await settle(up))) throw new StepFailure("the panel never opened");
      try {
        // What the injected picker sends when a real press lands in the page.
        // Raised here rather than clicked for real because the press this is
        // about happens in a native view the automation cannot reach — which is
        // the whole reason the forwarding exists.
        window.dispatchEvent(new CustomEvent(BROWSER_INPUT_EVENT));
        if (!(await settle(() => !up(), DEADLINE.hide)))
          throw new StepFailure("the panel stayed up after a press in the page");
        return "closed";
      } finally {
        // A panel left open would hide the pane for every step after this one.
        if (up()) await surface.close?.();
        await sleep(500);
      }
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

    // ---- the companion gets out of the way, and comes back ----
    // The one surface whose contract is not "the page hides for it" but "it
    // hides for the page" — it unmounts entirely while a browser tab is in
    // front, because a mascot parked on a native view does not float above it,
    // it blanks it.
    //
    // Every other surface in the registry is exercised by exerciseSurface,
    // which opens it and checks the PAGE moved. That loop cannot express this
    // one: there is nothing to open, the companion is simply always there, and
    // "the page hid for it" is the failure rather than the pass.
    //
    // It needs its own step for a second reason. The bug this replaced was a
    // deadlock — the companion hid on "is a view shown", the host hid the view
    // on "is anything painted over it", and the two settled on a mascot in the
    // corner over a page that never appeared, from the first frame, forever.
    // No unit test of either side alone can see that; it only exists where the
    // two run against each other, which is here.
    await step("companion", "The companion stands aside for a browser tab", async () => {
      // A skip here is reported as an ok step, so each one also goes into the
      // run's notes: "the companion stands aside — passed" over a check that
      // never ran is the exact shape of reassurance this suite exists to
      // refuse.
      const skip = (why: string) => {
        notes.push(`companion: not tested — ${why}`);
        return `skipped — ${why}`;
      };
      if (!getSettings().companionEnabled) {
        return skip("the companion is switched off in this profile");
      }
      const pane = view()?.hostRect ?? null;
      // Establish it is really on screen first, with the tab in the back. A
      // companion that never renders at all would otherwise satisfy "not over
      // the page" without anything having been tested.
      window.dispatchEvent(new CustomEvent("menu:new-terminal"));
      await until(
        "the page stayed on screen after another tab took the front",
        view,
        (v) => v?.shown !== true,
        DEADLINE.nav,
        viewSays,
      );
      if (!(await settle(() => painting(".companion")))) {
        return skip("the companion never appeared even with no browser tab in front");
      }
      if (!coversPane(".companion", pane)) {
        // Parked somewhere the page does not reach — dragged into the rail, or
        // a window too small for the default corner to land in the pane. The
        // page was right not to move, and so was the companion.
        return skip("the companion sits clear of the pane in this window");
      }

      // Back to the browser tab: the whole of the ask, in one line each.
      for (let i = 0; i < 6 && view()?.shown !== true; i++) {
        window.dispatchEvent(new CustomEvent(i % 2 === 0 ? "menu:prev-tab" : "menu:next-tab"));
        for (let w = 0; w < 30 && view()?.shown !== true; w++) await sleep(50);
      }
      const gone = await settle(() => !painting(".companion"));
      // The page second, and deliberately so: if the companion stayed, this is
      // what says the consequence was real rather than cosmetic.
      await until(
        "the page never came back — the companion is still standing on it",
        view,
        (v) => v?.shown === true,
        DEADLINE.show,
        viewSays,
      );
      if (!gone) {
        throw new StepFailure(
          "the companion was still painted over the page after its tab came to the front",
        );
      }
      return "stood aside for the tab, and was back when it left";
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
      // Asserted on the signal stream rather than by polling for the moment
      // the frame is null. That window is real but tiny — the host drops the
      // frame and the next pass photographs the new page ~16ms later — so a
      // 25ms poll usually misses it, and the step then failed for a contract
      // that had in fact been kept. The signals are the record, and what
      // actually matters is the order: the old frame went, and the frame now
      // on screen was taken after the navigation, not before it.
      const mark = signals.length;
      await ipc.browserNavigate(v.tabId, `${cfg.url}?again=1`);
      await until(
        "the page never reported the navigation",
        () => since(mark).some((s) => s.t === "nav" && s.loading),
        (seen) => seen,
        DEADLINE.nav,
        () => viewSays(view()),
      );
      const ms = await until(
        "no frame was captured after the navigation",
        () =>
          since(mark).some((s) => s.t === "capture" && s.result === "ok") &&
          view()?.hasFrame === true,
        (ok) => ok,
        DEADLINE.nav,
        () => viewSays(view()),
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

    // ---- the default engine ----
    // Everything above is the webview engine, asked for by name. This is the
    // one people actually get, and the reason it is the default: an iframe is
    // ordinary DOM, so a panel over it covers the part it covers and the rest
    // of the page stays on screen. The webview engine cannot do that at all —
    // a child webview is composited above the window with no z-order API, and
    // is not drawn while it is covered.
    //
    // Measured on pixels rather than state, because there is no view state to
    // read: under the proxy there is nothing to hide, which IS the claim.
    await step("proxy-default", "Under the default engine a panel does not blank the page", async () => {
      updateSettings({ browserEngine: "proxy" });
      refreshBrowserViews();
      // Let the native views go before framing anything. An iframe drawn over
      // a live child webview is a real fault the watchdog is right to report;
      // here it would only be this step changing engines underneath itself.
      await settle(() => browserViewSnapshots().length === 0, 10_000);
      window.dispatchEvent(
        new CustomEvent("canopy:agent-action", {
          detail: { projectId, action: { kind: "open_preview", url: `${cfg.url}?proxy=1` } },
        }),
      );
      const frame = await settle(
        () => !!document.querySelector<HTMLIFrameElement>("iframe.preview-frame"),
        20_000,
      );
      if (!frame) return "skipped — no proxy preview came up to measure";
      await sleep(2500);
      const el = document.querySelector<HTMLIFrameElement>("iframe.preview-frame")!;
      const peek = OVERLAY_SURFACES.find((s) => s.id === "side-peek");
      await peek?.open?.();
      await sleep(900);
      const covered = await samplePane(el.getBoundingClientRect());
      if (peek) await ensureClosed(peek);
      if (typeof covered === "string") {
        notes.push(`advisory: proxy pixels not sampled — ${covered}`);
        return `not sampled (${covered})`;
      }
      const pct = (n: number) => `${Math.round(n * 100)}%`;
      if (covered.page <= 0.02) {
        throw new StepFailure(
          `the page was not on screen with a panel open — page=${pct(covered.page)} white=${pct(covered.white)}`,
        );
      }
      return `page=${pct(covered.page)} white=${pct(covered.white)} with a panel open`;
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
    const appeared = await settle(() => painting(surface.selector));
    if (!appeared) {
      // Undo the ask anyway. Half of these surfaces are toggles, and one that
      // was merely slow to arrive would otherwise land after we stopped
      // looking and sit over the page for every check that follows.
      await ensureClosed(surface, true);
      return { ...base, skipped: true, why: surface.why ?? "the surface never appeared" };
    }
    // A surface that opens somewhere else entirely — a menu hanging off the tab
    // bar, a chip in a corner — must NOT hide the page, and demanding that it
    // does would be demanding a bug. Give it a moment to finish arriving first:
    // most of these slide, and where it starts is not where it ends up.
    const over = await settle(() => coversPane(surface.selector, pane));
    if (!over) {
      await ensureClosed(surface, true);
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
async function ensureClosed(surface: OverlaySurface, force = false) {
  // Already gone: calling the closer again would re-open every surface whose
  // opener and closer are the same toggle. `force` is for the other case —
  // an opener that has been fired and not yet taken effect, which has to be
  // undone precisely because nothing is on screen to see it happen.
  if (!force && !painting(surface.selector)) return;
  const gone = () => settle(() => !painting(surface.selector), 2_000);
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
