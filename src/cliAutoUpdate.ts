// Keeping the agent CLIs current (Settings → Agents → "Keep agent CLIs up to
// date", `autoUpdateClis`, on by default).
//
// The split of responsibilities:
//
//   * The registry (projects.ts `autoUpdate`) says, per CLI, whether it updates
//     itself ("native": claude, grok, agy) or Canopy should ("canopy"), with a
//     dated stamp of the evidence.
//   * The version probe (`cli_versions`) says how each CLI was installed and
//     therefore which command updates *that* copy (brew / npm / pnpm / pipx /
//     uv / the venv's pip), falling back to the CLI's own updater.
//   * This module decides *when*: a pure planner (`planCliAutoUpdates`, the
//     tested part) and a scheduler that runs it shortly after start-up and
//     then hourly, attempting each CLI at most once a day.
//   * Rust (`cli_run_update`) decides whether it is *safe right now* — never
//     while a process of that CLI is running — and runs it with no stdin and
//     a deadline. A deferred CLI is simply tried again on the next tick.
//
// Desktop-local only. Remote workspaces follow agents.lock.json (exact
// versions, checksums) and get new CLIs with image releases; every call here
// goes to the desktop (`invokeDesktop`), and the portal and read-only hosts
// never schedule at all.

import { useEffect } from "react";
import { invokeDesktop, isReadOnlyHost, isRemoteHost, isWorkspaceHost } from "./host";
import {
  AGENT_CLIS,
  announceCliInstallsChanged,
  autoUpdateCommand,
  checkCliUpdates,
  type AgentCli,
  type CliUpdate,
} from "./projects";
import { getSettings, subscribeSettings } from "./settings";
import { postAttention } from "./attention";

/** A CLI is attempted at most this often, whatever the outcome — a failing
 *  updater must not run (and notify) every hour. */
export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How often the plan is re-evaluated. Cheap: the registry's "latest" is
 *  cached for 6h (checkCliUpdates), and a CLI deferred because it was running
 *  gets its next chance within the hour rather than tomorrow. */
export const AUTO_UPDATE_TICK_MS = 60 * 60 * 1000;
/** Start-up already saturates the process-capture queue (restored terminals,
 *  version probes — see PROBE_RETRY_DELAYS_MS in agents.rs); stay out of it. */
export const AUTO_UPDATE_FIRST_RUN_MS = 90 * 1000;
/** npm and pip can be slow on a cold cache; a hung updater still ends. */
export const AUTO_UPDATE_TIMEOUT_SECS = 10 * 60;

const LAST_ATTEMPT_KEY = "canopy.cliAutoUpdate.v1";

export type AutoUpdateSkip =
  | "not-installed"
  | "rebound"
  | "custom"
  | "native"
  | "no-updater"
  | "current"
  | "recent";

export interface AutoUpdateJob {
  cli: AgentCli;
  command: string;
  /** `outdated`: the registry has a newer version. `unversioned`: the CLI has
   *  no registry to ask (agy, omp, cursor, grok), so its idempotent updater
   *  is the only way to find out. */
  reason: "outdated" | "unversioned";
}

export interface AutoUpdatePlan {
  run: AutoUpdateJob[];
  skipped: Record<string, AutoUpdateSkip>;
}

/**
 * Which CLIs to update now, and why the others are left alone. Pure, so every
 * rule is a table test:
 *
 *  - the setting off → nothing at all;
 *  - only CLIs the probe positively found (an unanswered probe is not "missing",
 *    and is not "present" either);
 *  - never a rebound (enterprise) binary — `latestUrl` is the public registry
 *    and a sanctioned build is not ours to overwrite — nor a custom CLI;
 *  - a self-updating CLI is left to its own updater unless Homebrew owns the
 *    install, which native updaters do not touch;
 *  - only with an unattended-safe command (install-matched or the CLI's own
 *    updater, never its installer);
 *  - only when outdated, or when there is no registry to compare against;
 *  - at most once per AUTO_UPDATE_INTERVAL_MS per CLI.
 */
export function planCliAutoUpdates(input: {
  enabled: boolean;
  clis: readonly AgentCli[];
  installed: Record<string, boolean> | null;
  updates: Record<string, CliUpdate>;
  lastAttempt: Record<string, number>;
  now: number;
}): AutoUpdatePlan {
  const plan: AutoUpdatePlan = { run: [], skipped: {} };
  if (!input.enabled) return plan;
  for (const cli of input.clis) {
    const skip = (why: AutoUpdateSkip) => {
      plan.skipped[cli.id] = why;
    };
    if (input.installed?.[cli.bin] !== true) {
      skip("not-installed");
      continue;
    }
    if (cli.rebound) {
      skip("rebound");
      continue;
    }
    if (cli.custom || !cli.autoUpdate) {
      skip("custom");
      continue;
    }
    const probed = input.updates[cli.bin];
    if (cli.autoUpdate.mechanism === "native" && probed?.managedBy !== "homebrew") {
      skip("native");
      continue;
    }
    const command = autoUpdateCommand(cli, probed);
    if (!command) {
      skip("no-updater");
      continue;
    }
    const reason: AutoUpdateJob["reason"] | null = probed?.hasUpdate
      ? "outdated"
      : !cli.latestUrl
        ? "unversioned"
        : null;
    if (!reason) {
      skip("current");
      continue;
    }
    const last = input.lastAttempt[cli.id];
    if (last != null && input.now - last < AUTO_UPDATE_INTERVAL_MS) {
      skip("recent");
      continue;
    }
    plan.run.push({ cli, command, reason });
  }
  return plan;
}

