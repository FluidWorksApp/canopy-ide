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

const nav = (url: string, ptyId?: number | null) => ({ url, ptyId, navigating: true });
const act = (ptyId?: number | null) => ({ ptyId, navigating: false });

describe("pickBrowserTab", () => {
  it("never hands one agent another agent's page, even on the same origin", () => {
    const tabs: Tab[] = [{ id: "a", url: "http://localhost:3000/", initiatorPtyId: 1 }];
    expect(pickBrowserTab(tabs, nav("http://localhost:3000/login", 2), "a")).toBeUndefined();
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

  it("leaves a session-less op with every preview to choose from", () => {
    const tabs: Tab[] = [{ id: "theirs", url: "http://localhost:3000/", initiatorPtyId: 1 }];
    expect(pickBrowserTab(tabs, act(null), null)?.id).toBe("theirs");
  });
});
