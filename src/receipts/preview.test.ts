// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPreviewEvidence,
  captureBefore,
  capturePreview,
  describeChange,
  previewEvidence,
  readPage,
  resetPreviewEvidenceForTests,
  setPreviewDepsForTests,
  type PreviewDeps,
} from "./preview";
import { buildVerdictPrompt } from "./verdict";
import { receiptMarkdown } from "./markdown";
import { localBrowserOp, resetLocalBrowserOpsForTests, settleLocalBrowserOp } from "../browserLocalOps";
import type { LocalOpResult } from "../browserLocalOps";
import type { ReceiptData } from "./types";

const page = (text: string, elements: { tag: string; text: string }[] = [], title = "Shop", url = "http://localhost:5173/") => ({
  url,
  title,
  text,
  elements,
});

/** A preview whose page and picture are whatever `state` says right now. */
function fakePreview(state: { text: string; elements?: { tag: string; text: string }[]; shot?: boolean; open?: boolean }) {
  const op = vi.fn(async (kind: "screenshot" | "snapshot"): Promise<LocalOpResult> => {
    if (state.open === false) return { ok: false, data: "No preview page is open in this project." };
    if (kind === "snapshot") return { ok: true, data: page(state.text, state.elements ?? []) };
    if (state.shot === false) return { ok: false, data: "This preview tab has never been shown." };
    return { ok: true, data: { image: "iVBORw0KGgo=", width: 1280, height: 800, url: "http://localhost:5173/" } };
  });
  const shrink = vi.fn(async () => ({ image: "data:image/jpeg;base64,AAAA", width: 720, height: 450 }));
  return { op, shrink };
}

let clock = 1_000_000;
beforeEach(() => {
  clock = 1_000_000;
  resetPreviewEvidenceForTests(true);
});
afterEach(() => {
  resetPreviewEvidenceForTests();
  resetLocalBrowserOpsForTests();
});

function use(deps: Partial<PreviewDeps>) {
  setPreviewDepsForTests({ enabled: () => true, now: () => clock, ...deps });
}

describe("readPage", () => {
  it("keeps the page's lines and labelled controls, deduplicated", () => {
    const r = readPage(page("Cart\n\nCart\n  Total  $3 \n…(page text truncated)", [
      { tag: "button", text: "Pay now" },
      { tag: "button", text: "Pay now" },
      { tag: "a", text: "" },
    ]));
    expect(r?.lines).toEqual(["Cart", "Total $3"]);
    expect(r?.controls).toEqual(['button "Pay now"']);
  });

  it("is null for an answer that is not a page", () => {
    expect(readPage("nope")).toBeNull();
    expect(readPage(null)).toBeNull();
  });
});

describe("describeChange", () => {
  it("names new and missing text and controls in plain words", () => {
    const before = readPage(page("Cart\nTotal $3", [{ tag: "button", text: "Checkout" }]))!;
    const after = readPage(page("Cart\nTotal $3\nFree shipping over $50", [{ tag: "button", text: "Pay now" }], "Shop · cart"))!;
    const out = describeChange(before, after);
    expect(out).toContain('The page title changed from "Shop" to "Shop · cart".');
    expect(out).toContain('New text on the page: "Free shipping over $50".');
    expect(out).toContain('New controls: button "Pay now".');
    expect(out).toContain('Controls gone: button "Checkout".');
  });

  it("says nothing when the page reads the same, or a half is missing", () => {
    const a = readPage(page("Same"))!;
    expect(describeChange(a, a)).toEqual([]);
    expect(describeChange(null, a)).toEqual([]);
  });
});

describe("capturePreview", () => {
  it("is null when the project has no preview open — no noise", async () => {
    use(fakePreview({ text: "", open: false }));
    expect(await capturePreview("/repo", 3)).toBeNull();
  });

  it("keeps the page read when the picture cannot be taken, and says why", async () => {
    use(fakePreview({ text: "Hello", shot: false }));
    const cap = await capturePreview("/repo", null);
    expect(cap?.shot).toBeNull();
    expect(cap?.page?.lines).toEqual(["Hello"]);
    expect(cap?.why).toMatch(/never been shown/);
  });

  it("stores a shrunk picture with the page's address and title", async () => {
    use(fakePreview({ text: "Hello" }));
    const cap = await capturePreview("/repo", 4);
    expect(cap?.shot).toMatchObject({ image: "data:image/jpeg;base64,AAAA", width: 720, url: "http://localhost:5173/", title: "Shop", at: clock });
  });
});

