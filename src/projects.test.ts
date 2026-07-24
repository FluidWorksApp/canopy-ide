import { describe, expect, it } from "vitest";
import {
  AGENT_CLIS,
  AGENT_PATTERN,
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

describe("AGENT_PATTERN", () => {
  it("matches registered CLI binaries and known extras", () => {
    expect(AGENT_PATTERN.test("claude")).toBe(true);
    expect(AGENT_PATTERN.test("gemini")).toBe(true); // extra bin, not a launcher
    expect(AGENT_PATTERN.test("droid")).toBe(true);
  });

  it("does not match an unrelated process name", () => {
    expect(AGENT_PATTERN.test("vim")).toBe(false);
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
