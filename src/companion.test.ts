import { beforeEach, describe, expect, it } from "vitest";
import {
  COMPANION_RUNNERS,
  DEFAULT_SPOT,
  actionPolicy,
  clampSpot,
  companionCli,
  companionName,
  companionSessionId,
  companionSlug,
  forgetCompanionSession,
  panelPlacement,
  permissionArgs,
  pixelsToSpot,
  spotToPixels,
  tierFor,
} from "./companion";
import { getSettings, updateSettings } from "./settings";

beforeEach(() => localStorage.clear());

describe("authority", () => {
  it("is the gate, not a hint — read denies outright", () => {
    expect(actionPolicy("read")).toBe("deny");
    expect(actionPolicy("confirm")).toBe("confirm");
    expect(actionPolicy("auto")).toBe("allow");
  });

  it("is on by default, and asks before acting", () => {
    // The companion is the point of the mascot; a feature nobody finds is a
    // feature nobody has. It is safe to default on because the authority
    // default gates every change, and it renders nothing at all until an agent
    // CLI exists to run it.
    expect(getSettings().companionEnabled).toBe(true);
    expect(getSettings().companionAuthority).toBe("confirm");
  });

  it("defaults to asking first", () => {
    // The cross-project reach is what makes this the right default: an action
    // can land somewhere the user has no tab open.
    expect(getSettings().companionAuthority).toBe("confirm");
    expect(actionPolicy(getSettings().companionAuthority)).toBe("confirm");
  });
});

describe("name", () => {
  it("falls back to the mascot's own name rather than a hardcoded one", () => {
    expect(companionName()).toBe("Ash");
  });

  it("is the user's when they set one", () => {
    updateSettings({ companionName: "  Sprig  " });
    expect(companionName()).toBe("Sprig");
    expect(companionSlug()).toBe("sprig");
  });

  it("always produces a usable slug", () => {
    updateSettings({ companionName: "!!!" });
    expect(companionSlug()).toBe("ash");
  });
});

