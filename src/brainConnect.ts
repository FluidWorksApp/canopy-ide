// Connecting the brain: which CLIs can be it, which one to recommend, what each
// connection state means in plain words, and the two interactive fixes (install,
// sign in) that have to happen in a real terminal.
//
// brain.ts answers "which CLI is the brain"; brainStatus.ts answers "is it
// answering". This is the layer the person sees in between — the first-run step,
// the Settings → Agents "Brain" section, the status-bar chip and every "Connect
// your brain" button all read it, so a state is described once and every fix is
// launched the same way.
//
// Never blocks the IDE. Files, terminals and git work with no brain at all (the
// outage constraint in the rethink report); only the intelligent surfaces wait
// on it, and they wait with a call to action rather than silently.

import { useSyncExternalStore } from "react";
import { installedBrain } from "./brain";
import {
  brainConnection,
  checkBrainConnection,
  subscribeBrainConnection,
  type BrainConnection,
  type BrainConnectionState,
} from "./brainStatus";
import {
  AGENT_CLIS,
  CLI_INSTALLS_CHANGED_EVENT,
  streamsStructured,
  structuredRunnerFor,
  type AgentCli,
} from "./projects";
import { loginCommand } from "./profiles";
import { companionCli } from "./companion";
import { updateSettings, type Settings } from "./settings";
import { brainArgs } from "./structuredRunners";

/** Asks the app to open the connect flow (BrainConnectHost listens). */
export const OPEN_BRAIN_CONNECT_EVENT = "canopy:connect-brain";
/** A terminal tab exited. ProjectView announces it with the `then` marker the
 *  opener put on the tab, so a sign-in flow can re-probe the moment it ends. */
export const TERMINAL_EXITED_EVENT = "canopy:terminal-exited";
/** The marker a sign-in terminal carries. */
export const BRAIN_RECHECK = "brain-recheck";

/** Whether `cli` can be the brain: a verified structured runner that can take
 *  one prompt and end with its answer. The same test askBrain applies, made
 *  with a throwaway launch so this never re-implements the runner's rules. */
export function canBeBrain(cli: AgentCli): boolean {
  const runner = structuredRunnerFor(cli.id);
  if (!runner || !streamsStructured(cli.id)) return false;
  return (
    brainArgs(
      runner,
      {
        bin: cli.bin,
        policy: {
          systemPromptAppend: "",
          permissionMode: "plan",
          disallowedTools: [],
          model: "",
          sessionId: "",
          authority: "read-only",
        },
      },
      "probe",
    ) !== null
  );
}

/** Every CLI that could be the brain, installed or not — what the "not
 *  installed" state offers to install. */
export function brainCapableClis(): AgentCli[] {
  return AGENT_CLIS.filter(canBeBrain);
}

/** The CLIs installed here that can be the brain, in registry order. */
export function brainCandidates(installed: (bin: string) => boolean): AgentCli[] {
  return brainCapableClis().filter((c) => installed(c.bin));
}

/** The brain to recommend: the person's choice when it can be one, else the
 *  first installed verified CLI. Null when none is installed. */
export function recommendedBrain(installed: (bin: string) => boolean): AgentCli | null {
  const chosen = installedBrain(installed);
  if (chosen && canBeBrain(chosen)) return chosen;
  return brainCandidates(installed)[0] ?? null;
}

/** Make `cliId` the brain and check it straight away. The brain is stored as
 *  `defaultAgent` (see brain.ts): one setting, one answer. */
export function chooseBrain(cliId: string): Promise<BrainConnection> {
  updateSettings({ defaultAgent: cliId });
  return checkBrainConnection();
}

/** Open the connect flow from anywhere (a chip, a call to action, the
 *  companion's "nothing to think with" state). */
export function openBrainConnect(): void {
  window.dispatchEvent(new Event(OPEN_BRAIN_CONNECT_EVENT));
}

/** Whether intelligent surfaces may run. "unknown" and "checking" are not
 *  connected yet, but they are not a reason to nag either — see brainNeedsConnect. */
export const brainReady = (c: BrainConnection): boolean => c.state === "connected";

/** States that mean the person has something to do before the brain works.
 *  "unknown"/"checking" are transient, "error" might be a blip — those show a
 *  quieter state, never the call to action. */
export const brainNeedsConnect = (state: BrainConnectionState): boolean =>
  state === "missing" || state === "signed-out";

/** Whether a surface should show the call to action rather than its smart
 *  control. Transient states keep the control; only "you have to do
 *  something" swaps it. */
export function useBrainBlocked(): boolean {
  return brainNeedsConnect(useBrainConnection().state);
}

/** The connection, as a hook. */
export function useBrainConnection(): BrainConnection {
  return useSyncExternalStore(subscribeBrainConnection, brainConnection, brainConnection);
}

export type BrainTone = "ok" | "busy" | "warn" | "bad" | "idle";

/** One sentence per state, for the chip, the connect panel and any call to
 *  action. `name` is the CLI's display name when one is known. */
