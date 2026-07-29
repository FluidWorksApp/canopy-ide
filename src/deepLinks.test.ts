import { describe, it, expect } from "vitest";
import {
  followLink,
  formatDeepLink,
  parseDeepLink,
  projectForLink,
  type DeepLink,
  type FollowContext,
} from "./deepLinks";

/** A workspace shaped like the router sees it: two projects, one of which has a
 *  component nested inside the other's root. */
const projects = [
  { id: "outer", components: [{ path: "/src" }] },
  { id: "inner", components: [{ path: "/src/api" }, { path: "/other" }] },
];

describe("round trip", () => {
  const cases: DeepLink[] = [
    { kind: "app" },
    { kind: "project", projectId: "p1" },
    { kind: "project", path: "/src/api" },
    { kind: "terminal", ptyId: 12, path: "/src/api" },
    { kind: "terminal", ptyId: 0 },
    { kind: "panel", panel: "tasks", projectId: "p1", path: "/src" },
    { kind: "chat", peer: "ab12" },
    { kind: "chat", peer: null },
    { kind: "file", path: "/src/api/main.rs", line: 40 },
    { kind: "file", path: "/src/api/main.rs" },
  ];
  for (const link of cases) {
    it(`survives ${formatDeepLink(link)}`, () => {
      expect(parseDeepLink(formatDeepLink(link))).toEqual(link);
    });
  }

  it("keeps paths with spaces and unicode intact", () => {
    const link: DeepLink = {
      kind: "file",
      path: "/Users/me/My Projects/café/main.rs",
      line: 3,
    };
    expect(parseDeepLink(formatDeepLink(link))).toEqual(link);
  });
});

describe("parseDeepLink", () => {
  it("rejects anything that isn't ours", () => {
    expect(parseDeepLink("https://example.com/project?id=p1")).toBeNull();
    expect(parseDeepLink("not a url at all")).toBeNull();
    expect(parseDeepLink("")).toBeNull();
  });

  it("rejects an unknown kind rather than guessing", () => {
    expect(parseDeepLink("canopy://settings?tab=agents")).toBeNull();
  });

  it("accepts the authority-less form a shell might leave behind", () => {
    expect(parseDeepLink("canopy:project?id=p1")).toEqual({
      kind: "project",
      projectId: "p1",
    });
  });

  it("drops a terminal link with no terminal in it", () => {
    // `Number(null)` is 0 — a perfectly good pty id — so a missing parameter
    // must not read as terminal 0.
    expect(parseDeepLink("canopy://terminal")).toBeNull();
    expect(parseDeepLink("canopy://terminal?pty=")).toBeNull();
    expect(parseDeepLink("canopy://terminal?pty=abc")).toBeNull();
    expect(parseDeepLink("canopy://terminal?pty=1.5")).toBeNull();
  });

  it("drops a panel link naming a panel that doesn't exist", () => {
    expect(parseDeepLink("canopy://panel?name=nonsense")).toBeNull();
    expect(parseDeepLink("canopy://panel")).toBeNull();
  });

  it("drops a file link with no file", () => {
    expect(parseDeepLink("canopy://file?line=3")).toBeNull();
  });

  it("ignores a line number that isn't one", () => {
    expect(parseDeepLink("canopy://file?path=/a.rs&line=0")).toEqual({
      kind: "file",
      path: "/a.rs",
    });
    expect(parseDeepLink("canopy://file?path=/a.rs&line=nope")).toEqual({
      kind: "file",
      path: "/a.rs",
    });
  });

  it("reads a chat link with no peer as the team conversation", () => {
    expect(parseDeepLink("canopy://chat")).toEqual({
      kind: "chat",
      peer: null,
    });
  });
});

