// Every surface in the app that can be painted over the embedded browser.
//
// The occlusion detector (browserOcclusion.ts) deliberately does NOT consult a
// list — it decides structurally, which is the only version that stays correct
// as surfaces are added. This registry is not that list and must never become
// it. It answers a different question: which surfaces does anyone KNOW about,
// so that a test can open each one and check the browser got out of the way?
//
// Two consumers:
//
//   * the selftest (selftest/browserSelftest.ts) walks this list, opens each
//     entry, and asserts the hide/freeze/show contract for it. An entry with no
//     programmatic opener is reported as an untested gap, not as a pass.
//   * the dev-mode warning in browserHost: an element that occludes a visible
//     browser and matches nothing here is a surface somebody added without
//     telling anybody. It still works — structure caught it — but nothing tests
//     it, so it says so, loudly, in the console.
//
// The contract for adding an overlay: add an entry here. If it can be opened
// and closed from code, say how, and the selftest covers it from then on. If it
// cannot, say why in `why` — an honest gap beats a silent one.

/** How long the surface stays up on its own. */
export type OverlayKind = "transient" | "persistent";

export interface OverlaySurface {
  /** Stable across renames of the component that renders it. */
  id: string;
  label: string;
  /** The painted root, as a selector. Registry membership is asked of this, and
   *  the watchdog's own overlap sampler measures these rectangles — so it must
   *  match the box that actually paints, not the layer that positions it. */
  selector: string;
  kind: OverlayKind;
  /** Whether it reaches the middle of the content area (where a preview pane
   *  sits) or only an edge. Edge surfaces still occlude a full-bleed preview. */
  covers: "center" | "edge";
  /** Put it on screen without a user. Absent = the selftest cannot exercise
   *  this surface; `why` must then say what stops it. */
  open?: () => unknown;
  /** Take it back off. Absent alongside `open` means it dismisses itself. */
  close?: () => unknown;
  /** Why there is no opener, or what the opener depends on. */
  why?: string;
}

const fire = (name: string, detail?: unknown) =>
  window.dispatchEvent(new CustomEvent(name, { detail }));

const escape = () =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );

/** Click something the app already renders. Returns false when it isn't there,
 *  which is a skip rather than a failure — the launcher menu needs a pane bar,
 *  the workspace overlay needs an agent. */
function click(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;
  el.click();
  return true;
}

