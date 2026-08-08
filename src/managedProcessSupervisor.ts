import type { RunCommand } from "./projects";

export const MANAGED_PROCESS_ALIVE_SETTLE_MS = 2_500;
export const MANAGED_PROCESS_STALL_MS = 45_000;
export const MANAGED_PROMPT_RESPONSE_TIMEOUT_MS = 10_000;

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
  now: number;
  spawnedAt: number;
  outputBytes: number;
  quietMs: number | null;
  ports: readonly number[];
  readinessKind?: "port" | "http" | "process-alive" | "one-shot";
  rawOutput: string;
  exited?: boolean;
  exitCode?: number | null;
  /** When the supervisor already sent the supported answer for the prompt
   * still visible at the end of rawOutput. */
  safePromptHandledAt?: number | null;
}

export interface ManagedProcessClassification {
  state: ManagedProcessState;
  exit: ManagedProcessExit;
  deadlineAt: number | null;
  prompt: ManagedProcessPrompt | null;
}

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
  if (observation.exited) {
    return {
      state: observation.exitCode === 0 ? "exited-ok" : "failed",
      exit: observation.exitCode === 0 ? "complete" : "repair",
      deadlineAt: null,
      prompt: null,
    };
  }

  const prompt = detectManagedProcessPrompt(observation.rawOutput);
  if (prompt) {
    const responseExpired =
      prompt.kind === "safe-confirmation" &&
      observation.safePromptHandledAt != null &&
      observation.now - observation.safePromptHandledAt >=
        MANAGED_PROMPT_RESPONSE_TIMEOUT_MS;
    return {
      state: "waiting-on-input",
      exit:
        prompt.kind === "safe-confirmation" && !responseExpired
          ? "auto-answer"
          : "repair",
      deadlineAt:
        prompt.kind === "safe-confirmation" && !responseExpired
          ? (observation.safePromptHandledAt ?? observation.now) +
            MANAGED_PROMPT_RESPONSE_TIMEOUT_MS
          : null,
      prompt,
    };
  }

  const readiness = observation.readinessKind ?? "process-alive";
  const aliveLongEnough =
    observation.outputBytes > 0 &&
    observation.now - observation.spawnedAt >= MANAGED_PROCESS_ALIVE_SETTLE_MS;
  if (
    ((readiness === "port" || readiness === "http") && observation.ports.length > 0) ||
    (readiness === "process-alive" && aliveLongEnough)
  ) {
    return { state: "ready", exit: "complete", deadlineAt: null, prompt: null };
  }

  const quietMs = observation.quietMs ?? observation.now - observation.spawnedAt;
  if (quietMs >= MANAGED_PROCESS_STALL_MS) {
    return { state: "hung", exit: "repair", deadlineAt: null, prompt: null };
  }
  return {
    state: observation.outputBytes > 0 ? "working" : "spawning",
    exit: "observe",
    deadlineAt: observation.now + (MANAGED_PROCESS_STALL_MS - quietMs),
    prompt: null,
  };
}

const hasFlag = (command: string, flag: string) =>
  new RegExp(`(?:^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(
    command,
  );

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
    return `${next} --force`;
  }
  if (command.purpose === "setup" && /^npm\s+(?:install|i)\s*$/i.test(next)) {
    return `${next} --yes`;
  }
  return next;
}
