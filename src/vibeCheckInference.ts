// The check half of `vibeTargetInference.ts`. That module answers "what runs
// this app?"; this one answers "what proves the change is sound?".
//
// The gap it closes: `contractFor` in `vibeBuilderSession.ts` always requires a
// `check` observation, but target inference only ever synthesises a Dev/Start
// command, and ProjectView derives the check by name-matching the component's
// *configured* commands. A project Canopy set up from nothing configures none,
// so the check observation is `unknown` on every turn, the turn is permanently
// `incomplete`, and `verified` is structurally unreachable — for precisely the
// users who did the least setup.
//
// Pure and dependency-free, the same as `inferVibeTarget`: package facts are
// loaded by `vibePackageScripts.ts` and passed in, so this file can be reasoned
// about (and tested) without a filesystem.
//
// The deliberate shape: when nothing can serve as a check this returns an
// explicit gap carrying a sentence a non-coder can read, never `null` and never
// a fabricated command. A caller handed `null` can only stay quiet, and a quiet
// unreachable `verified` is the exact failure this module exists to prevent.

import type { Component, RunCommand } from "./projects";

export type VibeCheckRunner = "npm" | "pnpm" | "yarn" | "bun";

/** The package.json script keys that can stand in as a check, best first. */
export type VibeCheckScript = "check" | "typecheck" | "tsc" | "test" | "build";

// Priority order, and why it is this order:
//
//  1. `check`      — a script the project literally named "check" is its own
//                    declared gate. Deferring to it beats anything we'd guess.
//  2. `typecheck`  — cheapest, deterministic, no side effects, never watches,
//  3. `tsc`          and it catches the failure an AI edit actually produces
//                    most often: a rename or a prop that no longer type-checks.
//                    It is the check most likely to be *about the edit*.
//  4. `test`       — stronger evidence, but slower, and in a young project the
//                    suite is often thin or absent, so a pass says less than a
//                    typecheck pass costs.
//  5. `build`      — the strongest end-to-end signal and the last resort: it is
//                    the slowest by far and it writes artefacts into the user's
//                    tree, which a verification step should avoid doing when a
//                    read-only check would have answered the same question.
//
// `lint` is deliberately absent, matching the vocabulary ProjectView already
// uses: a lint failure is a style opinion, not evidence the app is broken, and
// including it would hold `verified` hostage to formatting.
const CHECK_ORDER: readonly VibeCheckScript[] = [
  "check",
  "typecheck",
  "tsc",
  "test",
  "build",
];

/** Exactly ProjectView's existing derivation regex, so a project that already
 *  gets a check today keeps getting the same one. */
const CHECKISH = /^(check|typecheck|test|build)$/i;

const SCRIPT_NAMES: Record<VibeCheckScript, string> = {
  check: "Check",
  typecheck: "Typecheck",
  tsc: "Typecheck",
  test: "Test",
  build: "Build",
};

/** Package facts in the shape `vibePackageScripts.ts` produces, widened to
 *  carry the check-ish script keys alongside dev/start. `parseVibePackageFact`
 *  currently narrows `scripts` to `{ dev, start }`; widening that one literal
 *  is the whole loader change this module needs. `VibePackageFacts` is already
 *  assignable here, so a caller can pass today's facts — it will simply always
 *  find no scripts, which is the honest answer for a fact that dropped them. */
export type VibeCheckPackageFact =
  | {
      status: "loaded";
      scripts: Partial<Record<VibeCheckScript, string>>;
      runner: VibeCheckRunner;
    }
  | { status: "missing" | "invalid" | "error" };

export type VibeCheckPackageFacts = Readonly<
  Record<string, VibeCheckPackageFact | undefined>
>;

/** The already-chosen Build target. The check is scoped to that one component,
 *  the same way ProjectView scopes it, and never reuses the run command. */
export interface VibeCheckTarget {
  componentId: string;
  runCommandId?: string | null;
}

export interface VibeCheckSelection {
  componentId: string;
  runCommandId: string;
  /** Present only when the command was synthesised and must be persisted. */
  addCommand?: RunCommand;
}

/** Why no check exists, for a surface that wants to branch rather than print. */
export type VibeCheckGap =
  | "no-component"
  | "no-package"
  | "unreadable-package"
  | "no-script"
  | "unusable-script";

export type VibeCheckInference =
  | {
      kind: "check";
      selection: VibeCheckSelection;
      /** The literal text to run, ready to hand to `checkCommand`. */
      command: string;
      source: "existing-command" | "package-script";
      /** Set when the pick was not the only reasonable one, so the surface can
       *  say which check it used instead of leaving the user to guess. */
      caveat?: string;
    }
  | { kind: "needs-package-facts"; componentIds: string[] }
  | {
      kind: "none";
      gap: VibeCheckGap;
      /** One sentence, readable by someone who does not write code, saying why
       *  `verified` cannot be reached and what would fix it. */
      caveat: string;
    };

// npm's `npm init` default: `echo "Error: no test specified" && exit 1`.
// Running it would fail every single turn and blame the user's change for it.
const PLACEHOLDER_TEST = /no test specified/i;

// A check that never exits produces no evidence at all — it just hangs the
// turn. Bare `vitest` watches; `vitest run` does not. `--watch` is explicit.
const WATCHES = /--watch\b|(^|[\s&|;])vitest(?!\s+(run|related|bench)\b)(\s|$)/;

type Rejection = "placeholder" | "watch";