export const OVERLAY_SURFACES: OverlaySurface[] = [
  {
    // The one that started all of this: not a dialog, not a menu, carrying none
    // of the classes the first detector looked for, and the app's most-used
    // floating surface. It slides in over 340ms, which is the other half of the
    // story — see the sweep in browserHost.
    id: "side-peek",
    label: "Side panel (peek)",
    selector: ".side-peek",
    kind: "persistent",
    covers: "center",
    open: () => fire("menu:toggle-sidebar"),
    close: () => fire("menu:toggle-sidebar"),
  },
  {
    id: "command-palette",
    label: "Quick Open",
    selector: ".palette-backdrop",
    kind: "persistent",
    covers: "center",
    open: () => fire("menu:quick-open"),
    // The palette's Escape lives on its input, not on window, so the backdrop
    // is what dismisses it from here.
    close: () =>
      document
        .querySelector(".palette-backdrop")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  },
  {
    id: "find-in-files",
    label: "Find in Files",
    selector: ".palette-backdrop",
    kind: "persistent",
    covers: "center",
    open: () => fire("menu:find-in-files"),
    close: () =>
      document
        .querySelector(".palette-backdrop")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  },
  {
    id: "spot-search",
    label: "SpotSearch",
    selector: ".palette-backdrop",
    kind: "persistent",
    covers: "center",
    open: () => fire("menu:spot-search"),
    close: () =>
      document
        .querySelector(".palette-backdrop")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  },
  {
    id: "settings-dialog",
    label: "Settings",
    selector: ".confirm-backdrop",
    kind: "persistent",
    covers: "center",
    open: () => fire("canopy:open-settings", { tab: "appearance" }),
    close: escape,
  },
  {
    id: "context-menu",
    label: "Context menu",
    selector: ".ctx-menu",
    kind: "persistent",
    covers: "center",
    open: () => {
      const host = document.querySelector<HTMLElement>(".pane-bar .tab");
      if (!host) return;
      const r = host.getBoundingClientRect();
      host.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: Math.round(r.x + r.width / 2),
          clientY: Math.round(r.y + r.height / 2),
        }),
      );
    },
    // ContextMenu closes itself on window resize, which is the only dismissal
    // that doesn't need to guess where the menu is.
    close: () => window.dispatchEvent(new Event("resize")),
  },
  {
    id: "cli-menu",
    label: "Launcher menu (＋▾)",
    selector: ".cli-menu",
    kind: "persistent",
    covers: "center",
    // Its own button is the toggle. The menu also closes on mouseleave, but
    // that is a React synthetic event derived from mouseout — dispatching a
    // bare `mouseleave` at the node does nothing at all, which is exactly the
    // kind of thing a registry entry is for saying out loud.
    open: () => {
      click(".cli-menu-anchor > button");
    },
    close: () => {
      click(".cli-menu-anchor > button");
    },
    why: "Needs a pane bar with the launcher — skipped when it isn't rendered.",
  },
  {
    id: "status-menu",
    label: "Status bar menu",
    selector: ".status-menu",
    kind: "persistent",
    covers: "edge",
    open: () => {
      click(".status-stats-btn");
    },
    close: () => {
      click(".status-stats-btn");
    },
    why: "Needs the status bar's stats button — skipped when it isn't rendered.",
  },
  {
    id: "tooltip",
    label: "Tooltip",
    selector: ".cnp-tooltip",
    kind: "transient",
    covers: "edge",
    // Two triggers, one bubble: the hand-written <Tooltip> wrapper, and any
    // element carrying a `title` (TooltipLayer upgrades those). The layer
    // listens for real pointer events on the document, and React derives
    // onMouseEnter from a delegated mouseover — a dispatched `mouseenter` is
    // heard by nobody either way, so fire the bubbling forms. The layer opens
    // after its hover delay; the selftest polls, so that is a wait, not a miss.
    open: () => {
      const el =
        document.querySelector(".cnp-tooltip-wrap") ??
        document.querySelector("[title]");
      el?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    },
    close: () => {
      document.querySelector(".cnp-tooltip-wrap")?.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      // The layer's dismissals are global: a press anywhere takes it down.
      document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    },
  },
  {
    id: "zoom-indicator",
    label: "Zoom chip",
    selector: ".zoom-indicator",
    kind: "transient",
    covers: "center",
    open: () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "=",
          metaKey: true,
          ctrlKey: true,
          bubbles: true,
        }),
      ),
    // Back down rather than to 100%: the zoom level is the user's, and a test
    // that resets it has changed the machine it ran on.
    close: () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "-",
          metaKey: true,
          ctrlKey: true,
          bubbles: true,
        }),
      ),
  },
  {
    id: "zen-hotzone",
    label: "Focus-mode reveal strip",
    selector: ".zen-hotzone",
    kind: "persistent",
    covers: "edge",
    open: () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "Enter",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      ),
    close: escape,
  },
  // ---- known surfaces with no safe programmatic opener ----
  // Each of these is real, occludes, and is covered structurally at runtime.
  // None is exercised by the selftest, and that is stated rather than implied.
  {
    id: "workspace-overlay",
    label: "Agent workspace overlay",
    selector: ".workspace-overlay",
    kind: "persistent",
    covers: "center",
    open: () => {
      click("button.workspace-handle");
    },
    close: escape,
    why: "Only exists while an agent has a workspace — skipped otherwise.",
  },
  {
    id: "notice-toast",
    label: "Notice toast",
    selector: ".notice",
    kind: "transient",
    covers: "edge",
    why: "Raised by App's notify() through a prop; no event opens one from outside a component.",
  },
  {
    id: "update-toast",
    label: "Update toast",
    selector: ".update-toast",
    kind: "persistent",
    covers: "edge",
    why: "Needs a real update to be available.",
  },
  {
    id: "dictation-pill",
    label: "Dictation pill",
    selector: ".dictation-pill",
    kind: "persistent",
    covers: "center",
    why: "Its opener starts a real microphone recording; not something a test may do.",
  },
  {
    id: "coach-layer",
    label: "Coachmark",
    selector: ".coach-layer",
    kind: "persistent",
    covers: "center",
    why: "Shows itself once per machine from localStorage; can't be summoned on demand.",
  },
  {
    id: "hibernation",
    label: "Hibernation / freeze overlay",
    selector: ".hib-layer",
    kind: "persistent",
    covers: "center",
    why: "Opening it tears the project down, which ends the run it is part of.",
  },
  {
    id: "confirm-dialog",
    label: "Confirm dialog",
    selector: ".dlg-scrim",
    kind: "persistent",
    covers: "center",
    why: "Only a destructive or outward-facing action opens it, and the test takes none.",
  },
  {
    id: "modal-dialog",
    label: "Project / share dialogs",
    selector: ".modal-backdrop",
    kind: "persistent",
    covers: "center",
    why: "Opened from the native menu or a button that needs a project state the test doesn't have.",
  },
];

/** Everything registered, as one selector. Used for membership, never for
 *  occlusion — occlusion stays structural. */
export const REGISTERED_OVERLAY_SELECTOR = OVERLAY_SURFACES.map(
  (s) => s.selector,
)
  .filter((s, i, all) => all.indexOf(s) === i)
  .join(",");

/** Is this element (or the surface it sits inside) one somebody registered? */
export function isRegisteredOverlay(el: Element): boolean {
  return !!el.closest(REGISTERED_OVERLAY_SELECTOR);
}

/** The entries the selftest can actually drive. */
export function drivableSurfaces(): OverlaySurface[] {
  return OVERLAY_SURFACES.filter((s) => !!s.open);
}
