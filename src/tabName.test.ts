import { describe, expect, it } from "vitest";
import {
  tabName,
  namePatch,
  isUserNamed,
  snapshotNames,
  adoptSnapshotNames,
} from "./tabName";

describe("tabName", () => {
  it("shows the user's name over everything else, unfiltered", () => {
    const tab = {
      userName: "shell",
      agentName: "Fix the login redirect",
      promptName: "can you look at auth",
      nativeName: "Moss",
      oscTitle: "✳ Fix the login redirect",
      launchTitle: "claude",
      cwd: "/work/canopy",
    };
    // Even a name that would be filtered out of every other slot: a user who
    // renames a tab to "shell" means it.
    expect(tabName(tab, { agent: true })).toBe("shell");
  });

  it("shows the agent's own name for its run over the CLI that is running it", () => {
    // The case a codex task harness kept losing: canopy_name_task said what the
    // work was and the chip still read "codex".
    expect(
      tabName(
        {
          agentName: "PR 1749 daily duration",
          nativeName: "Moss",
          oscTitle: "codex",
          launchTitle: "codex",
        },
        { agent: true },
      ),
    ).toBe("PR 1749 daily duration");
  });

  it("keeps a configured run's name when the shell repaints over it", () => {
    // The dev-server chip that decayed to /bin/zsh: the shell's title is not a
    // better answer than the name of the thing running.
    expect(
      tabName({ launchTitle: "dashboard dev", oscTitle: "/bin/zsh", run: true }),
    ).toBe("dashboard dev");
  });

  it("refuses an OSC title that says nothing the tab does not already say", () => {
    for (const oscTitle of ["/bin/zsh", "zsh", "-bash", "shell", "~/src/app", "  "])
      expect(tabName({ oscTitle, cwd: "/work/canopy" })).toBe("canopy");
    expect(tabName({ oscTitle: "claude", cwd: "/w/x" }, { agentLabel: "claude" })).toBe("x");
  });

  it("shortens a Windows shell's self-titling to the part that identifies it", () => {
    expect(tabName({ oscTitle: "C:\\Windows\\system32\\cmd.exe" })).toBe("cmd.exe");
  });

  it("shows the generated session label for an agent and never for a shell", () => {
    const tab = { nativeName: "Juniper", oscTitle: "/bin/zsh", cwd: "/work/canopy" };
    expect(tabName(tab, { agent: true })).toBe("Juniper");
    expect(tabName(tab)).toBe("canopy");
  });

  it("never renders an empty label", () => {
    expect(tabName({})).toBe("shell");
  });
});

describe("namePatch", () => {
  it("lets no author reach another author's slot", () => {
    const named = { userName: "billing api" };
    // Each of these used to be able to overwrite a rename, directly or by
    // writing the field the rename happened to be living in.
    expect(namePatch(named, "agent", "Fix the retry loop")).toEqual({
      agentName: "Fix the retry loop",
    });
    expect(namePatch(named, "prompt", "can you look at billing")).toEqual({
      promptName: "can you look at billing",
    });
    expect(namePatch(named, "native", "Moss")).toEqual({ nativeName: "Moss" });
    expect(namePatch(named, "osc", "/bin/zsh")).toEqual({ oscTitle: "/bin/zsh" });
    // …and the tab is still called what the user called it.
    const after = {
      ...named,
      agentName: "Fix the retry loop",
      promptName: "can you look at billing",
      nativeName: "Moss",
      oscTitle: "/bin/zsh",
    };
    expect(tabName(after, { agent: true })).toBe("billing api");
  });

  it("takes only the first prompt, so a conversation cannot rename its own tab", () => {
    const first = namePatch({}, "prompt", "why does renaming not stick");
    expect(first).toEqual({ promptName: "why does renaming not stick" });
    expect(namePatch(first!, "prompt", "ok thanks")).toBeNull();
  });

  it("keeps a micro-task's durable launch label out of the prompt's reach", () => {
    expect(namePatch({ micro: { taskId: "raise-pr" } }, "prompt", "raise a PR")).toBeNull();
  });

  it("lets only the user empty a slot", () => {
    expect(namePatch({ userName: "billing api" }, "user", undefined)).toEqual({
      userName: undefined,
    });
    // A refused spawn reports no session name at all; that is not a request to
    // forget the one this tab already has.
    expect(namePatch({ nativeName: "Moss" }, "native", undefined)).toBeNull();
  });

  it("reports no patch when nothing would change, so no repaint is triggered", () => {
    expect(namePatch({ oscTitle: "✳ Fix tests" }, "osc", "✳ Fix tests")).toBeNull();
  });

  it("flattens and clamps whatever a model or a shell hands it", () => {
    expect(namePatch({}, "agent", "  Fix   the\nredirect ")).toEqual({
      agentName: "Fix the redirect",
    });
    const long = namePatch({}, "agent", "x".repeat(80));
    expect((long?.agentName ?? "").length).toBeLessThanOrEqual(48);
  });
});

describe("snapshots", () => {
  it("carries the user's name across a pty that no longer exists", () => {
    const tab = { userName: "billing api", nativeName: "Lumen", oscTitle: "/bin/zsh" };
    const snap = snapshotNames(tab, { agent: true });
    expect(snap).toEqual({ title: "billing api", userName: "billing api" });
    expect(adoptSnapshotNames(snap)).toMatchObject({ userName: "billing api" });
  });

  it("does not mistake a generated name for one the user chose", () => {
    const snap = snapshotNames({ nativeName: "Lumen", launchTitle: "claude" }, { agent: true });
    expect(snap).toEqual({ title: "Lumen" });
    expect(adoptSnapshotNames(snap).userName).toBeUndefined();
    expect(isUserNamed(adoptSnapshotNames(snap))).toBe(false);
  });

  it("still reads a snapshot written before the slots existed", () => {
    expect(adoptSnapshotNames({ title: "api server", renamed: true })).toMatchObject({
      userName: "api server",
    });
    expect(adoptSnapshotNames({ title: "zsh" }).userName).toBeUndefined();
  });
});
