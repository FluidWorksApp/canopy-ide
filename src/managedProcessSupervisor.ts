import type { RunCommand } from "./projects";

export const MANAGED_PROCESS_ALIVE_SETTLE_MS = 2_500;
export const MANAGED_PROCESS_STALL_MS = 45_000;
export const MANAGED_PROCESS_STARTUP_MS = 180_000;
export const MANAGED_PROMPT_RESPONSE_TIMEOUT_MS = 10_000;

export type ManagedProcessKind = NonNullable<RunCommand["purpose"]>;
const MANAGED_PROCESS_KIND_SET = {
  setup: true,
  serve: true,
  worker: true,
  check: true,
} as const satisfies Record<ManagedProcessKind, true>;
export const MANAGED_PROCESS_KINDS = Object.keys(
  MANAGED_PROCESS_KIND_SET,
) as ManagedProcessKind[];

/** Baseline for every unattended process the app owns. Command-specific
 * supported flags are still preferred; these cover package/update notifiers
 * that otherwise decide to ask merely because a PTY is attached. */
export const MANAGED_PROCESS_ENV: readonly [string, string][] = [
  ["CI", "1"],
  ["npm_config_yes", "true"],
  ["NO_UPDATE_NOTIFIER", "1"],
];

export type ManagedProcessState =
  | "spawning"
  | "working"
  | "waiting-on-input"
  | "ready"
  | "exited-ok"
  | "failed"
  | "hung";

const MANAGED_PROCESS_STATE_SET = {
  spawning: true,
  working: true,
  "waiting-on-input": true,
  ready: true,
  "exited-ok": true,
  failed: true,
  hung: true,
} as const satisfies Record<ManagedProcessState, true>;
export const MANAGED_PROCESS_STATES = Object.keys(
  MANAGED_PROCESS_STATE_SET,
) as ManagedProcessState[];

export type ManagedProcessExit =
  | "observe"
  | "auto-answer"
  | "complete"
  | "repair";

export type ManagedProcessPrompt =
  | {
      kind: "safe-confirmation";
      code: "npx-install" | "pnpm-modules-reinstall";
      response: "y\r";
      excerpt: string;
    }
  | {
      kind: "interactive";
      code: "authentication" | "selection" | "confirmation";
      excerpt: string;
    };

export interface ManagedProcessObservation {
  kind?: ManagedProcessKind;
  now: number;
  spawnedAt: number;
  outputBytes: number;
  quietMs: number | null;
  ports: readonly number[];
  readinessKind?: "port" | "http" | "process-alive" | "one-shot";
  /** Result of probing the declared HTTP path on the process-owned ports.
   * A listening socket by itself is deliberately not HTTP readiness. */
  httpReady?: boolean;
  /** A one-shot command may declare a longer bounded window. Long-lived
   * processes use the shared startup deadline. */
  readinessTimeoutMs?: number;
  rawOutput: string;
  exited?: boolean;
  exitCode?: number | null;
  /** When the supervisor already sent the supported answer for the prompt
   * still visible at the end of rawOutput. */
  safePromptHandledAt?: number | null;
}

export interface ManagedProcessClassification {
  kind: ManagedProcessKind;
  state: ManagedProcessState;
  exit: ManagedProcessExit;
  /** The contract-level way out of this state. The supervisor is the first
   * responder for every current process state; it may later produce a human
   * decision card when repair proves that a real decision is required. */
  surface: "agent-exit" | "chat-card-exit";
  deadlineAt: number | null;
  prompt: ManagedProcessPrompt | null;
}

const managedProcessSurface = (
  state: ManagedProcessState,
): ManagedProcessClassification["surface"] => {
  // Intentionally exhaustive. Adding a state without choosing one of the two
  // Build exits fails typecheck, while MANAGED_PROCESS_STATES makes the same
  // omission visible to the behavioural matrix.
  switch (state) {
    case "spawning":
    case "working":
    case "waiting-on-input":
    case "ready":
    case "exited-ok":
    case "failed":
    case "hung":
      return "agent-exit";
    default: {
      const missingState: never = state;
      return missingState;
    }
  }
};