export function brainStateText(
  c: Pick<BrainConnection, "state" | "label">,
): { tone: BrainTone; short: string; detail: string } {
  const name = c.label ?? "Your agent CLI";
  switch (c.state) {
    case "connected":
      return {
        tone: "ok",
        short: "Connected",
        detail: `${name} is signed in and answering. Canopy's smart features run on it.`,
      };
    case "checking":
      return { tone: "busy", short: "Checking…", detail: `Asking ${name} a one-word question.` };
    case "signed-out":
      return {
        tone: "bad",
        short: "Signed out",
        detail: `${name} is installed but not signed in. Sign in once and every smart feature works.`,
      };
    case "rate-limited":
      return {
        tone: "warn",
        short: "Rate-limited",
        detail: `${name}'s plan limit is reached. Smart features pause until it resets; files and terminals keep working.`,
      };
    case "missing":
      return {
        tone: "bad",
        short: "Not connected",
        detail: "No agent CLI that can power Canopy is installed yet.",
      };
    case "error":
      return {
        tone: "warn",
        short: "Not answering",
        detail: `${name} did not answer the last check. It may be offline or busy — check again in a moment.`,
      };
    case "unknown":
    default:
      return { tone: "idle", short: "Not checked", detail: "Canopy hasn't checked the brain yet." };
  }
}

/** How to sign `cli` in, in words, for when Canopy cannot open a terminal for
 *  it (no project open yet) — and as the caption beside the button when it can. */
export function signInSteps(cli: AgentCli): string {
  return `Run \`${loginCommand(cli.bin)}\` in a terminal and follow ${cli.name}'s sign-in prompt (it opens your browser). Then come back and press Check again.`;
}

/**
 * Ask the open project to run `command` in a terminal tab. Returns whether a
 * project took it: with no project open there is nowhere to put a terminal, and
 * the caller shows the command to run by hand instead.
 *
 * `then` rides on the tab and comes back on TERMINAL_EXITED_EVENT when the
 * process ends; `run: "chore"` makes an install a self-closing run tab whose
 * exit re-probes what is installed (ProjectView's existing install path).
 */
export function runInProjectTerminal(
  command: string,
  title: string,
  opts: { run?: "chore"; then?: string } = {},
): boolean {
  const detail: {
    command: string;
    title: string;
    run?: "chore";
    then?: string;
    handled?: boolean;
  } = { command, title, ...opts };
  window.dispatchEvent(new CustomEvent("canopy:run-command", { detail }));
  return detail.handled === true;
}

/** When a sign-in terminal was last opened, so returning to the window can
 *  re-probe while the person is plausibly mid-login. Zero once the sign-in
 *  tab has closed or the brain answered. */
let loginStartedAt = 0;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** While a sign-in tab is open, how often to ask whether it worked. A
 *  signed-out CLI refuses the probe before calling any model, so a probe that
 *  fails costs a process start, not a request. The first minutes are when
 *  sign-in actually finishes; after that the person has wandered off, so the
 *  checks slow down, and they stop with the sign-in window. */
const LOGIN_POLL_FAST_MS = 4_000;
const LOGIN_POLL_SLOW_MS = 30_000;
const LOGIN_POLL_FAST_FOR_MS = 5 * 60 * 1000;

/** Open a terminal running `cli`'s own sign-in. False when no project is open. */
export function startBrainSignIn(cli: AgentCli): boolean {
  const ok = runInProjectTerminal(loginCommand(cli.bin), `Sign in to ${cli.name}`, {
    then: BRAIN_RECHECK,
  });
  if (ok) {
    loginStartedAt = Date.now();
    lastLoginPoll = 0;
  }
  return ok;
}

/** When the sign-in poll last probed. */
let lastLoginPoll = 0;

/** One tick of the sign-in poll: probe when a sign-in tab is open, the brain
 *  still says signed out (or has not been checked since), no probe is
 *  already running, and the interval for this stage of the wait has passed.
 *  Exported for tests; initBrainConnect runs it on a timer. */
export function loginPollTick(now = Date.now()): boolean {
  if (!loginStartedAt) return false;
  const waited = now - loginStartedAt;
  if (waited > LOGIN_WINDOW_MS) {
    loginStartedAt = 0;
    return false;
  }
  const state = brainConnection().state;
  if (state === "connected") {
    loginStartedAt = 0;
    return false;
  }
  if (state === "checking" || state === "missing") return false;
  const gap = waited < LOGIN_POLL_FAST_FOR_MS ? LOGIN_POLL_FAST_MS : LOGIN_POLL_SLOW_MS;
  if (now - lastLoginPoll < gap) return false;
  lastLoginPoll = now;
  void checkBrainConnection();
  return true;
}

/** Run `cli`'s installer in a run tab. False when no project is open or the
 *  CLI has no installer. */
export function startBrainInstall(cli: AgentCli): boolean {
  if (!cli.install) return false;
  return runInProjectTerminal(cli.install, `install ${cli.name}`, { run: "chore" });
}

