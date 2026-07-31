// A snapshot must not hand back what the vault promised never to show.
//
// canopy_vault_fill's whole contract is "Canopy types the password into the
// page's own fields; you never see it". The fill honours that — but a snapshot
// taken afterwards reads every input's `value`, so the secret came straight
// back out through a different door, into the agent's context and its
// transcript. This drives the real injected picker to prove it does not.
import { beforeEach, describe, expect, it, vi } from "vitest";
import SCRIPT from "../src-tauri/src/preview_picker.js?raw";

interface Bridge {
  run: (d: Record<string, unknown>) => { done: boolean; ok?: boolean; data?: { elements?: Entry[] } };
  drain: () => Record<string, unknown>[];
}
interface Entry {
  tag: string;
  type?: string;
  value?: string;
  text?: string;
}

const bridge = (): Bridge => (window as unknown as { __canopyBrowser: Bridge }).__canopyBrowser;

/** jsdom lays nothing out, and the picker skips anything with no box. Give
 *  every element a box so the snapshot walks the page it was handed. */
function withLayout() {
  const rect = { x: 0, y: 0, width: 120, height: 20, top: 0, left: 0, bottom: 20, right: 120 };
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([
    rect,
  ] as unknown as DOMRectList);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
}

// A snapshot is read-only, so run() answers inline rather than through the outbox.
const snapshot = (): Entry[] =>
  bridge().run({ op: "snapshot", id: "s1", max: 50 })?.data?.elements ?? [];

describe("preview picker: snapshots and secrets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.innerHTML = "<head></head><body></body>";
    const w = window as unknown as Record<string, unknown>;
    w.__canopyNativeBrowser = true;
    delete w.__canopyPicker;
    delete w.__canopyBrowser;
    new Function(SCRIPT)();
    bridge().drain();
    withLayout();
  });

  it("never reports the contents of a password field", () => {
    document.body.innerHTML = `
      <form>
        <input name="username" type="text" value="audit@example.com">
        <input name="password" type="password" placeholder="Enter password" value="hunter2">
      </form>`;
    const els = snapshot();
    const pw = els.find((e) => e.type === "password");
    const user = els.find((e) => e.type === "text");

    expect(JSON.stringify(els)).not.toContain("hunter2");
    // The useful part survives: the agent can still tell a filled field from
    // an empty one, which is what it needs to know after a fill.
    expect(pw?.value).toBe("••••••••");
    // Non-secret fields are untouched — masking everything would make the
    // snapshot useless for ordinary forms.
    expect(user?.value).toBe("audit@example.com");
  });

  it("says a password field is empty when it is", () => {
    document.body.innerHTML = `<input type="password" placeholder="Enter password">`;
    expect(snapshot().find((e) => e.type === "password")?.value).toBe("");
  });

  it("does not leak the password through the element's label either", () => {
    // No placeholder, no aria-label, no title: labelFor falls back to the
    // input's own value, which for a password field is the secret.
    document.body.innerHTML = `<input type="password" value="hunter2">`;
    const els = snapshot();
    expect(JSON.stringify(els)).not.toContain("hunter2");
    expect(els.find((e) => e.type === "password")?.text).toBe("");
  });
});
