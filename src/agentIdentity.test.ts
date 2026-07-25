import { beforeEach, describe, expect, it } from "vitest";
import type { AgentHint, SessionDigest } from "./ipc";
import {
  agentIdForCommand,
  identifyAgent,
  learnBin,
  learnedBins,
  observeForLearning,
  resetLearned,
} from "./agentIdentity";

const hint = (over: Partial<AgentHint> = {}): AgentHint => ({
  bin: "claude",
  pkg: null,
  path: "/opt/homebrew/bin/claude",
  interactive: true,
  ...over,
});

const digest = (over: Partial<SessionDigest> = {}): SessionDigest => ({
  session_id: "s1",
  agent: "claude",
  state: "working",
  updated: Date.now(),
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  resetLearned();
});

describe("identifyAgent", () => {
  it("says nothing is running when the pty has no foreground program", () => {
    expect(identifyAgent(null)).toBeNull();
    expect(identifyAgent(undefined, digest())).toBeNull();
  });

  it("does not brand a python script — the bug this replaced", () => {
    // The old matcher tested `\bomp\b` against whole paths, so a script living
    // anywhere under ~/.omp/ came back as oh-my-pi.
    const python = hint({
      bin: "train.py",
      pkg: null,
      path: "/Users/x/.omp/scratch/train.py",
      interactive: false,
    });
    expect(identifyAgent(python)).toBeNull();
  });

  it("identifies a CLI by the package that ships it, whatever it is called", () => {
    const wrapped = hint({
      bin: "acme-claude",
      pkg: "npm:@anthropic-ai/claude-code",
      path: "/usr/local/lib/acme/cli.js",
    });
    expect(identifyAgent(wrapped)).toEqual({
      id: "claude",
      label: "claude",
      via: "package",
    });
  });

  it("identifies a plain install by binary name, exactly", () => {
    expect(identifyAgent(hint())?.id).toBe("claude");
    expect(identifyAgent(hint({ bin: "claude.exe" }))?.id).toBe("claude");
    // Near-misses get a row, never a brand.
    const near = hint({ bin: "ampere", path: "/usr/local/bin/ampere" });
    expect(identifyAgent(near)).toEqual({
      id: null,
      label: "ampere",
      via: "interactive",
    });
  });

  it("takes the hook's word for a binary nothing else identifies", () => {
    const unknown = hint({ bin: "acme-agent", path: "/opt/acme/bin/acme-agent" });
    const id = identifyAgent(unknown, digest({ agent: "claude" }));
    // Branded from the hook, but still labelled with what the user typed.
    expect(id).toEqual({ id: "claude", label: "acme-agent", via: "hook" });
  });

  it("ignores a digest left behind by an agent that has exited", () => {
    const python = hint({ bin: "train.py", path: "/w/train.py", interactive: false });
    const stale = digest({ state: "ended" });
    expect(identifyAgent(python, stale)).toBeNull();
    // Also stale by age, even without an end event.
    const old = digest({ updated: Date.now() - 60 * 60 * 1000 });
    expect(identifyAgent(python, old)).toBeNull();
  });

  it("prefers what is running now over what the digest remembers", () => {
    // Same terminal, agent exited, user then ran a different agent in it.
    const running = hint({ bin: "codex", path: "/usr/local/bin/codex" });
    expect(identifyAgent(running, digest({ agent: "claude" }))?.id).toBe("codex");
  });

  it("shows an unrecognised interactive program as itself", () => {
    const unknown = hint({ bin: "acme-agent", path: "/opt/acme/bin/acme-agent" });
    expect(identifyAgent(unknown)).toEqual({
      id: null,
      label: "acme-agent",
      via: "interactive",
    });
  });

  it("leaves editors and pagers out of it", () => {
    for (const bin of ["vim", "less", "htop", "tig"]) {
      expect(identifyAgent(hint({ bin, path: `/usr/bin/${bin}` }))).toBeNull();
    }
  });

  it("does not promote a non-interactive command", () => {
    const build = hint({ bin: "make", path: "/usr/bin/make", interactive: false });
    expect(identifyAgent(build)).toBeNull();
  });
});

describe("learning from the hook stream", () => {
  const unknown = hint({ bin: "acme-agent", path: "/opt/acme/bin/acme-agent" });

  it("records an unidentifiable binary the hook has named", () => {
    expect(observeForLearning([{ hint: unknown, digest: digest({ agent: "codex" }) }])).toBe(
      true,
    );
    expect(learnedBins()["/opt/acme/bin/acme-agent"]).toBe("codex");
    // And the next launch is identified before it reports anything.
    expect(identifyAgent(unknown)).toEqual({
      id: "codex",
      label: "codex",
      via: "learned",
    });
  });

  it("never overwrites an identity we can establish from disk", () => {
    const known = hint({ bin: "claude", path: "/opt/homebrew/bin/claude" });
    observeForLearning([{ hint: known, digest: digest({ agent: "codex" }) }]);
    expect(learnedBins()["/opt/homebrew/bin/claude"]).toBeUndefined();
    expect(identifyAgent(known)?.id).toBe("claude");
  });

  it("learns nothing from a stale digest", () => {
    expect(
      observeForLearning([{ hint: unknown, digest: digest({ state: "ended" }) }]),
    ).toBe(false);
    expect(learnedBins()).toEqual({});
  });

  it("reports no change when it already knew", () => {
    expect(learnBin("/opt/acme/bin/acme-agent", "codex")).toBe(true);
    expect(learnBin("/opt/acme/bin/acme-agent", "codex")).toBe(false);
  });

  it("survives a restart", () => {
    learnBin("/opt/acme/bin/acme-agent", "codex");
    resetLearned(); // a fresh process, same localStorage
    expect(identifyAgent(unknown)?.id).toBe("codex");
  });
});

describe("agentIdForCommand", () => {
  it("reads the binary out of a launch command", () => {
    expect(agentIdForCommand("claude --resume abc")).toBe("claude");
    expect(agentIdForCommand("/opt/homebrew/bin/omp")).toBe("omp");
  });

  it("reads a quoted head, and a Windows path", () => {
    // A rebound binary whose path has a space goes to the shell quoted, and
    // that is the spelling a remembered terminal then carries.
    expect(agentIdForCommand("'/Applications/Acme CLI/bin/claude' --resume abc")).toBe("claude");
    expect(agentIdForCommand('"C:\\Program Files\\Acme\\Claude.exe"')).toBe("claude");
    expect(agentIdForCommand("C:\\acme\\codex.exe resume abc")).toBe("codex");
  });

  it("is not fooled by a command that merely mentions an agent", () => {
    expect(agentIdForCommand("python train.py --model claude")).toBeNull();
    expect(agentIdForCommand("claude-utils sync")).toBeNull();
    expect(agentIdForCommand("")).toBeNull();
    expect(agentIdForCommand(null)).toBeNull();
  });
});