const classification = (
  kind: ManagedProcessKind,
  state: ManagedProcessState,
  exit: ManagedProcessExit,
  deadlineAt: number | null,
  prompt: ManagedProcessPrompt | null,
): ManagedProcessClassification => ({
  kind,
  state,
  exit,
  surface: managedProcessSurface(state),
  deadlineAt,
  prompt,
});

// Prompt matching does not need a full terminal emulator: the questions we
// care about are printable text. Remove CSI/OSC escapes and carriage-return
// repainting so a prompt remains matchable even when a CLI colours it.
export function plainManagedOutput(raw: string): string {
  return raw
    // oxlint-disable-next-line no-control-regex -- ANSI OSC terminators are control bytes.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    // oxlint-disable-next-line no-control-regex -- ANSI CSI starts with the ESC control byte.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll("\r", "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(-8_000);
}

const excerptOf = (text: string) => text.split("\n").slice(-8).join("\n").slice(-1_200);

/** Classify only prompts supported by observed terminal evidence. Build may
 * answer the two dependency confirmations because it selected those exact
 * commands. Authentication, selection, and generic questions are decisions,
 * so the supervisor routes them to an agent instead of guessing. */
export function detectManagedProcessPrompt(raw: string): ManagedProcessPrompt | null {
  const text = plainManagedOutput(raw);
  if (!text) return null;
  const excerpt = excerptOf(text);
  if (
    /need to install the following packages[\s\S]{0,1200}ok to proceed\?\s*\(?y(?:es)?\/?n?\)?\s*$/i.test(
      text,
    )
  ) {
    return { kind: "safe-confirmation", code: "npx-install", response: "y\r", excerpt };
  }
  if (
    /modules directory[\s\S]{0,1200}(?:removed|reinstalled)[\s\S]{0,600}proceed\?\s*\(?y\/?n\)?\s*$/i.test(
      text,
    )
  ) {
    return {
      kind: "safe-confirmation",
      code: "pnpm-modules-reinstall",
      response: "y\r",
      excerpt,
    };
  }
  if (
    /(?:log[ -]?in|sign[ -]?in|authenticate|authorization|device code|api key|access token|password|open (?:the )?browser)[^\n]*[?:]?\s*$/i.test(
      text,
    )
  ) {
    return { kind: "interactive", code: "authentication", excerpt };
  }
  if (/(?:select|choose|pick)\s+(?:an? |the )?[^\n:]{1,80}:\s*$/i.test(text)) {
    return { kind: "interactive", code: "selection", excerpt };
  }
  if (
    /(?:ok to proceed|proceed|continue|do you want to|would you like to)[^\n?]{0,100}\?\s*(?:\([yn](?:\/[yn])?\)|\[[yn](?:\/[yn])?\])?\s*$/i.test(
      text,
    )
  ) {
    return { kind: "interactive", code: "confirmation", excerpt };
  }
  return null;
}

/** One classifier for every process the app manages. Every state declares its
 * exit: continue observing under a deadline, complete, auto-answer a proven
 * safe prompt, or hand evidence to a repair agent. */
