import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_UPDATE_INTERVAL_MS,
  planCliAutoUpdates,
  runCliAutoUpdates,
  type AutoUpdateDeps,
  type CliUpdateOutcome,
} from "./cliAutoUpdate";
import {
  AGENT_CLIS,
  BUILTIN_AGENT_CLIS,
  autoUpdateCommand,
  nativeUpdateOffEnv,
  updateCommandFor,
  type AgentCli,
  type CliUpdate,
} from "./projects";
import { DEFAULTS, getSettings, updateSettings } from "./settings";

const NOW = 1_800_000_000_000;
const cli = (id: string) => AGENT_CLIS.find((c) => c.id === id)!;
const allInstalled = () => Object.fromEntries(AGENT_CLIS.map((c) => [c.bin, true]));
const current: CliUpdate = { hasUpdate: false };
const outdated = (extra: Partial<CliUpdate> = {}): CliUpdate => ({
  installed: "1.0.0",
  latest: "1.1.0",
  hasUpdate: true,
  ...extra,
});

const plan = (over: Partial<Parameters<typeof planCliAutoUpdates>[0]> = {}) =>
  planCliAutoUpdates({
    enabled: true,
    clis: AGENT_CLIS,
    installed: allInstalled(),
    updates: {},
    lastAttempt: {},
    now: NOW,
    ...over,
  });

beforeEach(() => {
  localStorage.clear();
});

describe("the autoUpdateClis setting", () => {
  it("is on by default, including for an install that stored settings before it existed", () => {
    expect(DEFAULTS.autoUpdateClis).toBe(true);
    expect(getSettings().autoUpdateClis).toBe(true);
    localStorage.setItem("canopy.settings", JSON.stringify({ theme: "gotham", agentsMaySpawn: false }));
    expect(getSettings().autoUpdateClis).toBe(true);
  });

  it("stays off once the user turns it off", () => {
    updateSettings({ autoUpdateClis: false });
    expect(getSettings().autoUpdateClis).toBe(false);
  });
});

describe("registry stamps", () => {
  it("every built-in CLI declares how it is kept current, with a dated source", () => {
    for (const d of BUILTIN_AGENT_CLIS) {
      expect(d.autoUpdate, d.id).toBeDefined();
      expect(d.autoUpdate!.verification.checkedOn, d.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.autoUpdate!.verification.source, d.id).not.toBe("");
      expect(d.autoUpdate!.verification.cliVersion, d.id).not.toBe("");
      if (d.autoUpdate!.mechanism === "canopy") {
        // A Canopy-run CLI needs a route that is not its installer — its own
        // updater, or (aider) a probe-derived venv upgrade.
        expect(d.update ?? d.pipPackage, d.id).toBeTruthy();
      } else {
        expect(d.autoUpdate!.disableEnv?.length, d.id).toBeGreaterThan(0);
      }
    }
  });

  it("names the self-updating CLIs and their documented off-switches", () => {
    const native = BUILTIN_AGENT_CLIS.filter((d) => d.autoUpdate?.mechanism === "native").map((d) => d.id);
    expect(native.sort()).toEqual(["agy", "claude", "grok"]);
    expect(nativeUpdateOffEnv(true)).toEqual([]);
    expect(nativeUpdateOffEnv(false)).toEqual([
      ["DISABLE_AUTOUPDATER", "1"],
      ["AGY_CLI_DISABLE_AUTO_UPDATE", "true"],
      ["GROK_DISABLE_AUTOUPDATER", "1"],
    ]);
  });
});