describe("projectForLink", () => {
  it("prefers the id it was given", () => {
    expect(
      projectForLink({ kind: "project", projectId: "inner" }, projects),
    ).toBe("inner");
  });

  it("falls back to the path when the id is stale", () => {
    // The project was deleted between the notification and the click.
    expect(
      projectForLink(
        { kind: "terminal", ptyId: 1, projectId: "gone", path: "/other/x.rs" },
        projects,
      ),
    ).toBe("inner");
  });

  it("picks the most specific component root, not the first match", () => {
    expect(
      projectForLink({ kind: "project", path: "/src/api/deep/file.rs" }, projects),
    ).toBe("inner");
    expect(projectForLink({ kind: "project", path: "/src/web" }, projects)).toBe(
      "outer",
    );
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(
      projectForLink({ kind: "project", path: "/src/apiary/x" }, projects),
    ).toBe("outer");
    expect(
      projectForLink({ kind: "project", path: "/otherwise/x" }, projects),
    ).toBeUndefined();
  });

  it("ignores a trailing slash on either side", () => {
    expect(
      projectForLink({ kind: "project", path: "/src/api/" }, [
        { id: "inner", components: [{ path: "/src/api/" }] },
      ]),
    ).toBe("inner");
  });

  it("resolves nothing for a link with no hints", () => {
    // Team surfaces carry none — the router then uses whichever project is in
    // front rather than refusing to navigate.
    expect(projectForLink({ kind: "chat", peer: null }, projects)).toBeUndefined();
  });
});

describe("followLink", () => {
  const ctx = (over: Partial<FollowContext> = {}): FollowContext => ({
    terminals: [],
    detachedPtys: [],
    members: [],
    ...over,
  });

  it("focuses the terminal the notification came from", () => {
    expect(
      followLink(
        { kind: "terminal", ptyId: 7 },
        ctx({ terminals: [{ id: "t1", ptyId: 7 }] }),
      ),
    ).toEqual({ do: "tab", tabId: "t1" });
  });

  it("finds a terminal by the pty it attached to", () => {
    // A micro-task's tab shows a pty it did not spawn; the notification names
    // the pty, not the tab.
    expect(
      followLink(
        { kind: "terminal", ptyId: 7 },
        ctx({ terminals: [{ id: "t1", ptyId: 99, attachId: 7 }] }),
      ),
    ).toEqual({ do: "tab", tabId: "t1" });
  });

  it("sends a detached run to Tasks — it never had a tab here", () => {
    expect(
      followLink({ kind: "terminal", ptyId: 7 }, ctx({ detachedPtys: [7] })),
    ).toEqual({ do: "panel", panel: "tasks" });
  });

  it("falls back to Agents, saying so, when the terminal has closed", () => {
    const act = followLink({ kind: "terminal", ptyId: 7 }, ctx());
    expect(act).toMatchObject({ do: "panel", panel: "agents" });
    expect(act.do === "panel" && act.note).toBeTruthy();
  });

  it("does not mistake an unspawned tab for the target", () => {
    expect(
      followLink(
        { kind: "terminal", ptyId: 7 },
        ctx({ terminals: [{ id: "t1", ptyId: null }] }),
      ),
    ).toMatchObject({ do: "panel", panel: "agents" });
  });

  it("opens a DM with a member who is still connected", () => {
    expect(
      followLink(
        { kind: "chat", peer: "ab12" },
        ctx({ members: [{ key: "ab12", name: "Ada" }] }),
      ),
    ).toEqual({ do: "chat", peer: "ab12", name: "Ada" });
  });

  it("falls back to the Team panel when the peer has left", () => {
    const act = followLink({ kind: "chat", peer: "ab12" }, ctx());
    expect(act).toMatchObject({ do: "panel", panel: "team" });
    expect(act.do === "panel" && act.note).toBeTruthy();
  });

  it("opens the team conversation with no members at all", () => {
    // The team channel is not a peer — it exists whether or not anyone else is
    // currently connected.
    expect(followLink({ kind: "chat", peer: null }, ctx())).toEqual({
      do: "chat",
      peer: null,
      name: "Team",
    });
  });

  it("opens a panel link as-is", () => {
    expect(followLink({ kind: "panel", panel: "tasks" }, ctx())).toEqual({
      do: "panel",
      panel: "tasks",
    });
  });

  it("carries a file's line through", () => {
    expect(
      followLink({ kind: "file", path: "/a.rs", line: 12 }, ctx()),
    ).toEqual({ do: "file", path: "/a.rs", line: 12 });
  });

  it("does nothing more for a project link — it is already open", () => {
    expect(followLink({ kind: "project", projectId: "p" }, ctx())).toEqual({
      do: "nothing",
    });
    expect(followLink({ kind: "app" }, ctx())).toEqual({ do: "nothing" });
  });
});
