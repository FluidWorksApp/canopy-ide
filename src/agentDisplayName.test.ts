import { describe, expect, it } from "vitest";
import { agentDisplayName, tabNamesByPty } from "./agentDisplayName";

describe("agentDisplayName", () => {
  it("shows the name the user typed on the tab", () => {
    expect(
      agentDisplayName({
        tab: { title: "✳ Fix the login redirect", customTitle: "auth work" },
        agentLabel: "claude",
        sessionTitle: "claude",
      }),
    ).toBe("auth work");
  });

  it("shows what the CLI titled its own tab", () => {
    // The whole point: six claude rows become six different sentences.
    expect(
      agentDisplayName({
        tab: { title: "✳ Fix browser screenshots" },
        agentLabel: "claude",
      }),
    ).toBe("✳ Fix browser screenshots");
  });

  it("keeps the CLI's name while its tab is still a bare shell", () => {
    for (const title of ["shell", "zsh", "-bash", "", "   "])
      expect(agentDisplayName({ tab: { title }, agentLabel: "claude" })).toBe("claude");
  });

  it("keeps the CLI's name when the tab only repeats it", () => {
    expect(agentDisplayName({ tab: { title: "Claude" }, agentLabel: "claude" })).toBe("claude");
  });

  it("prefers the CLI to a tab titled with a directory", () => {
    // Shells commonly title themselves with the cwd; the row already has a
    // directory chip, so that would be the same fact twice and the name never.
    expect(
      agentDisplayName({ tab: { title: "~/Documents/GitHub/canopy" }, agentLabel: "claude" }),
    ).toBe("claude");
  });

  it("honours a rename even to something otherwise generic", () => {
    expect(
      agentDisplayName({ tab: { title: "✳ Fix tests", customTitle: "shell" }, agentLabel: "claude" }),
    ).toBe("shell");
  });

  it("falls back to the session title for a terminal with no tab and no agent", () => {
    expect(agentDisplayName({ sessionTitle: "npm run dev" })).toBe("npm run dev");
  });

  it("never renders an empty row", () => {
    expect(agentDisplayName({})).toBe("shell");
  });
});

describe("tabNamesByPty", () => {
  it("keys tabs that have spawned by their pty, skipping the rest", () => {
    const map = tabNamesByPty([
      { type: "terminal", ptyId: 7, title: "✳ Fix tests" },
      { type: "terminal", ptyId: null, title: "not spawned yet" },
      { type: "file", ptyId: 9, title: "README.md" },
      { type: "terminal", ptyId: 8, title: "zsh", customTitle: "api" },
    ]);
    expect(map.get(7)).toEqual({ title: "✳ Fix tests", customTitle: undefined });
    expect(map.get(8)?.customTitle).toBe("api");
    expect(map.has(9)).toBe(false);
    expect(map.size).toBe(2);
  });
});