describe("planCliAutoUpdates", () => {
  it("does nothing at all while the setting is off", () => {
    const p = plan({ enabled: false, updates: { codex: outdated() } });
    expect(p.run).toEqual([]);
    expect(p.skipped).toEqual({});
  });

  it("skips CLIs that are not installed, and everything when the probe could not answer", () => {
    const installed = { ...allInstalled(), codex: false };
    const p = plan({ installed, updates: { codex: outdated() } });
    expect(p.skipped.codex).toBe("not-installed");
    expect(p.run.map((j) => j.cli.id)).not.toContain("codex");

    const unanswered = plan({ installed: null, updates: { codex: outdated() } });
    expect(unanswered.run).toEqual([]);
    expect(new Set(Object.values(unanswered.skipped))).toEqual(new Set(["not-installed"]));
  });

  it("leaves self-updating CLIs to their own updater", () => {
    const p = plan({ updates: { claude: outdated({ managedBy: "npm", updateCmd: "npm install -g @anthropic-ai/claude-code" }) } });
    expect(p.skipped.claude).toBe("native");
    expect(p.skipped.grok).toBe("native");
    expect(p.skipped.agy).toBe("native");
  });

  it("upgrades a Homebrew-owned self-updater itself, since brew installs do not self-update", () => {
    const p = plan({
      updates: { claude: outdated({ managedBy: "homebrew", updateCmd: "brew upgrade --cask claude-code" }) },
    });
    expect(p.run.find((j) => j.cli.id === "claude")?.command).toBe("brew upgrade --cask claude-code");
  });

  it("picks the command matched to the install method, else the CLI's own updater", () => {
    const p = plan({
      updates: {
        codex: outdated({ managedBy: "npm", updateCmd: "npm install -g @openai/codex" }),
        opencode: outdated(),
        amp: outdated({ managedBy: "pnpm", updateCmd: "pnpm add -g @ampcode/cli" }),
        aider: outdated({ managedBy: "pipx", updateCmd: "pipx upgrade aider-chat" }),
      },
    });
    const cmd = (id: string) => p.run.find((j) => j.cli.id === id)?.command;
    expect(cmd("codex")).toBe("npm install -g @openai/codex");
    expect(cmd("opencode")).toBe("opencode upgrade");
    expect(cmd("amp")).toBe("pnpm add -g @ampcode/cli");
    expect(cmd("aider")).toBe("pipx upgrade aider-chat");
  });

  it("never falls back to an installer unattended", () => {
    // Aider has no self-updater; without a probe-derived venv upgrade there is
    // no safe route, even though its `install` would "work".
    const p = plan({ updates: { aider: outdated() } });
    expect(p.skipped.aider).toBe("no-updater");
    expect(autoUpdateCommand(cli("aider"), outdated())).toBeUndefined();
    // …whereas the badge a person clicks may still offer it.
    expect(updateCommandFor(cli("aider"), outdated())).toBe(cli("aider").install);
  });

  it("runs only when outdated, or when the CLI has no registry to compare against", () => {
    const p = plan({ updates: { codex: current, opencode: current } });
    expect(p.skipped.codex).toBe("current");
    expect(p.skipped.opencode).toBe("current");
    const unversioned = p.run.filter((j) => j.reason === "unversioned").map((j) => j.cli.id);
    expect(unversioned.sort()).toEqual(["cursor", "omp"]);
  });

  it("attempts each CLI at most once per interval", () => {
    const updates = { codex: outdated() };
    expect(plan({ updates, lastAttempt: { codex: NOW - 1000 } }).skipped.codex).toBe("recent");
    expect(
      plan({ updates, lastAttempt: { codex: NOW - AUTO_UPDATE_INTERVAL_MS } }).run.some((j) => j.cli.id === "codex"),
    ).toBe(true);
  });

  it("never touches a rebound (enterprise) binary or a custom CLI", () => {
    const rebound: AgentCli = { ...cli("codex"), bin: "acme-codex", rebound: true };
    const custom: AgentCli = { id: "droid", name: "Droid", bin: "droid", icon: "d", custom: true, update: "droid update" };
    const p = plan({
      clis: [rebound, custom],
      installed: { "acme-codex": true, droid: true },
      updates: { "acme-codex": outdated(), droid: outdated() },
    });
    expect(p.run).toEqual([]);
    expect(p.skipped).toEqual({ codex: "rebound", droid: "custom" });
  });
});

