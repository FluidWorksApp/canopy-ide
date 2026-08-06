import type { StructuredRunnerEvent } from "./structuredEvents";
import type { VibeCheckScript } from "./vibeCheckInference";
import type { BuilderSession } from "./vibeBuilderSessionTypes";
import type { Component, Project, RunCommand } from "./projects";

const DEVISH = /dev|start|serve/i;

export type VibePackageFact =
  | {
      status: "loaded";
      /** Dev/start are what this module reads; the check-ish keys ride along
       *  for `inferVibeCheck`, which is scoped to the component this one
       *  chooses and would otherwise need a second read of the same file. */
      scripts: Partial<Record<"dev" | "start" | VibeCheckScript, string>>;
      runner: "npm" | "pnpm" | "yarn" | "bun";
    }
  | { status: "missing" | "invalid" | "error" };

export type VibePackageFacts = Readonly<
  Record<string, VibePackageFact | undefined>
>;

export interface VibeTargetSelection {
  componentId: string;
  runCommandId: string;
  addCommand?: RunCommand;
}

export interface VibeTargetChoice {
  key: string;
  label: string;
  response: string;
  selection: VibeTargetSelection;
}

export type VibeTargetInference =
  | {
      kind: "persist";
      selection: VibeTargetSelection;
      source: "existing-command" | "package-script";
    }
  | { kind: "needs-package-facts"; componentIds: string[] }
  | {
      kind: "ask";
      prompt: string;
      choices: VibeTargetChoice[];
    }
  | { kind: "unavailable" };

interface Candidate {
  component: Component;
  command: RunCommand;
  addCommand?: RunCommand;
  source: "existing-command" | "package-script";
}

const commandLooksRunnable = (command: RunCommand): boolean =>
  Boolean(command.command.trim()) &&
  DEVISH.test(`${command.id} ${command.name} ${command.command}`);

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
  script: "dev" | "start",
  runner: "npm" | "pnpm" | "yarn" | "bun",
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
      const command = {
        id,
        name: script === "dev" ? "Dev" : "Start",
        command: commandText,
      };
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

function selectionFor(candidate: Candidate): VibeTargetSelection {
  return {
    componentId: candidate.component.id,
    runCommandId: candidate.command.id,
    ...(candidate.addCommand ? { addCommand: candidate.addCommand } : {}),
  };
}

function ask(candidates: Candidate[]): VibeTargetInference {
  const baseResponses = candidates.map(
    ({ component, command }) =>
      `Use ${component.label} with ${command.name} — ${command.command}`,
  );
  const duplicate = (response: string) =>
    baseResponses.filter((candidate) => candidate === response).length > 1;
  const choices = candidates.map((candidate, index) => {
    const base = baseResponses[index];
    const withPath = duplicate(base) ? `${base} in ${candidate.component.path}` : base;
    const repeats = candidates
      .slice(0, index)
      .filter((previous, previousIndex) => {
        const previousBase = baseResponses[previousIndex];
        return (
          (duplicate(previousBase)
            ? `${previousBase} in ${previous.component.path}`
            : previousBase) === withPath
        );
      }).length;
    const response = repeats ? `${withPath} (option ${repeats + 1})` : withPath;
    return {
      key: `${candidate.component.id}:${candidate.command.id}`,
      label: response,
      response,
      selection: selectionFor(candidate),
    };
  });
  return {
    kind: "ask",
    prompt: "Which one should I use to run your app?",
    choices,
  };
}

function resolveCandidates(candidates: Candidate[]): VibeTargetInference {
  if (candidates.length === 1) {
    return {
      kind: "persist",
      selection: selectionFor(candidates[0]),
      source: candidates[0].source,
    };
  }
  return ask(candidates);
}

