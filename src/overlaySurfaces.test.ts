import { describe, expect, it } from "vitest";
import {
  OVERLAY_SURFACES,
  REGISTERED_OVERLAY_SELECTOR,
  drivableSurfaces,
  isRegisteredOverlay,
} from "./overlaySurfaces";
import { PAINTED_OVERLAY_SELECTOR } from "./browserOcclusion";

describe("the overlay registry", () => {
  it("has a unique id per surface", () => {
    const ids = OVERLAY_SURFACES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses selectors the DOM can actually parse", () => {
    for (const s of OVERLAY_SURFACES) {
      expect(() => document.querySelectorAll(s.selector)).not.toThrow();
    }
    expect(() => document.querySelectorAll(REGISTERED_OVERLAY_SELECTOR)).not.toThrow();
  });

  // The contract for adding an overlay: either the selftest can drive it, or
  // the registry says in words why it can't. Silence is the one thing that
  // isn't allowed — that is how a surface ships untested.
  it("either drives a surface or says why not", () => {
    for (const s of OVERLAY_SURFACES) {
      if (!s.open) expect(s.why, `${s.id} has no opener and no reason`).toBeTruthy();
    }
  });

  it("gives everything it can open a way to close it", () => {
    for (const s of drivableSurfaces()) {
      expect(s.close, `${s.id} opens but never closes`).toBeTruthy();
    }
  });

  // The backstop list in browserOcclusion covers surfaces that paint without
  // taking clicks — the ones structure cannot see. Every one of them is a real
  // overlay, so every one of them must be registered, or the dev warning that
  // points at this registry would be pointing at a hole.
  it("covers every surface the occlusion backstop knows about", () => {
    const registered = new Set(OVERLAY_SURFACES.map((s) => s.selector));
    for (const cls of PAINTED_OVERLAY_SELECTOR.split(",")) {
      expect(registered.has(cls), `${cls} paints over the browser but isn't registered`).toBe(true);
    }
  });

  it("recognises a registered surface and its children", () => {
    document.body.innerHTML = `<div class="side-peek"><button id="inner">x</button></div><div class="stranger"></div>`;
    expect(isRegisteredOverlay(document.querySelector(".side-peek")!)).toBe(true);
    expect(isRegisteredOverlay(document.getElementById("inner")!)).toBe(true);
    expect(isRegisteredOverlay(document.querySelector(".stranger")!)).toBe(false);
    document.body.innerHTML = "";
  });
});