describe("runCliAutoUpdates", () => {
  const deps = (over: Partial<AutoUpdateDeps> = {}) => {
    let last: Record<string, number> = {};
    const d: AutoUpdateDeps = {
      enabled: () => true,
      allowed: () => true,
      clis: () => [cli("codex"), cli("opencode")],
      probeInstalled: async () => ({ codex: true, opencode: true }),
      checkUpdates: async () => ({ codex: outdated(), opencode: outdated() }),
      runUpdate: vi.fn(async (): Promise<CliUpdateOutcome> => ({ status: "updated", detail: "" })),
      loadLastAttempt: () => last,
      saveLastAttempt: (v) => {
        last = { ...v };
      },
      onUpdated: vi.fn(),
      onFailed: vi.fn(),
      now: () => NOW,
      ...over,
    };
    return { d, last: () => last };
  };

  it("does not probe or run anything with the toggle off", async () => {
    const probeInstalled = vi.fn(async () => ({}));
    const { d } = deps({ enabled: () => false, probeInstalled });
    expect(await runCliAutoUpdates(d)).toBeNull();
    expect(probeInstalled).not.toHaveBeenCalled();
    expect(d.runUpdate).not.toHaveBeenCalled();
  });

  it("does not run where this window must not schedule (portal, read-only)", async () => {
    const { d } = deps({ allowed: () => false });
    expect(await runCliAutoUpdates(d)).toBeNull();
    expect(d.runUpdate).not.toHaveBeenCalled();
  });

  it("runs the plan one CLI at a time and stamps each attempt", async () => {
    const order: string[] = [];
    let active = 0;
    const runUpdate = vi.fn(async (bin: string): Promise<CliUpdateOutcome> => {
      active++;
      expect(active).toBe(1);
      order.push(bin);
      await Promise.resolve();
      active--;
      return { status: "updated", detail: "" };
    });
    const { d, last } = deps({ runUpdate });
    await runCliAutoUpdates(d);
    expect(order).toEqual(["codex", "opencode"]);
    expect(runUpdate).toHaveBeenCalledWith("opencode", "opencode upgrade");
    expect(last()).toEqual({ codex: NOW, opencode: NOW });
    expect(d.onUpdated).toHaveBeenCalledTimes(2);
  });

  it("defers a running CLI without stamping it, so the next tick retries", async () => {
    const runUpdate = vi.fn(async (bin: string): Promise<CliUpdateOutcome> =>
      bin === "codex" ? { status: "deferred", detail: "codex is running" } : { status: "updated", detail: "" },
    );
    const { d, last } = deps({ runUpdate });
    await runCliAutoUpdates(d);
    expect(last()).toEqual({ opencode: NOW });
    expect(d.onFailed).not.toHaveBeenCalled();
    // Next pass: codex is planned again; opencode is inside its interval.
    const next = await runCliAutoUpdates(d);
    expect(next?.run.map((j) => j.cli.id)).toEqual(["codex"]);
  });

  it("reports a failure quietly once and waits a full interval before retrying", async () => {
    const runUpdate = vi.fn(async (): Promise<CliUpdateOutcome> => ({ status: "failed", detail: "EACCES" }));
    const { d, last } = deps({ clis: () => [cli("codex")], runUpdate });
    await runCliAutoUpdates(d);
    expect(d.onFailed).toHaveBeenCalledWith(cli("codex"), { status: "failed", detail: "EACCES" });
    expect(last()).toEqual({ codex: NOW });
    const again = await runCliAutoUpdates(d);
    expect(again?.skipped.codex).toBe("recent");
    expect(runUpdate).toHaveBeenCalledTimes(1);
  });

  it("treats a rejected IPC call as a failure rather than crashing the pass", async () => {
    const runUpdate = vi.fn(async (): Promise<CliUpdateOutcome> => {
      throw new Error("ipc down");
    });
    const { d } = deps({ runUpdate });
    await runCliAutoUpdates(d);
    expect(d.onFailed).toHaveBeenCalledTimes(2);
  });

  it("stops mid-pass when the setting is switched off", async () => {
    let on = true;
    const runUpdate = vi.fn(async (): Promise<CliUpdateOutcome> => {
      on = false;
      return { status: "updated", detail: "" };
    });
    const { d } = deps({ enabled: () => on, runUpdate });
    await runCliAutoUpdates(d);
    expect(runUpdate).toHaveBeenCalledTimes(1);
  });
});
