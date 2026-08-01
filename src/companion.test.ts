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
  panelSize,
  permissionArgs,
  pixelsToSpot,
  spotToPixels,
  tierFor,
  toolDetail,
  toolLabel,
  PANEL,
  PANEL_BIG,
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

  it("keeps codex read-only at every authority, as claude's writers are", () => {
    // Codex's built-in tools never pass Canopy's gate, same as claude's — and
    // the answer has to be the same one, or "the companion does not edit
    // files" would depend on which CLI the user happened to pick. Codex
    // defaults to workspace-write, so anything less than this let it edit on
    // codex what it could not edit on claude.
    const base = {
      bin: "codex",
      sessionId: "id",
      systemPrompt: "p",
      roots: [],
      model: "",
    };
    for (const authority of ["read", "confirm", "auto"] as const) {
      expect(COMPANION_RUNNERS.codex.args({ ...base, authority }).join(" ")).toContain(
        "read-only",
      );
      expect(
        COMPANION_RUNNERS.codex.resumeArgs({ ...base, authority }).join(" "),
      ).toContain("read-only");
    }
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

  it("disallows the built-in writers at every authority, act-freely included", () => {
    // Bash/Edit/Write never pass the bridge, so leaving them on would make
    // "asks before it changes anything" false — and the companion does not
    // edit files at all, which is a statement about what it is rather than a
    // caution that relaxes as the user trusts it more. "Act freely" is freedom
    // with Canopy's own tools; the code is written by a coding agent in a
    // checkout the user can watch.
    for (const authority of ["read", "confirm", "auto"] as const) {
      const args = permissionArgs(authority);
      expect(args).toContain("--disallowedTools");
      for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "KillShell"]) {
        expect(args).toContain(tool);
      }
    }
  });

  it("leaves reading alone — that is what understanding code needs", () => {
    for (const authority of ["read", "confirm", "auto"] as const) {
      const args = permissionArgs(authority);
      for (const tool of ["Read", "Grep", "Glob"]) expect(args).not.toContain(tool);
    }
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

describe("the panel's two sizes", () => {
  const view = { width: 1440, height: 900 };

  it("grows when expanded, and stays a panel rather than a window", () => {
    expect(panelSize(false, view)).toEqual(PANEL);
    expect(panelSize(true, view)).toEqual(PANEL_BIG);
    expect(PANEL_BIG.width).toBeLessThan(view.width / 2);
  });

  it("never asks for more room than the window has", () => {
    // The placement arithmetic runs in pixels before anything is drawn, so an
    // unclamped 660 in a 500px window is placed as if it fit — and takes the
    // compose box off the bottom edge with it.
    const small = { width: 460, height: 500 };
    const p = panelSize(true, small);
    expect(p.width).toBeLessThanOrEqual(small.width);
    expect(p.height).toBeLessThanOrEqual(small.height);
    const placed = panelPlacement({ left: 300, top: 400 }, small, {
      mascot: 54,
      panelWidth: p.width,
      panelHeight: p.height,
      gap: 14,
    });
    expect(placed.top + p.height).toBeLessThanOrEqual(small.height);
  });
});

describe("a tool call, written for a reader", () => {
  it("drops the mcp prefix, which is all a truncated row would show", () => {
    expect(toolLabel("mcp__canopy__canopy_show_diff")).toBe("canopy_show_diff");
    // Server names have underscores of their own; splitting on "__" is what
    // survives that.
    expect(toolLabel("mcp__claude_ai_Gmail__get_message")).toBe("get_message");
    expect(toolLabel("Read")).toBe("Read");
    expect(toolLabel("")).toBe("");
  });

  it("shortens a path from the front, where the repeated part is", () => {
    const d = toolDetail("/Users/shoaib/Documents/GitHub/canopy/src/components/CompanionChat.tsx");
    expect(d.startsWith("…/")).toBe(true);
    expect(d).toContain("CompanionChat.tsx");
    expect(d.length).toBeLessThanOrEqual(48);
  });

  it("leaves a short one alone, and truncates prose from the end", () => {
    expect(toolDetail("src/companion.ts")).toBe("src/companion.ts");
    expect(toolDetail(undefined)).toBe("");
    const prose = toolDetail("select:mcp__canopy__canopy_show_diff,mcp__canopy__canopy_editor_state");
    expect(prose.startsWith("select:")).toBe(true);
    expect(prose.endsWith("…")).toBe(true);
  });
});
