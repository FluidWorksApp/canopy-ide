import { afterEach, describe, expect, it } from "vitest";
import {
  adoptLegacyCustomTasks,
  AGENT_CLIS,
  agentForBin,
  agentForPkg,
  agentIdTaken,
  BUILTIN_AGENT_CLIS,
  customCliIssue,
  newCustomCliId,
  refreshAgentClis,
  restoreCommand,
  resumeSessionId,
  SHELL_PATTERN,
  shellQuote,
  startCommand,
  updateCommand,
} from "./projects";
import { getSettings, updateSettings } from "./settings";
import type { CustomMicroTask } from "./microTasks";
import type { CustomAgentCli, Project, WorkspaceState } from "./projects";

/** Point a registry entry at a different binary, as Settings → Agents does. */
const rebind = (bins: Record<string, string>) => {
  updateSettings({ cliBins: bins });
  refreshAgentClis();
};

/** Add CLIs of the user's own, as Settings → Agents → Other CLIs does. */
const addClis = (clis: CustomAgentCli[]) => {
  updateSettings({ customClis: clis });
  refreshAgentClis();
};

afterEach(() => {
  updateSettings({ cliBins: {}, customClis: [] });
  refreshAgentClis();
});

describe("shellQuote", () => {
  it("wraps in single quotes", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes safely", () => {
    // The POSIX '\'' idiom: close, escaped-quote, reopen.
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("startCommand", () => {
  it("uses the CLI's prompt builder when it has one (no typing needed)", () => {
    const got = startCommand("claude", "fix the bug");
    expect(got).toEqual({ command: "claude 'fix the bug'", typePrompt: false });
  });

  it("launches bare and asks the caller to type when there's no prompt builder", () => {
    // amp has no `prompt` builder in the registry.
    const got = startCommand("amp", "do a thing");
    expect(got).toEqual({ command: "amp", typePrompt: true });
  });

  it("returns null for an unknown agent id", () => {
    expect(startCommand("nope", "x")).toBeNull();
  });
});

describe("restoreCommand", () => {
  it("builds a resume command for agents that support it", () => {
    expect(restoreCommand("claude", "abc123")).toBe("claude --resume abc123");
    expect(restoreCommand("codex", "s-1")).toBe("codex resume s-1");
    expect(restoreCommand("amp", "T-9")).toBe("amp threads continue T-9");
  });

  it("returns null for an empty/whitespace session id (never a bare continue)", () => {
    expect(restoreCommand("claude", "")).toBeNull();
    expect(restoreCommand("claude", "   ")).toBeNull();
  });

  it("returns null for agents that can't resume by id (aider)", () => {
    expect(restoreCommand("aider", "x")).toBeNull();
  });
});

describe("resumeSessionId (inverse of restoreCommand)", () => {
  it("recovers the session id from a resume command", () => {
    expect(resumeSessionId("claude --resume abc123")).toBe("abc123");
    expect(resumeSessionId("codex resume s-1")).toBe("s-1");
    expect(resumeSessionId("opencode --session xyz")).toBe("xyz");
  });

  it("returns null for a bare launch that isn't a resume", () => {
    expect(resumeSessionId("claude")).toBeNull();
    expect(resumeSessionId("codex 'a prompt'")).toBeNull();
  });

  it("round-trips with restoreCommand for every resumable agent", () => {
    for (const cli of AGENT_CLIS) {
      const cmd = restoreCommand(cli.id, "SID42");
      if (cmd) expect(resumeSessionId(cmd)).toBe("SID42");
    }
  });

  it("returns null for empty/nullish input", () => {
    expect(resumeSessionId(null)).toBeNull();
    expect(resumeSessionId(undefined)).toBeNull();
    expect(resumeSessionId("")).toBeNull();
  });
});

describe("updateCommand", () => {
  it("prefers a verified self-updater over the installer", () => {
    const claude = AGENT_CLIS.find((c) => c.id === "claude")!;
    expect(updateCommand(claude)).toBe("claude update");
  });

  it("falls back to the install command when there's no self-updater", () => {
    const aider = AGENT_CLIS.find((c) => c.id === "aider")!;
    expect(updateCommand(aider)).toBe(aider.install);
  });
});

describe("agentForBin", () => {
  it("covers every registered CLI and the hand-run extras", () => {
    for (const cli of AGENT_CLIS) expect(agentForBin(cli.bin)).toBe(cli.id);
    expect(agentForBin("gemini")).toBe("gemini"); // extra bin, not a launcher
    expect(agentForBin("droid")).toBe("droid");
  });

  it("is exact — no prefixes, no substrings", () => {
    // The failures this replaced: `startsWith("amp")` branded `ampere`, and a
    // `\bomp\b` regex over paths branded anything under ~/.omp/.
    expect(agentForBin("ampere")).toBeUndefined();
    expect(agentForBin("claude-utils")).toBeUndefined();
    expect(agentForBin("vim")).toBeUndefined();
    expect(agentForBin("python3")).toBeUndefined();
  });

  it("recognises a rebound binary, and still the stock one", () => {
    rebind({ claude: "acme-claude" });
    expect(agentForBin("acme-claude")).toBe("claude");
    // A terminal remembered from before the override still names `claude`.
    expect(agentForBin("claude")).toBe("claude");
  });

  it("matches an override given as a full path by its basename", () => {
    // The process resolver reports a basename, never the path it was invoked by.
    rebind({ claude: "/opt/acme/bin/claude-ent" });
    expect(agentForBin("claude-ent")).toBe("claude");
  });

  it("folds Windows paths and .exe the way the resolver does", () => {
    rebind({ claude: "C:\\Program Files\\Acme\\Claude.exe" });
    expect(agentForBin("claude")).toBe("claude");
    expect(agentForBin("Claude.exe")).toBe("claude");
  });
});

describe("agentForPkg", () => {
  it("maps each declared package to its CLI", () => {
    for (const cli of AGENT_CLIS) {
      for (const pkg of cli.pkgs ?? []) expect(agentForPkg(pkg)).toBe(cli.id);
    }
  });

  it("names the package the install command installs", () => {
    // A package identity that doesn't match what `install` puts on disk would
    // silently identify nothing, so keep the two in step.
    for (const cli of AGENT_CLIS) {
      const pkg = cli.pkgs?.[0];
      if (!pkg) continue;
      const [kind, name] = [pkg.slice(0, pkg.indexOf(":")), pkg.slice(pkg.indexOf(":") + 1)];
      expect(["npm", "brew", "py"]).toContain(kind);
      if (kind === "npm") expect(cli.install).toContain(name);
    }
  });

  it("survives a rebind — the package is what a renamed binary still ships from", () => {
    rebind({ claude: "acme-claude" });
    expect(agentForPkg("npm:@anthropic-ai/claude-code")).toBe("claude");
  });
});

describe("binary overrides", () => {
  it("launches, resumes and prompts with the overridden binary", () => {
    rebind({ claude: "acme-claude" });
    expect(startCommand("claude", "fix it")).toEqual({
      command: "acme-claude 'fix it'",
      typePrompt: false,
    });
    expect(restoreCommand("claude", "abc123")).toBe("acme-claude --resume abc123");
  });

  it("round-trips resume ids for a rebound CLI, and for commands spawned before", () => {
    rebind({ claude: "acme-claude", codex: "/opt/acme/codex" });
    expect(resumeSessionId("acme-claude --resume SID42")).toBe("SID42");
    expect(resumeSessionId("/opt/acme/codex resume SID42")).toBe("SID42");
    // Remembered from before the override was set.
    expect(resumeSessionId("claude --resume SID42")).toBe("SID42");
  });

  it("round-trips with restoreCommand for every resumable agent when rebound", () => {
    rebind(Object.fromEntries(BUILTIN_AGENT_CLIS.map((d) => [d.id, `ent-${d.bin}`])));
    for (const cli of AGENT_CLIS) {
      const cmd = restoreCommand(cli.id, "SID42");
      if (cmd) expect(resumeSessionId(cmd)).toBe("SID42");
    }
  });

  it("marks an overridden entry rebound, so the update badge can stand down", () => {
    rebind({ claude: "acme-claude" });
    expect(AGENT_CLIS.find((c) => c.id === "claude")?.rebound).toBe(true);
    expect(AGENT_CLIS.find((c) => c.id === "codex")?.rebound).toBe(false);
  });

  it("quotes a binary whose path has a space, and only then", () => {
    // `C:\Program Files\…` is the standard enterprise install on Windows and
    // `/Applications/Acme CLI/…` its macOS equivalent; written raw, the shell
    // reads the first word as the command and the rest as arguments. Every
    // other value is left exactly as it was — quoting is per-shell, and a bare
    // name never needs it.
    rebind({ claude: "/Applications/Acme CLI/bin/claude", codex: "/opt/acme/codex" });
    expect(startCommand("claude", "fix it")).toEqual({
      command: "'/Applications/Acme CLI/bin/claude' 'fix it'",
      typePrompt: false,
    });
    expect(restoreCommand("claude", "abc123")).toBe(
      "'/Applications/Acme CLI/bin/claude' --resume abc123",
    );
    expect(restoreCommand("codex", "abc123")).toBe("/opt/acme/codex resume abc123");
  });

  it("still reads the session id back out of a quoted resume command", () => {
    rebind({ claude: "/Applications/Acme CLI/bin/claude" });
    expect(resumeSessionId(restoreCommand("claude", "SID42"))).toBe("SID42");
    // And the bare spelling a terminal remembered from before the override.
    expect(resumeSessionId("claude --resume SID42")).toBe("SID42");
  });

  it("ignores a blank override and falls back to the vendor's name", () => {
    rebind({ claude: "   " });
    expect(AGENT_CLIS.find((c) => c.id === "claude")?.bin).toBe("claude");
    expect(AGENT_CLIS.find((c) => c.id === "claude")?.rebound).toBe(false);
  });
});

describe("custom CLIs", () => {
  const acme: CustomAgentCli = {
    id: "acme-agent",
    name: "Acme Agent",
    bin: "acme-agent",
    resumeArgs: "--resume {id}",
    promptArgs: "{prompt}",
  };

  it("joins the registry and launches, resumes and prompts by the user's syntax", () => {
    addClis([acme]);
    expect(startCommand("acme-agent", "fix it")).toEqual({
      command: "acme-agent 'fix it'",
      typePrompt: false,
    });
    expect(restoreCommand("acme-agent", "SID42")).toBe("acme-agent --resume SID42");
    expect(resumeSessionId("acme-agent --resume SID42")).toBe("SID42");
  });

  it("appends the value when the template doesn't say where it goes", () => {
    // Typing `--resume` plainly means "the id goes after this". Building
    // `acme-agent --resume` with no id is the silent failure: a fresh session,
    // started while the UI says the conversation was restored.
    addClis([{ ...acme, resumeArgs: "sessions continue", promptArgs: "--task" }]);
    expect(restoreCommand("acme-agent", "SID42")).toBe("acme-agent sessions continue SID42");
    expect(startCommand("acme-agent", "fix it")).toEqual({
      command: "acme-agent --task 'fix it'",
      typePrompt: false,
    });
  });

  it("offers no resume and types the prompt in when the user left those blank", () => {
    addClis([{ id: "acme-agent", name: "Acme Agent", bin: "acme-agent" }]);
    expect(restoreCommand("acme-agent", "SID42")).toBeNull();
    expect(startCommand("acme-agent", "fix it")).toEqual({
      command: "acme-agent",
      typePrompt: true,
    });
  });

  it("quotes a prompt and a path with a space, like any other entry", () => {
    addClis([{ ...acme, bin: "/opt/Acme CLI/agent" }]);
    expect(startCommand("acme-agent", "it's broken")).toEqual({
      command: "'/opt/Acme CLI/agent' 'it'\\''s broken'",
      typePrompt: false,
    });
    expect(resumeSessionId(restoreCommand("acme-agent", "SID42"))).toBe("SID42");
  });

  it("is identified by its binary, including as a full path", () => {
    addClis([{ ...acme, bin: "/opt/acme/bin/acme-agent" }]);
    expect(agentForBin("acme-agent")).toBe("acme-agent");
    expect(agentForBin("/opt/acme/bin/acme-agent")).toBe("acme-agent");
    // A near-miss is still no brand.
    expect(agentForBin("acme-agent-utils")).toBeUndefined();
  });

  it("outranks the bare-binary list when the user claims that name", () => {
    // `droid` names itself today; a user who says what droid is here wins.
    addClis([{ id: "acme-agent", name: "Acme Agent", bin: "droid" }]);
    expect(agentForBin("droid")).toBe("acme-agent");
  });

  it("has no installer, so nothing can offer to install it", () => {
    addClis([acme]);
    const cli = AGENT_CLIS.find((c) => c.id === "acme-agent");
    expect(cli?.custom).toBe(true);
    expect(cli?.install).toBeUndefined();
    expect(updateCommand(cli!)).toBeUndefined();
  });

  it("refuses a command line, and keeps it out of the registry", () => {
    // `acme run agent` probes as one file of that name and would launch the
    // same way — the marker and the registry have to agree about that.
    expect(customCliIssue({ ...acme, bin: "acme run agent" }, [])).toBe("arguments");
    expect(customCliIssue({ ...acme, bin: "/opt/Acme CLI/agent" }, [])).toBeNull();
    addClis([{ ...acme, bin: "acme run agent" }]);
    expect(AGENT_CLIS.some((c) => c.custom)).toBe(false);
  });

  it("refuses a binary a built-in already launches, but not a bare-binary agent", () => {
    expect(customCliIssue({ ...acme, bin: "claude" }, [])).toBe("duplicate");
    // `droid` names itself only because Canopy ships no launcher for it, so
    // adding one is the point rather than a clash.
    expect(customCliIssue({ ...acme, bin: "droid" }, [])).toBeNull();
  });

  it("refuses the second entry to claim a binary, never the first", () => {
    const first: CustomAgentCli = { id: "one", name: "One", bin: "acme-agent" };
    expect(customCliIssue(first, [])).toBeNull();
    expect(customCliIssue({ id: "two", name: "Two", bin: "acme-agent" }, [first])).toBe(
      "duplicate",
    );
    addClis([first, { id: "two", name: "Two", bin: "acme-agent" }]);
    expect(AGENT_CLIS.filter((c) => c.custom).map((c) => c.id)).toEqual(["one"]);
  });

  it("keeps a half-filled row out of the registry", () => {
    addClis([{ id: "", name: "", bin: "" }, { id: "acme-agent", name: "Acme", bin: "" }]);
    expect(AGENT_CLIS.some((c) => c.custom)).toBe(false);
  });

  it("never lets a custom entry take a built-in id", () => {
    expect(agentIdTaken("claude")).toBe(true);
    expect(agentIdTaken("gemini")).toBe(true);
    expect(newCustomCliId("Claude", [])).toBe("claude-2");
    expect(newCustomCliId("Acme Agent!", [])).toBe("acme-agent");
    expect(newCustomCliId("Acme Agent", ["acme-agent"])).toBe("acme-agent-2");
    // A name with nothing sluggable still has to produce an id.
    expect(newCustomCliId("!!!", [])).toBe("cli");
  });
});

describe("SHELL_PATTERN", () => {
  it("matches login and plain interactive shells", () => {
    expect(SHELL_PATTERN.test("-zsh")).toBe(true);
    expect(SHELL_PATTERN.test("bash")).toBe(true);
    expect(SHELL_PATTERN.test("pwsh")).toBe(true);
  });

  it("does not match a non-shell", () => {
    expect(SHELL_PATTERN.test("node")).toBe(false);
    expect(SHELL_PATTERN.test("zshfoo")).toBe(false);
  });
});

describe("adoptLegacyCustomTasks", () => {
  const task: CustomMicroTask = {
    id: "abc",
    label: "Prod DB Backup",
    icon: "◆",
    placeholder: "",
    brief: "Back the database up.",
  };
  const project = (id: string): Project => ({ id, name: id, components: [] });
  const ws = (over: Partial<WorkspaceState> = {}): WorkspaceState => ({
    projects: [project("p1"), project("p2")],
    openIds: ["p1", "p2"],
    activeId: "p2",
    ...over,
  });

  afterEach(() => updateSettings({ customMicroTasks: [] }));

  it("leaves the workspace untouched when there is nothing to move", () => {
    const before = ws();
    expect(adoptLegacyCustomTasks(before)).toBe(before);
  });

  it("hands the old app-wide tasks to the active project, and only that one", () => {
    updateSettings({ customMicroTasks: [task] });
    const after = adoptLegacyCustomTasks(ws());
    expect(after.projects.find((p) => p.id === "p2")?.customTasks).toEqual([task]);
    expect(after.projects.find((p) => p.id === "p1")?.customTasks).toBeUndefined();
    // Emptied, so the next launch has nothing left to adopt.
    expect(getSettings().customMicroTasks).toEqual([]);
  });

  it("falls back to an open project when activeId is stale", () => {
    updateSettings({ customMicroTasks: [task] });
    const after = adoptLegacyCustomTasks(ws({ activeId: "gone", openIds: ["p1"] }));
    expect(after.projects.find((p) => p.id === "p1")?.customTasks).toEqual([task]);
  });

  it("keeps the tasks in settings when there is no project to give them to", () => {
    updateSettings({ customMicroTasks: [task] });
    const empty = ws({ projects: [], openIds: [], activeId: null });
    expect(adoptLegacyCustomTasks(empty)).toBe(empty);
    expect(getSettings().customMicroTasks).toEqual([task]);
  });

  it("appends rather than replacing tasks the project already has", () => {
    updateSettings({ customMicroTasks: [task] });
    const mine: CustomMicroTask = { ...task, id: "own", label: "Mine" };
    const state = ws({ projects: [{ ...project("p2"), customTasks: [mine] }] });
    const after = adoptLegacyCustomTasks(state);
    expect(after.projects[0].customTasks).toEqual([mine, task]);
  });
});