describe("before and after a turn", () => {
  it("pairs the picture from the turn's start with one taken for the receipt", async () => {
    const state = { text: "Cart", elements: [{ tag: "button", text: "Checkout" }] };
    use(fakePreview(state));
    await captureBefore({ sessionId: "s1", ptyId: 7, cwd: "/repo" });
    state.text = "Cart\nFree shipping";
    clock += 60_000;
    const p = await previewEvidence({ sessionId: "s1", ptyId: 7, cwd: "/repo", startedAt: 1_000_000 });
    expect(p?.before?.at).toBe(1_000_000);
    expect(p?.after?.at).toBe(1_060_000);
    expect(p?.changes).toEqual(['New text on the page: "Free shipping".']);
    expect(p?.summary).toMatch(/one visible change/);
    expect(p?.note).toBeUndefined();
  });

  it("does not use a picture from an older turn as this turn's before", async () => {
    use(fakePreview({ text: "Cart" }));
    await captureBefore({ sessionId: "s1", ptyId: 7, cwd: "/repo" });
    clock += 10 * 60_000;
    const p = await previewEvidence({ sessionId: "s1", ptyId: 7, cwd: "/repo", startedAt: clock - 1000 });
    expect(p?.before).toBeUndefined();
    expect(p?.after).toBeDefined();
    expect(p?.note).toMatch(/No picture from before/);
  });

  it("records nothing when no preview is open", async () => {
    use(fakePreview({ text: "", open: false }));
    await captureBefore({ sessionId: "s1", ptyId: 7, cwd: "/repo" });
    expect(await previewEvidence({ sessionId: "s1", ptyId: 7, cwd: "/repo", startedAt: clock })).toBeNull();
  });

  it("does nothing when receipts are off, or outside the app", async () => {
    const fake = fakePreview({ text: "x" });
    use({ ...fake, enabled: () => false });
    await captureBefore({ sessionId: "s1", ptyId: 1, cwd: "/repo" });
    expect(await previewEvidence({ sessionId: "s1", ptyId: 1, cwd: "/repo", startedAt: clock })).toBeNull();
    expect(fake.op).not.toHaveBeenCalled();
    resetPreviewEvidenceForTests(false);
    use(fakePreview({ text: "x" }));
    expect(await previewEvidence({ sessionId: "s1", ptyId: 1, cwd: "/repo", startedAt: clock })).toBeNull();
  });
});

describe("the brain and the copy are told what the pictures show", () => {
  const preview = buildPreviewEvidence(
    { shot: null, page: readPage(page("Cart"))!, at: 1 },
    { shot: null, page: readPage(page("Cart\nFree shipping"))!, at: 2 },
  )!;

  it("puts the comparison in the verdict prompt", () => {
    const prompt = buildVerdictPrompt({ asked: "add a free shipping note", diffSummary: "", filesTouched: [], checks: [], tamper: [], packages: [], preview });
    expect(prompt).toContain("## The preview page");
    expect(prompt).toContain('- New text on the page: "Free shipping".');
    expect(buildVerdictPrompt({ asked: "x", diffSummary: "", filesTouched: [], checks: [], tamper: [], packages: [] })).not.toContain("preview page");
  });

  it("carries the summary into the copied receipt", () => {
    const r = { asked: "x", checks: [], tamper: [], packages: [], verdict: null, status: "partial", preview } as unknown as ReceiptData;
    expect(receiptMarkdown(r)).toContain(`**Preview:** ${preview.summary}`);
  });
});

describe("browserLocalOps", () => {
  it("answers a negative id here and never lets it reach the bridge", async () => {
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("canopy:agent-browser", on);
    const pending = localBrowserOp("snapshot", "/repo", { ptyId: 2 });
    const detail = seen[0] as { projectId: null; op: { id: number; quiet: boolean; route: string; ptyId: number } };
    expect(detail.projectId).toBeNull();
    expect(detail.op).toMatchObject({ op: "snapshot", quiet: true, route: "/repo", ptyId: 2 });
    expect(detail.op.id).toBeLessThan(0);
    expect(settleLocalBrowserOp(detail.op.id, true, { url: "u" })).toBe(true);
    expect(await pending).toEqual({ ok: true, data: { url: "u" } });
    expect(settleLocalBrowserOp(5, true, null)).toBe(false);
    window.removeEventListener("canopy:agent-browser", on);
  });

  it("gives up quietly when nothing answers", async () => {
    vi.useFakeTimers();
    try {
      const pending = localBrowserOp("screenshot", "/nowhere", { timeoutMs: 50 });
      vi.advanceTimersByTime(60);
      expect((await pending).ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
