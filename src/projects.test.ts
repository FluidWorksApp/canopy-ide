import { describe, expect, it } from "vitest";
import {
  AGENT_CLIS,
  BIN_TO_AGENT,
  PKG_TO_AGENT,
  restoreCommand,
  resumeSessionId,
  SHELL_PATTERN,
  shellQuote,
  startCommand,
  updateCommand,
} from "./projects";

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

describe("BIN_TO_AGENT", () => {
  it("covers every registered CLI and the hand-run extras", () => {
    for (const cli of AGENT_CLIS) expect(BIN_TO_AGENT[cli.bin]).toBe(cli.id);
    expect(BIN_TO_AGENT.gemini).toBe("gemini"); // extra bin, not a launcher
    expect(BIN_TO_AGENT.droid).toBe("droid");
  });

  it("is exact — no prefixes, no substrings", () => {
    // The failures this replaced: `startsWith("amp")` branded `ampere`, and a
    // `\bomp\b` regex over paths branded anything under ~/.omp/.
    expect(BIN_TO_AGENT.ampere).toBeUndefined();
    expect(BIN_TO_AGENT["claude-utils"]).toBeUndefined();
    expect(BIN_TO_AGENT.vim).toBeUndefined();
    expect(BIN_TO_AGENT.python3).toBeUndefined();
  });
});

describe("PKG_TO_AGENT", () => {
  it("maps each declared package to its CLI", () => {
    for (const cli of AGENT_CLIS) {
      for (const pkg of cli.pkgs ?? []) expect(PKG_TO_AGENT[pkg]).toBe(cli.id);
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