describe("tiers", () => {
  it("puts every unlisted CLI in the terminal tier rather than refusing it", () => {
    // The point of the fallback: an agent Canopy ships no runner for still
    // works as a companion on the day the user installs it.
    expect(tierFor("amp")).toBe("terminal");
    expect(tierFor("aider")).toBe("terminal");
    expect(tierFor("something-nobody-has-written-yet")).toBe("terminal");
  });

  it("only lists a CLI whose flags were verified", () => {
    expect(tierFor("claude")).toBe("structured");
    expect(tierFor("codex")).toBe("oneshot");
    for (const [id, runner] of Object.entries(COMPANION_RUNNERS)) {
      expect(["structured", "oneshot"], id).toContain(runner.tier);
    }
  });

  it("gives codex the flags its non-interactive mode actually needs", () => {
    // Verified against the installed CLI: `codex exec --json` emits
    // thread.started / item.completed / turn.completed, and `exec resume <id>`
    // recalled a fact from the previous turn.
    const launch = {
      bin: "codex",
      sessionId: "019fb7e5-acdb-7781-863c-53947ee2436d",
      systemPrompt: "you are the companion",
      roots: ["/a"],
      model: "",
      authority: "confirm" as const,
    };
    const fresh = COMPANION_RUNNERS.codex.args(launch);
    expect(fresh).toContain("exec");
    expect(fresh).toContain("--json");
    // The companion runs in ~/.canopy/companion, which is deliberately not a
    // repo — codex refuses to start outside one without this.
    expect(fresh).toContain("--skip-git-repo-check");
    // The id is reported by codex, never chosen, so a first turn must not
    // claim to resume one.
    expect(fresh).not.toContain("resume");

    const resumed = COMPANION_RUNNERS.codex.resumeArgs(launch);
    expect(resumed).toContain("resume");
    expect(resumed).toContain(launch.sessionId);
  });

  it("locks codex down for answer-only in its own sandbox", () => {
    // Codex's built-in tools never pass Canopy's gate, same as claude's.
    const base = {
      bin: "codex",
      sessionId: "id",
      systemPrompt: "p",
      roots: [],
      model: "",
    };
    expect(COMPANION_RUNNERS.codex.args({ ...base, authority: "read" }).join(" ")).toContain(
      "read-only",
    );
    expect(
      COMPANION_RUNNERS.codex.args({ ...base, authority: "auto" }).join(" "),
    ).not.toContain("read-only");
  });

  it("carries the session id, the reach and the brief into both launches", () => {
    const launch = {
      bin: "claude",
      sessionId: "11111111-2222-3333-4444-555555555555",
      systemPrompt: "you are the companion",
      roots: ["/a", "/b"],
      model: "opus",
      authority: "confirm" as const,
    };
    const fresh = COMPANION_RUNNERS.claude.args(launch);
    expect(fresh).toContain("--session-id");
    expect(fresh).toContain(launch.sessionId);
    // Both roots reach the one session — this is what "across projects" means.
    expect(fresh.filter((a) => a === "--add-dir")).toHaveLength(2);
    expect(fresh).toContain("/a");
    expect(fresh).toContain("/b");
    // Appended, never replaced: replacing it would throw away the CLI's own
    // knowledge of its own tools.
    expect(fresh).toContain("--append-system-prompt");
    expect(fresh).not.toContain("--system-prompt");

    const resumed = COMPANION_RUNNERS.claude.resumeArgs(launch);
    expect(resumed).toContain("--resume");
    expect(resumed).toContain(launch.sessionId);
    expect(resumed).not.toContain("--session-id");
  });

  it("bypasses the CLI's prompt, because headless has nobody to answer it", () => {
    // The failure this encodes: Claude Code does not auto-grant MCP tools, and
    // `-p` has no prompt to grant them at — so every canopy_* call came back
    // ungranted, read-only ones included. The gating happens at the bridge
    // (companion_gate), which can actually reach a human.
    for (const authority of ["read", "confirm", "auto"] as const) {
      const args = permissionArgs(authority);
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    }
  });

  it("disallows the built-in writers unless the user said act freely", () => {
    // Bash/Edit/Write never pass the bridge, so leaving them on would make
    // "asks before it changes anything" false.
    for (const authority of ["read", "confirm"] as const) {
      const args = permissionArgs(authority);
      expect(args).toContain("--disallowedTools");
      for (const tool of ["Bash", "Edit", "Write"]) expect(args).toContain(tool);
    }
    expect(permissionArgs("auto")).not.toContain("--disallowedTools");
  });

  it("carries the permission flags into both fresh and resumed launches", () => {
    const launch = {
      bin: "claude",
      sessionId: "id",
      systemPrompt: "p",
      roots: [],
      model: "",
      authority: "confirm" as const,
    };
    for (const args of [
      COMPANION_RUNNERS.claude.args(launch),
      COMPANION_RUNNERS.claude.resumeArgs(launch),
    ]) {
      expect(args).toContain("bypassPermissions");
      expect(args).toContain("Bash");
    }
  });

  it("passes --verbose wherever it streams JSON — the CLI refuses without it", () => {
    // Found the hard way: `claude -p --output-format stream-json` exits with
    // "requires --verbose" before producing a single line, so the companion
    // never starts. This encodes the CLI's own constraint rather than trusting
    // anyone to remember it on the next flag change.
    const launch = {
      bin: "claude",
      sessionId: "id",
      systemPrompt: "p",
      roots: [],
      model: "",
      authority: "confirm" as const,
    };
    for (const args of [
      COMPANION_RUNNERS.claude.args(launch),
      COMPANION_RUNNERS.claude.resumeArgs(launch),
    ]) {
      const streams =
        args.includes("--output-format") &&
        args[args.indexOf("--output-format") + 1] === "stream-json";
      expect(streams).toBe(true);
      expect(args).toContain("--verbose");
    }
  });

  it("omits the model flag when the CLI should pick", () => {
    const args = COMPANION_RUNNERS.claude.args({
      bin: "claude",
      sessionId: "id",
      systemPrompt: "p",
      roots: [],
      model: "",
      authority: "confirm",
    });
    expect(args).not.toContain("--model");
  });
});

describe("which CLI it runs on", () => {
  const anyInstalled = () => true;

  it("takes the user's explicit choice", () => {
    updateSettings({ companionCli: "codex", defaultAgent: "claude" });
    expect(companionCli(anyInstalled)?.id).toBe("codex");
  });

  it("follows the default agent when nothing was picked for the companion", () => {
    updateSettings({ companionCli: "", defaultAgent: "amp" });
    expect(companionCli(anyInstalled)?.id).toBe("amp");
  });

  it("never overrules the user with a CLI Canopy happens to have verified", () => {
    // The defect this pins: a dead resolver preferred a CLI with an entry in
    // COMPANION_RUNNERS. A tier says which flags were checked against which
    // binary — it says nothing about which agent the user wants to talk to,
    // and letting it reorder this silently overrules a choice they made.
    updateSettings({ companionCli: "", defaultAgent: "amp" });
    expect(tierFor("amp")).toBe("terminal");
    expect(COMPANION_RUNNERS.claude).toBeTruthy();
    // claude has a verified runner and amp does not; amp still wins, because
    // amp is what they set.
    expect(companionCli(anyInstalled)?.id).toBe("amp");
  });

  it("falls back to anything installed rather than a hardcoded name", () => {
    // Pinning "claude" here would leave someone who only has Codex with a
    // companion that cannot start and no way to see why.
    updateSettings({ companionCli: "nope", defaultAgent: "also-nope" });
    const only = companionCli((bin) => bin === "codex");
    expect(only?.id).toBe("codex");
  });

  it("says so when there is nothing to run", () => {
    expect(companionCli(() => false)).toBeNull();
  });
});