const STARTUP_PROBE_DELAY_MS = 4_000;
const FOCUS_RECHECK_GAP_MS = 10_000;

/**
 * Wire the connection to the events that change it, and probe once at start.
 * Returns a teardown. Called by BrainConnectHost, once per window.
 *
 *  - a sign-in terminal exiting → check again;
 *  - a CLI install landing → check again (brainCall drops its installed cache
 *    on the same event, and registered its listener first, at import);
 *  - the window regaining focus during a recent sign-in → check again, because
 *    the CLI's REPL usually stays open after login and its exit may be hours away;
 *  - while a sign-in tab is open → check every few seconds (loginPollTick),
 *    so Connected shows the moment sign-in finishes.
 *
 * The startup probe is one cheap background call per launch — the price of the
 * chip telling the truth instead of "not checked".
 */
export function initBrainConnect(opts: { probeOnStart?: boolean } = {}): () => void {
  const recheck = () => void checkBrainConnection();
  const onExited = (e: Event) => {
    if ((e as CustomEvent).detail?.then !== BRAIN_RECHECK) return;
    // The sign-in tab is gone: one last check, and the poll stops with it.
    loginStartedAt = 0;
    recheck();
  };
  let lastFocusCheck = 0;
  const onFocus = () => {
    const now = Date.now();
    if (now - loginStartedAt > LOGIN_WINDOW_MS) return;
    if (brainConnection().state !== "signed-out") return;
    if (now - lastFocusCheck < FOCUS_RECHECK_GAP_MS) return;
    lastFocusCheck = now;
    recheck();
  };
  window.addEventListener(TERMINAL_EXITED_EVENT, onExited);
  window.addEventListener(CLI_INSTALLS_CHANGED_EVENT, recheck);
  window.addEventListener("focus", onFocus);
  // Sign-in finishing is not an event anything raises — the CLI's REPL stays
  // open after login — so while a sign-in tab is open, ask on a short timer
  // and flip to Connected the moment the probe answers.
  const poll = setInterval(() => loginPollTick(), 1_000);
  const timer =
    opts.probeOnStart === false
      ? undefined
      : setTimeout(() => {
          if (brainConnection().state === "unknown") recheck();
        }, STARTUP_PROBE_DELAY_MS);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    clearInterval(poll);
    window.removeEventListener(TERMINAL_EXITED_EVENT, onExited);
    window.removeEventListener(CLI_INSTALLS_CHANGED_EVENT, recheck);
    window.removeEventListener("focus", onFocus);
  };
}

/** Tests only. */
export function resetBrainConnectForTests(): void {
  loginStartedAt = 0;
  lastLoginPoll = 0;
}

/** A feature that runs on something other than the brain, by the person's own
 *  choice. Shown in Settings as an explicit exception with a way back. */
export interface BrainException {
  /** Feature name, as the person knows it. */
  feature: string;
  /** What it uses instead, in words ("Codex", "the opus model"). */
  uses: string;
  /** The settings patch that puts it back on the brain. */
  reset: Partial<Settings>;
}

/**
 * Every per-feature engine override in effect. Today that is the companion
 * alone — its own CLI and model settings predate the brain — and everything
 * else (Build, repair, review, micro-tasks, launched agents, every askBrain
 * feature) already resolves through brain.ts. A setting naming a CLI that isn't
 * installed is not an exception: the companion falls back to the brain then.
 */
export function brainExceptions(
  s: Settings,
  installed: (bin: string) => boolean,
): BrainException[] {
  const brain = installedBrain(installed);
  const out: BrainException[] = [];
  const companion = companionCli(installed);
  if (companion && brain && companion.id !== brain.id) {
    out.push({
      feature: "Companion",
      uses: s.companionModel ? `${companion.name} (${s.companionModel})` : companion.name,
      reset: { companionCli: "", companionModel: "" },
    });
  } else if (companion && s.companionModel) {
    out.push({
      feature: "Companion",
      uses: `the ${s.companionModel} model`,
      reset: { companionCli: "", companionModel: "" },
    });
  }
  return out;
}

/** Plain names for the feature tags the meter keys on. A tag missing here
 *  shows as itself — new features need no edit to appear. */
const FEATURE_LABELS: Record<string, string> = {
  "connect-probe": "Connection checks",
  "commit-message": "Commit messages",
  "session-title": "Session names",
  receipt: "Proof receipts",
  plan: "Plans",
  review: "Reviews",
  awareness: "Awareness",
  handoff: "Handoffs",
  lens: "Lens",
  gates: "Gates",
  memory: "Memory",
  outcomes: "Outcomes",
};
export const featureLabel = (tag: string): string => FEATURE_LABELS[tag] ?? tag;

/** Parse a budget field: blank = no cap, anything else a non-negative number
 *  (or undefined when it isn't one yet, so a half-typed value is left alone). */
export function parseBudget(raw: string): number | null | undefined {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t.replace(/^\$/, ""));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