/** What `cli_run_update` answers (cli_update.rs CliUpdateOutcome). */
export interface CliUpdateOutcome {
  status: "updated" | "deferred" | "failed";
  detail: string;
}

/** Everything the runner touches outside itself, injectable for tests. */
export interface AutoUpdateDeps {
  enabled: () => boolean;
  /** False where this window must not schedule (portal, read-only host). */
  allowed: () => boolean;
  clis: () => readonly AgentCli[];
  probeInstalled: () => Promise<Record<string, boolean> | null>;
  checkUpdates: () => Promise<Record<string, CliUpdate>>;
  runUpdate: (bin: string, command: string) => Promise<CliUpdateOutcome>;
  loadLastAttempt: () => Record<string, number>;
  saveLastAttempt: (value: Record<string, number>) => void;
  onUpdated: (cli: AgentCli) => void;
  onFailed: (cli: AgentCli, outcome: CliUpdateOutcome) => void;
  now: () => number;
}

function loadLastAttempt(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_ATTEMPT_KEY) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function saveLastAttempt(value: Record<string, number>): void {
  try {
    localStorage.setItem(LAST_ATTEMPT_KEY, JSON.stringify(value));
  } catch {
    // Storage refused: the worst case is one extra attempt after a restart.
  }
}

export const defaultAutoUpdateDeps: AutoUpdateDeps = {
  enabled: () => getSettings().autoUpdateClis,
  // The portal is a browser driving the desktop, which schedules for itself;
  // a workspace window still reaches its desktop through invokeDesktop.
  allowed: () => !isReadOnlyHost() && (!isRemoteHost() || isWorkspaceHost()),
  clis: () => AGENT_CLIS,
  probeInstalled: async () => {
    try {
      return await invokeDesktop<Record<string, boolean>>("which_check", {
        commands: AGENT_CLIS.map((c) => c.bin),
      });
    } catch {
      return null;
    }
  },
  checkUpdates: () => checkCliUpdates(invokeDesktop),
  runUpdate: (bin, command) =>
    invokeDesktop<CliUpdateOutcome>("cli_run_update", {
      bin,
      command,
      timeoutSecs: AUTO_UPDATE_TIMEOUT_SECS,
    }),
  loadLastAttempt,
  saveLastAttempt,
  onUpdated: (cli) => {
    console.info(`[cli auto-update] ${cli.name} updated`);
  },
  // Quiet by design: an FYI in the bell ("info" is low urgency — it fades and
  // never reaches the OS), keyed per CLI so a repeat failure replaces the
  // last one instead of stacking.
  onFailed: (cli, outcome) => {
    console.warn(`[cli auto-update] ${cli.name}: ${outcome.detail}`);
    postAttention({
      kind: "fyi",
      tone: "info",
      source: "app",
      title: `Couldn't update ${cli.name} automatically`,
      body: `${outcome.detail.slice(0, 600)}\n\nCanopy will try again tomorrow. Turn this off in Settings → Agents.`,
      dedupeKey: `cli-auto-update:${cli.id}`,
    });
  },
  now: () => Date.now(),
};

let inFlight: Promise<AutoUpdatePlan | null> | null = null;

/**
 * One pass: probe, plan, then run the plan one CLI at a time (two package
 * managers writing one global prefix at once is how installs get corrupted;
 * Rust enforces the same). Single-flight per window. Resolves with the plan it
 * acted on, or null when it did not run.
 */
export function runCliAutoUpdates(
  deps: AutoUpdateDeps = defaultAutoUpdateDeps,
): Promise<AutoUpdatePlan | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!deps.enabled() || !deps.allowed()) return null;
    const installed = await deps.probeInstalled();
    if (!installed) return null;
    const updates = await deps.checkUpdates();
    const lastAttempt = { ...deps.loadLastAttempt() };
    const plan = planCliAutoUpdates({
      enabled: deps.enabled(),
      clis: deps.clis(),
      installed,
      updates,
      lastAttempt,
      now: deps.now(),
    });
    let changed = false;
    for (const job of plan.run) {
      // Re-read between jobs: switching the setting off mid-pass stops it.
      if (!deps.enabled()) break;
      let outcome: CliUpdateOutcome;
      try {
        outcome = await deps.runUpdate(job.cli.bin, job.command);
      } catch (error) {
        outcome = { status: "failed", detail: String(error) };
      }
      // Deferred is "not attempted": no stamp, so the next tick retries it.
      if (outcome.status === "deferred") continue;
      lastAttempt[job.cli.id] = deps.now();
      deps.saveLastAttempt(lastAttempt);
      if (outcome.status === "updated") {
        changed = true;
        deps.onUpdated(job.cli);
      } else {
        deps.onFailed(job.cli, outcome);
      }
    }
    if (changed) announceCliInstallsChanged();
    return plan;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Mounted once, in App: the first pass after start-up settles, then hourly,
 *  plus a prompt pass when the setting is switched back on. */
export function useCliAutoUpdater(): void {
  useEffect(() => {
    const pass = () => void runCliAutoUpdates().catch((error) =>
      console.warn("[cli auto-update] pass failed", error),
    );
    const first = window.setTimeout(pass, AUTO_UPDATE_FIRST_RUN_MS);
    const tick = window.setInterval(pass, AUTO_UPDATE_TICK_MS);
    let wasOn = getSettings().autoUpdateClis;
    const unsubscribe = subscribeSettings(() => {
      const on = getSettings().autoUpdateClis;
      if (on && !wasOn) pass();
      wasOn = on;
    });
    return () => {
      window.clearTimeout(first);
      window.clearInterval(tick);
      unsubscribe();
    };
  }, []);
}
