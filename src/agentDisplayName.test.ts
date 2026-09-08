import { describe, expect, it } from "vitest";
import {
  agentDisplayName,
  tabNamesByPty,
  terminalDisplayName,
} from "./agentDisplayName";

describe("agentDisplayName", () => {
  it("uses the Canopy-assigned name ahead of CLI title and cwd", () => {
    expect(
      agentDisplayName({
        tab: { nativeName: "Juniper", oscTitle: "✳ Fix the login redirect" },
        sessionName: "Ember",
        sessionTitle: "codex",
        cwd: "/work/canopy",
      }),
    ).toBe("Juniper");
  });

  it("uses the published task title ahead of a generated session name", () => {
    expect(
      agentDisplayName({
        tab: { nativeName: "Moss", agentName: "Fix Codex task status", oscTitle: "codex" },
      }),
    ).toBe("Fix Codex task status");
  });

  it("uses the native session name when there is no mounted tab", () => {
    expect(
      agentDisplayName({
        sessionName: "Ember",
        sessionTitle: "codex",
        cwd: "/work/canopy",
      }),
    ).toBe("Ember");
  });

  it("shows the name the user typed on the tab", () => {
    expect(
      agentDisplayName({
        tab: { oscTitle: "✳ Fix the login redirect", userName: "auth work" },
        agentLabel: "claude",
        sessionTitle: "claude",
      }),
    ).toBe("auth work");
  });

  it("shows what the CLI titled its own tab", () => {
    // The whole point: six claude rows become six different sentences.
    expect(
      agentDisplayName({
        tab: { oscTitle: "✳ Fix browser screenshots" },
        agentLabel: "claude",
      }),
    ).toBe("✳ Fix browser screenshots");
  });

  it("keeps the CLI's name while its tab is still a bare shell", () => {
    for (const title of ["shell", "zsh", "-bash", "", "   "])
      expect(agentDisplayName({ tab: { oscTitle: title }, agentLabel: "claude" })).toBe("claude");
  });

  it("keeps the CLI's name when the tab only repeats it", () => {
    expect(agentDisplayName({ tab: { oscTitle: "Claude" }, agentLabel: "claude" })).toBe("claude");
  });

  it("prefers the CLI to a tab titled with a directory", () => {
    // Shells commonly title themselves with the cwd; the row already has a
    // directory chip, so that would be the same fact twice and the name never.
    expect(
      agentDisplayName({ tab: { oscTitle: "~/Documents/GitHub/canopy" }, agentLabel: "claude" }),
    ).toBe("claude");
  });

  it("honours a rename even to something otherwise generic", () => {
    expect(
      agentDisplayName({ tab: { oscTitle: "✳ Fix tests", userName: "shell" }, agentLabel: "claude" }),
    ).toBe("shell");
  });

  it("falls back to the session title for a terminal with no tab and no agent", () => {
    expect(agentDisplayName({ sessionTitle: "npm run dev" })).toBe("npm run dev");
  });

  it("falls back from a generic CLI title to the cwd basename", () => {
    expect(agentDisplayName({ sessionTitle: "zsh", cwd: "/work/canopy" })).toBe("canopy");
  });

  it("never renders an empty row", () => {
    expect(agentDisplayName({})).toBe("shell");
  });
});

describe("terminalDisplayName", () => {
  it("uses assigned names for agents and numbered labels for shells", () => {
    expect(terminalDisplayName({ id: 7, name: "Piper", agent: true })).toBe("Piper");
    expect(terminalDisplayName({ id: 7, agent: true })).toBe("Terminal 7");
    expect(terminalDisplayName({ id: 7, name: "Piper", agent: false })).toBe(
      "Terminal 7",
    );
  });
});

describe("tabNamesByPty", () => {
  it("keys tabs that have spawned by their pty, skipping the rest", () => {
    const map = tabNamesByPty([
      { type: "terminal", ptyId: 7, oscTitle: "✳ Fix tests" },
      { type: "terminal", ptyId: null, oscTitle: "not spawned yet" },
      { type: "file", ptyId: 9, oscTitle: "README.md" },
      { type: "terminal", ptyId: 8, oscTitle: "zsh", userName: "api" },
    ]);
    expect(map.get(7)).toEqual({
      userName: undefined,
      agentName: undefined,
      promptName: undefined,
      nativeName: undefined,
      oscTitle: "✳ Fix tests",
      launchTitle: undefined,
      description: undefined,
    });
    expect(map.get(8)?.userName).toBe("api");
    expect(map.has(9)).toBe(false);
    expect(map.size).toBe(2);
  });
});