/** Pure target inference. Package facts are loaded separately and passed in. */
export function inferVibeTarget(
  components: readonly Component[],
  packageFacts: VibePackageFacts = {},
): VibeTargetInference {
  if (components.length === 0) return { kind: "unavailable" };

  const existingByComponent = components.map((component) => ({
    component,
    commands: (component.commands ?? []).filter(commandLooksRunnable),
  }));
  const existingComponents = existingByComponent.filter(
    ({ commands }) => commands.length > 0,
  );
  const selectedExisting =
    components.length === 1
      ? existingByComponent.filter(({ commands }) => commands.length > 0)
      : existingComponents;
  if (selectedExisting.length > 0) {
    return resolveCandidates(
      selectedExisting.flatMap(({ component, commands }) =>
        commands.map((command) => ({
          component,
          command,
          source: "existing-command" as const,
        })),
      ),
    );
  }

  const missingFacts = components
    .filter((component) => packageFacts[component.id] === undefined)
    .map((component) => component.id);
  if (missingFacts.length > 0) {
    return { kind: "needs-package-facts", componentIds: missingFacts };
  }

  const packageCandidates = components.flatMap((component) => {
    const fact = packageFacts[component.id];
    if (fact?.status !== "loaded") return [];
    const script = fact.scripts.dev?.trim()
      ? "dev"
      : fact.scripts.start?.trim()
        ? "start"
        : null;
    if (!script) return [];
    const resolved = packageCommand(components, component, script, fact.runner);
    return [
      {
        component,
        command: resolved.command,
        addCommand: resolved.addCommand,
        source: "package-script" as const,
        script,
      },
    ];
  });
  const devCandidates = packageCandidates.filter(
    (candidate) => candidate.script === "dev",
  );
  const selected = devCandidates.length > 0 ? devCandidates : packageCandidates;
  return selected.length > 0
    ? resolveCandidates(selected)
    : { kind: "unavailable" };
}

export function applyVibeTargetSelection(
  project: Project,
  selection: VibeTargetSelection,
): Project | null {
  const componentIndex = project.components.findIndex(
    (component) => component.id === selection.componentId,
  );
  if (componentIndex === -1) return null;
  const component = project.components[componentIndex];
  const allCommands = project.components.flatMap(
    (candidate) => candidate.commands ?? [],
  );
  const existing = allCommands.find(
    (command) => command.id === selection.runCommandId,
  );
  let commands = component.commands ?? [];
  if (selection.addCommand) {
    if (
      existing &&
      (existing.command !== selection.addCommand.command ||
        existing.name !== selection.addCommand.name ||
        !commands.includes(existing))
    ) {
      return null;
    }
    if (!existing) commands = [...commands, selection.addCommand];
  } else if (!commands.some((command) => command.id === selection.runCommandId)) {
    return null;
  }
  const components = project.components.map((candidate, index) =>
    index === componentIndex && commands !== component.commands
      ? { ...candidate, commands }
      : candidate,
  );
  return {
    ...project,
    components,
    vibe: {
      ...project.vibe,
      version: 1,
      enabled: project.vibe?.enabled ?? true,
      componentId: selection.componentId,
      runCommandId: selection.runCommandId,
    },
  };
}

export function createVibeTargetQuestionSession(
  inference: Extract<VibeTargetInference, { kind: "ask" }>,
  persist: (selection: VibeTargetSelection) => Promise<boolean>,
): BuilderSession {
  const listeners = new Set<(event: StructuredRunnerEvent) => void>();
  let state: BuilderSession["state"] = {
    persona: { kind: "question-asked" },
    question: {
      id: `vibe-target-${stableHash(inference.choices.map((choice) => choice.key).join("|"))}`,
      kind: "question",
      prompt: inference.prompt,
      actions: inference.choices.map(({ label, response }) => ({ label, response })),
    },
  };
  return {
    events$: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async send(text) {
      const answer = text.trim().toLowerCase();
      const choice = inference.choices.find(
        (candidate) =>
          candidate.response.toLowerCase() === answer ||
          candidate.label.toLowerCase() === answer,
      );
      if (!choice) throw new Error("Choose one of the options above.");
      if (!(await persist(choice.selection))) {
        throw new Error("I couldn't save that Build target.");
      }
      state = { persona: { kind: "question-answered" }, question: null };
      for (const listener of listeners) listener({ kind: "ready" });
    },
    get state() {
      return state;
    },
  };
}

/** A chat-shaped status for loading or unsupported targets, never a modal. */
export function createVibeTargetStatusSession(
  message: string,
  retry?: () => void | Promise<void>,
): BuilderSession {
  const listeners = new Set<(event: StructuredRunnerEvent) => void>();
  const reply = () => {
    for (const listener of listeners) listener({ kind: "reply", text: message });
  };
  return {
    state: { persona: { kind: "turn-progress" }, question: null },
    events$: {
      subscribe(listener) {
        listeners.add(listener);
        let active = true;
        queueMicrotask(() => {
          if (active) listener({ kind: "reply", text: message });
        });
        return () => {
          active = false;
          listeners.delete(listener);
        };
      },
    },
    async send() {
      await retry?.();
      reply();
    },
  };
}
