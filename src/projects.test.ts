import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_CLIS,
  agentForBin,
  agentForPkg,
  BUILTIN_AGENT_CLIS,
  refreshAgentClis,
  restoreCommand,
  resumeSessionId,
  SHELL_PATTERN,
  shellQuote,
  startCommand,
  updateCommand,
} from "./projects";
import { updateSettings } from "./settings";

/** Point a registry entry at a different binary, as Settings → Agents does. */
const rebind = (bins: Record<string, string>) => {
  updateSettings({ cliBins: bins });
  refreshAgentClis();
};

afterEach(() => rebind({}));

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
      for (const pkg of cli.pkgs ?? []) {
        const [kind, name] = [pkg.slice(0, pkg.indexOf(":")), pkg.slice(pkg.indexOf(":") + 1)];
        expect(["npm", "brew", "py"]).toContain(kind);
        if (kind === "npm") expect(cli.install).toContain(name);
      }
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