const REJECTION_TEXT: Record<Rejection, string> = {
  placeholder: "is npm's placeholder that always fails, not a real test",
  watch: "watches for changes instead of finishing, so it would never report",
};

function rejectScript(script: string): Rejection | null {
  if (PLACEHOLDER_TEST.test(script)) return "placeholder";
  if (WATCHES.test(script)) return "watch";
  return null;
}

// Byte-identical to `vibeTargetInference.ts`'s hash on purpose: synthesised
// check commands must land in the same `vibe-` id namespace as synthesised dev
// commands, so the collision loop below can see both.
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function packageCommand(
  components: readonly Component[],
  component: Component,
  script: VibeCheckScript,
  runner: VibeCheckRunner,
): { command: RunCommand; addCommand?: RunCommand } {
  const commandText = `${runner} run ${script}`;
  const seed = `${component.id}:package.json:${script}`;
  const used = new Map(
    components.flatMap((candidate) =>
      (candidate.commands ?? []).map((command) => [command.id, command] as const),
    ),
  );
  let attempt = 0;
  while (true) {
    const id = `vibe-${stableHash(attempt ? `${seed}:${attempt}` : seed)}`;
    const existing = used.get(id);
    if (!existing) {
      const command = { id, name: SCRIPT_NAMES[script], command: commandText };
      return { command, addCommand: command };
    }
    if (
      (component.commands ?? []).includes(existing) &&
      existing.command.trim() === commandText
    ) {
      return { command: existing };
    }
    attempt += 1;
  }
}

const gap = (kind: VibeCheckGap, caveat: string): VibeCheckInference => ({
  kind: "none",
  gap: kind,
  caveat,
});

const list = (names: readonly string[]): string =>
  names.length <= 1
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** Pure check inference. Mirrors `inferVibeTarget`: configured commands first,
 *  package scripts second, and an explicit, explained gap when neither exists.
 *
 *  On ties: `inferVibeTarget` asks the user, because picking the wrong dev
 *  server runs the wrong app and only they can say which one they meant. That
 *  concept does not apply here. The check is scoped to the one component the
 *  target already chose, and CHECK_ORDER is a total order over the candidates,
 *  so there is nothing left to adjudicate. Where several *configured* commands
 *  qualify we keep ProjectView's existing pick — the user's own array order —
 *  and surface the others as a caveat rather than silently discarding them. */
export function inferVibeCheck(
  components: readonly Component[],
  target: VibeCheckTarget,
  packageFacts: VibeCheckPackageFacts = {},
): VibeCheckInference {
  const component = components.find(
    (candidate) => candidate.id === target.componentId,
  );
  if (!component) {
    return gap(
      "no-component",
      "I can't find the part of the project to check, so nothing here can be verified.",
    );
  }

  const commands = component.commands ?? [];
  const runCommand = commands.find((command) => command.id === target.runCommandId);
  const configured = commands.filter(
    (command) =>
      Boolean(command.command.trim()) &&
      // Excluded by id *and* by name: the id keeps us off the exact command
      // already running the app, and the name match is what ProjectView does
      // today, so a project that works now keeps the command it works with.
      command.id !== runCommand?.id &&
      command.name !== runCommand?.name &&
      CHECKISH.test(command.name),
  );
  if (configured.length > 0) {
    const [chosen, ...rest] = configured;
    return {
      kind: "check",
      selection: { componentId: component.id, runCommandId: chosen.id },
      command: chosen.command.trim(),
      source: "existing-command",
      ...(rest.length > 0
        ? {
            caveat: `I'm checking with ${chosen.name}; ${component.label} also has ${list(rest.map((command) => command.name))}, which I'm not running.`,
          }
        : {}),
    };
  }

  const fact = packageFacts[component.id];
  if (fact === undefined) {
    return { kind: "needs-package-facts", componentIds: [component.id] };
  }
  if (fact.status === "missing") {
    return gap(
      "no-package",
      `${component.label} has no package.json, so there's no check I can run — turns here stay unverified until one exists.`,
    );
  }
  if (fact.status !== "loaded") {
    return gap(
      "unreadable-package",
      `I couldn't read ${component.label}'s package.json, so there's no check I can run — turns here stay unverified until it parses.`,
    );
  }

  const present = CHECK_ORDER.map((script) => ({
    script,
    text: fact.scripts[script]?.trim() ?? "",
  })).filter((candidate) => Boolean(candidate.text));
  const usable = present.filter(
    (candidate) => rejectScript(candidate.text) === null,
  );
  if (usable.length === 0) {
    if (present.length === 0) {
      return gap(
        "no-script",
        `${component.label} has no check, typecheck, test or build script, so there's no check I can run — turns here stay unverified until you add one.`,
      );
    }
    const reasons = present.map(
      (candidate) =>
        `${candidate.script} ${REJECTION_TEXT[rejectScript(candidate.text)!]}`,
    );
    return gap(
      "unusable-script",
      `${component.label}'s ${list(present.map((candidate) => candidate.script))} script${present.length === 1 ? "" : "s"} can't serve as a check (${list(reasons)}), so turns here stay unverified until one runs once and exits.`,
    );
  }

  const chosen = usable[0];
  const resolved = packageCommand(
    components,
    component,
    chosen.script,
    fact.runner,
  );
  return {
    kind: "check",
    selection: {
      componentId: component.id,
      runCommandId: resolved.command.id,
      ...(resolved.addCommand ? { addCommand: resolved.addCommand } : {}),
    },
    command: resolved.command.command,
    source: "package-script",
  };
}