describe("session identity", () => {
  it("mints once and then keeps it — that is the memory", () => {
    const first = companionSessionId("claude");
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(companionSessionId("claude")).toBe(first);
    expect(getSettings().companionSessions.claude).toBe(first);
  });

  it("keeps one conversation per CLI rather than fusing them", () => {
    const claude = companionSessionId("claude");
    const codex = companionSessionId("codex");
    expect(codex).not.toBe(claude);
    // Switching back returns to the same conversation, not a third one.
    expect(companionSessionId("claude")).toBe(claude);
  });

  it("forgetting one leaves the others alone", () => {
    const claude = companionSessionId("claude");
    const codex = companionSessionId("codex");
    forgetCompanionSession("claude");
    expect(getSettings().companionSessions.claude).toBeUndefined();
    expect(getSettings().companionSessions.codex).toBe(codex);
    // And the next launch is a fresh acquaintance, not the same memory.
    expect(companionSessionId("claude")).not.toBe(claude);
  });
});

describe("placement", () => {
  const view = { width: 1440, height: 900 };
  const SIZE = 54;

  it("agrees with the stored default", () => {
    // settings.ts spells the default out as a literal to keep the cycle
    // compile-time only; this is what keeps the two honest.
    expect(getSettings().companionSpot).toEqual(DEFAULT_SPOT);
  });

  it("never places the companion off-screen, at any fraction", () => {
    for (const spot of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.5, y: 0.5 },
      { x: 2, y: -3 },
      { x: NaN, y: NaN },
    ]) {
      const { left, top } = spotToPixels(spot, view, SIZE);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(left + SIZE).toBeLessThanOrEqual(view.width);
      expect(top + SIZE).toBeLessThanOrEqual(view.height);
    }
  });

  it("survives a resize — the whole reason it is a fraction", () => {
    const spot = { x: 1, y: 1 };
    const wide = spotToPixels(spot, { width: 1600, height: 1000 }, SIZE);
    const narrow = spotToPixels(spot, { width: 700, height: 500 }, SIZE);
    // Flush to the corner in both, rather than stranded past the edge of the
    // narrow one the way a remembered pixel offset would be.
    expect(wide.left + SIZE).toBe(1600);
    expect(narrow.left + SIZE).toBe(700);
  });

  it("round-trips a drag", () => {
    const spot = pixelsToSpot(900, 400, view, SIZE);
    const back = spotToPixels(spot, view, SIZE);
    expect(back.left).toBe(900);
    expect(back.top).toBe(400);
  });

  it("clamps a stored value that no longer makes sense", () => {
    expect(clampSpot({ x: 9, y: -9 })).toEqual({ x: 1, y: 0 });
    expect(clampSpot(null)).toEqual(DEFAULT_SPOT);
    expect(clampSpot(undefined)).toEqual(DEFAULT_SPOT);
  });
});

describe("panel placement", () => {
  const opts = { mascot: 54, panelWidth: 352, panelHeight: 320, gap: 14 };

  it("opens to the right when there is room", () => {
    const p = panelPlacement({ left: 200, top: 100 }, { width: 1440, height: 900 }, opts);
    expect(p.side).toBe("right");
    expect(p.left).toBe(200 + 54 + 14);
  });

  it("flips near the right edge", () => {
    const p = panelPlacement({ left: 1300, top: 100 }, { width: 1440, height: 900 }, opts);
    expect(p.side).toBe("left");
    expect(p.left).toBe(1300 - 14 - 352);
  });

  it("does not flip into a worse position in a narrow window", () => {
    // Everything is past the middle here, so a hardcoded midpoint test would
    // flip it left — off the left edge. It has to measure.
    const p = panelPlacement({ left: 300, top: 40 }, { width: 420, height: 700 }, opts);
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.left + opts.panelWidth).toBeLessThanOrEqual(420);
  });

  it("keeps the input on screen when the companion sits at the bottom", () => {
    const p = panelPlacement({ left: 200, top: 870 }, { width: 1440, height: 900 }, opts);
    expect(p.top + opts.panelHeight).toBeLessThanOrEqual(900);
  });
});