export function classifyManagedProcess(
  observation: ManagedProcessObservation,
): ManagedProcessClassification {
  const kind = observation.kind ?? "serve";
  if (observation.exited) {
    return observation.exitCode === 0 && (kind === "setup" || kind === "check" || observation.readinessKind === "one-shot")
      ? classification(kind, "exited-ok", "complete", null, null)
      : classification(kind, "failed", "repair", observation.now, null);
  }

  const prompt = detectManagedProcessPrompt(observation.rawOutput);
  if (prompt) {
    const responseExpired =
      prompt.kind === "safe-confirmation" &&
      observation.safePromptHandledAt != null &&
      observation.now - observation.safePromptHandledAt >=
        MANAGED_PROMPT_RESPONSE_TIMEOUT_MS;
    const mayAnswer = prompt.kind === "safe-confirmation" && !responseExpired;
    return classification(
      kind,
      "waiting-on-input",
      mayAnswer ? "auto-answer" : "repair",
      mayAnswer
        ? (observation.safePromptHandledAt ?? observation.now) +
          MANAGED_PROMPT_RESPONSE_TIMEOUT_MS
        : observation.now,
      prompt,
    );
  }

  const readiness = observation.readinessKind ?? "process-alive";
  const aliveLongEnough =
    observation.now - observation.spawnedAt >= MANAGED_PROCESS_ALIVE_SETTLE_MS;
  if (
    (readiness === "port" && observation.ports.length > 0) ||
    (readiness === "http" && observation.httpReady === true) ||
    (readiness === "process-alive" && aliveLongEnough)
  ) {
    return classification(kind, "ready", "complete", null, null);
  }

  const readinessTimeoutMs =
    observation.readinessTimeoutMs != null
      ? observation.readinessTimeoutMs
      : MANAGED_PROCESS_STARTUP_MS;
  const deadlineAt = observation.spawnedAt + readinessTimeoutMs;
  if (observation.now >= deadlineAt) {
    return classification(kind, "hung", "repair", deadlineAt, null);
  }
  return classification(
    kind,
    observation.outputBytes > 0 ? "working" : "spawning",
    "observe",
    deadlineAt,
    null,
  );
}

const hasFlag = (command: string, flag: string) =>
  new RegExp(`(?:^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(
    command,
  );

/** Normalize the actual argv launch too: argv takes precedence over shell text. */
export function unattendedManagedRunArgv(
  command: Pick<RunCommand, "argv" | "purpose"> | undefined,
): string[] | undefined {
  if (!command?.argv) return undefined;
  const next = [...command.argv];
  if (next[0] === "npx" && !next.includes("--yes") && !next.includes("-y")) next.splice(1, 0, "--yes");
  if (next[0] === "npm" && ["exec", "x"].includes(next[1]) && !next.includes("--yes") && !next.includes("-y")) next.splice(2, 0, "--yes");
  const trigger = next.findIndex((arg) => /^trigger(?:\.dev)?(?:@[^\s]+)?$/.test(arg));
  if (trigger >= 0 && next[trigger + 1] === "dev" && !next.includes("--skip-update-check")) next.splice(trigger + 2, 0, "--skip-update-check");
  if (command.purpose === "setup" && next.length === 2 && ["install", "i"].includes(next[1])) {
    if (next[0] === "pnpm") next.push("--force", "--no-frozen-lockfile");
    if (next[0] === "npm") next.push("--yes");
  }
  return next;
}

/** Prevent known package-runner prompts before the PTY starts. These are
 * vendor-supported flags, not a blanket `yes` pipe; unrelated prompts remain
 * visible to the classifier and repair agent. */
export function unattendedManagedRunCommand(
  command: Pick<RunCommand, "command" | "purpose">,
): string {
  let next = command.command.trim();
  if (/^npx\s+/i.test(next) && !/^npx\s+(?:-y|--yes)(?:\s|$)/i.test(next)) {
    next = next.replace(/^npx\s+/i, "npx --yes ");
  } else if (/^npm\s+(?:exec|x)\s+/i.test(next) && !hasFlag(next, "--yes") && !hasFlag(next, "-y")) {
    next = next.replace(/^(npm\s+(?:exec|x))\s+/i, "$1 --yes ");
  }
  if (
    /\btrigger(?:\.dev)?(?:@[^\s]+)?\s+dev\b/i.test(next) &&
    !hasFlag(next, "--skip-update-check")
  ) {
    next = next.replace(
      /(\btrigger(?:\.dev)?(?:@[^\s]+)?\s+dev\b)/i,
      "$1 --skip-update-check",
    );
  }
  if (command.purpose === "setup" && /^pnpm\s+(?:install|i)\s*$/i.test(next)) {
    return `${next} --force --no-frozen-lockfile`;
  }
  if (command.purpose === "setup" && /^npm\s+(?:install|i)\s*$/i.test(next)) {
    return `${next} --yes`;
  }
  return next;
}
