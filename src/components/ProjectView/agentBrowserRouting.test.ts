// Two agents driving browsers are driving two different pages. The bug this
// guards is the quiet one: the ops all succeed, and the second agent's
// navigation simply moves the first agent's page — so one picture in picture
// shows one agent's work under the other's name.
import { describe, expect, it } from "vitest";
import { pickBrowserTab } from "./helpers";

interface Tab {
  id: string;
  url: string;
  initiatorPtyId?: number | null;
}

const nav = (url: string, ptyId?: number | null, currentTabId?: string) => ({
  url,
  ptyId,
  currentTabId,
  navigating: true,
});
const act = (ptyId?: number | null, currentTabId?: string) => ({
  ptyId,
  currentTabId,
  navigating: false,
});

describe("pickBrowserTab", () => {
  it("never hands one agent another agent's page, even on the same origin", () => {
    const tabs: Tab[] = [{ id: "a", url: "http://localhost:3000/", initiatorPtyId: 1 }];
    expect(pickBrowserTab(tabs, nav("http://localhost:3000/login", 2), "a")).toBeUndefined();
  });

  it("sends a navigation back to a page the session already has open", () => {
    // The session is on B and asks for A's origin: that is a return to a page it
    // owns, not a reason to navigate the page it is looking at onto a new site.
    const tabs: Tab[] = [
      { id: "A", url: "http://localhost:3000/one", initiatorPtyId: 5 },
      { id: "B", url: "http://localhost:4000/two", initiatorPtyId: 5 },
    ];
    expect(pickBrowserTab(tabs, nav("http://localhost:3000/deep", 5, "B"), null)?.id).toBe("A");
    // And leaves it where it is when the current page already serves that origin.
    expect(pickBrowserTab(tabs, nav("http://localhost:4000/deep", 5, "B"), null)?.id).toBe("B");
  });

  it("ignores a current tab that belongs to another session", () => {
    const tabs: Tab[] = [
      { id: "theirs", url: "http://localhost:3000/a", initiatorPtyId: 1 },
      { id: "mine", url: "http://localhost:4000/b", initiatorPtyId: 7 },
    ];
    expect(pickBrowserTab(tabs, act(7, "theirs"), null)?.id).toBe("mine");
  });

  it("keeps an agent on the tab it already owns", () => {
    const tabs: Tab[] = [
      { id: "free", url: "http://localhost:3000/", initiatorPtyId: null },
      { id: "mine", url: "http://localhost:9999/", initiatorPtyId: 7 },
    ];
    // Even where a free tab matches the requested origin — the session's own
    // page is the one it has been looking at.
    expect(pickBrowserTab(tabs, nav("http://localhost:3000/x", 7), null)?.id).toBe("mine");
    expect(pickBrowserTab(tabs, act(7), null)?.id).toBe("mine");
  });

  it("lets an agent with no page of its own claim an unclaimed one", () => {
    const tabs: Tab[] = [
      { id: "theirs", url: "http://localhost:3000/", initiatorPtyId: 1 },
      { id: "free", url: "http://localhost:4000/", initiatorPtyId: null },
    ];
    expect(pickBrowserTab(tabs, nav("http://localhost:4000/y", 2), null)?.id).toBe("free");
  });

  it("prefers an origin match, then the tab in front, within the pool", () => {
    const tabs: Tab[] = [
      { id: "other", url: "http://localhost:4000/" },
      { id: "front", url: "http://localhost:5000/" },
      { id: "match", url: "http://localhost:3000/a" },
    ];
    expect(pickBrowserTab(tabs, nav("http://localhost:3000/b", null), "front")?.id).toBe("match");
    expect(pickBrowserTab(tabs, nav("http://nowhere.test/", null), "front")?.id).toBe("front");
  });

  it("takes over an empty picker tab only for a navigation", () => {
    const tabs: Tab[] = [{ id: "empty", url: "", initiatorPtyId: null }];
    expect(pickBrowserTab(tabs, nav("http://localhost:3000/", 3), null)?.id).toBe("empty");
    // A click or a snapshot with nowhere legitimate to land must report that
    // rather than reach for a page it does not own.
    expect(pickBrowserTab(tabs, act(3), null)).toBeUndefined();
  });

  // A session that calls open_preview twice owns two tabs, and its picture in
  // picture follows the newer one. If an op with no URL of its own kept landing
  // on the older tab, the agent would be clicking a page nobody is watching.
  it("acts on the page a session opened last, not the first one it ever opened", () => {
    const tabs: Tab[] = [
      { id: "first", url: "http://localhost:3000/a", initiatorPtyId: 7 },
      { id: "second", url: "http://localhost:4000/b", initiatorPtyId: 7 },
    ];
    expect(pickBrowserTab(tabs, act(7), null)?.id).toBe("second");
    expect(pickBrowserTab(tabs, nav("http://nowhere.test/", 7), null)?.id).toBe("second");
  });

  it("keeps two same-origin pages of one session apart", () => {
    const tabs: Tab[] = [
      { id: "first", url: "http://localhost:3000/a", initiatorPtyId: 7 },
      { id: "second", url: "http://localhost:3000/b", initiatorPtyId: 7 },
    ];
    // Same origin, so origin matching alone cannot tell them apart: the page
    // the session is on is the answer, for a navigation as for a click.
    expect(pickBrowserTab(tabs, nav("http://localhost:3000/c", 7), null)?.id).toBe("second");
    expect(pickBrowserTab(tabs, act(7, "first"), null)?.id).toBe("first");
    expect(pickBrowserTab(tabs, nav("http://localhost:3000/c", 7, "first"), null)?.id).toBe("first");
  });

  it("does not move a session onto its other page because the user looked at it", () => {
    const tabs: Tab[] = [
      { id: "first", url: "http://localhost:3000/a", initiatorPtyId: 7 },
      { id: "second", url: "http://localhost:4000/b", initiatorPtyId: 7 },
    ];
    // "first" is in front, but the pip — and so the user's read of what this
    // agent is driving — is on "second".
    expect(pickBrowserTab(tabs, act(7, "second"), "first")?.id).toBe("second");
  });

  it("ignores a current tab that has since been closed", () => {
    const tabs: Tab[] = [
      { id: "first", url: "http://localhost:3000/a", initiatorPtyId: 7 },
      { id: "second", url: "http://localhost:4000/b", initiatorPtyId: 7 },
    ];
    expect(pickBrowserTab(tabs, act(7, "gone"), null)?.id).toBe("second");
  });

  it("leaves a session-less op with every preview to choose from", () => {
    const tabs: Tab[] = [{ id: "theirs", url: "http://localhost:3000/", initiatorPtyId: 1 }];
    expect(pickBrowserTab(tabs, act(null), null)?.id).toBe("theirs");
  });
});
