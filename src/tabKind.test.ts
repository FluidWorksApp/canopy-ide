import { describe, expect, it } from "vitest";
import { tabKind } from "./tabKind";
import type { SubTab } from "./components/ProjectView/helpers";

/** Fixtures carry only the fields tabKind actually reads. The cast is the
 *  point: a SubTab has fifteen shapes and twenty fields, and spelling a whole
 *  PrInfo out to assert on the word "pull request" would test the fixture. */
const tab = (t: Record<string, unknown>) => tabKind(t as unknown as SubTab);

describe("what a switcher card says it is", () => {
  it("calls a terminal running a CLI an agent, because that is what it is", () => {
    // The failure this fixes: every running agent read "terminal · canopy",
    // which describes the container and not the contents. A session IS a pty —
    // the "agent" type is the workspace view of one, not the session.
    expect(tab({ type: "terminal", cwd: "/repo", command: "claude --resume x" })).toEqual({
      label: "agent",
      tone: "agent",
      detail: "claude",
    });
    expect(tab({ type: "terminal", cwd: "/repo", command: "codex" }).detail).toBe("codex");
  });

  it("keeps the workspace card distinct from the session card", () => {
    // Both are "that agent"; one is what it is doing, the other is what it has
    // changed. Two cards reading identically would be worse than either.
    expect(tab({ type: "agent", agent: "codex", cwd: "/repo" })).toEqual({
      label: "workspace",
      tone: "agent",
      detail: "codex",
    });
  });

  it("tells a shell from a run, which are different rails and different jobs", () => {
    // No CLI in the command line: a shell you drive.
    expect(tab({ type: "terminal", cwd: "/a/canopy" }).label).toBe("terminal");
    expect(tab({ type: "terminal", cwd: "/a/canopy", run: true }).label).toBe("run");
    expect(tab({ type: "terminal", cwd: "/a/canopy" }).detail).toBe("canopy");
  });

  it("gives a file its directory, because three index.ts are three files", () => {
    const k = tab({ type: "file", file: { path: "/repo/src/skins/index.ts" } });
    expect(k).toEqual({ label: "file", tone: "doc", detail: "skins" });
  });

  it("reads a Windows path the same way", () => {
    expect(tab({ type: "file", file: { path: "C:\\repo\\src\\skins\\index.ts" } }).detail).toBe(
      "skins",
    );
    expect(tab({ type: "terminal", cwd: "C:\\Users\\coraa\\Project" }).detail).toBe("Project");
  });

  it("names the host of a browser tab and nothing when there isn't one", () => {
    expect(tab({ type: "preview", url: "http://localhost:5173/x" }).detail).toBe(
      "localhost:5173",
    );
    expect(tab({ type: "preview", url: "" }).detail).toBe("");
    // A URL that doesn't parse says nothing rather than showing the wreckage.
    expect(tab({ type: "preview", url: "not a url" }).detail).toBe("");
  });

  it("groups by what a tab is for, not by what renders it", () => {
    // The whole point of six tones over fifteen types: these four are one
    // decision — "is this code review" — and share a colour.
    const review = ["pr", "commit", "branch"].map(
      (type) => tab({ type, repo: "/x/canopy", pr: {}, review: {} }).tone,
    );
    expect(new Set(review)).toEqual(new Set(["review"]));
    expect(tab({ type: "note", noteId: "1", title: "n" }).tone).toBe("doc");
    expect(tab({ type: "research", researchId: "1", title: "r" }).tone).toBe("doc");
    expect(tab({ type: "mcp", server: {} }).tone).toBe("external");
    expect(tab({ type: "chat", peer: null, name: "all" }).tone).toBe("people");
  });

  it("says who a chat is with, and 'everyone' for the room", () => {
    expect(tab({ type: "chat", peer: null, name: "Team" }).detail).toBe("everyone");
    // A DM's title is already the person's name.
    expect(tab({ type: "chat", peer: "u1", name: "Sam" }).detail).toBe("");
  });
});
