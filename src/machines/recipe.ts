// A repository's recipe for working across machines: `.canopy/machines.json`.
//
// The three primitives (run, sync, copy) are enough for an agent to do
// anything, and too much to spell out every time. "Build it over there and
// install it here" is the same four steps on every change, so the repository
// says them once and the step becomes mechanical: `canopy_workflow_run build`.
//
//   {
//     "machines":  { "build": "Build Box", "device": "this-mac" },
//     "workflows": {
//       "build": {
//         "description": "Build the debug APK on the build machine, install it on the phone plugged into this Mac",
//         "steps": [
//           { "sync": { "from": "here", "to": "build" } },
//           { "run":  { "on": "build", "command": "./gradlew assembleDebug", "timeoutMinutes": 20 } },
//           { "copy": { "from": "build", "to": "device", "path": "app/build/outputs/apk/debug/app-debug.apk" } },
//           { "run":  { "on": "device", "command": "adb install -r app/build/outputs/apk/debug/app-debug.apk" } }
//         ]
//       }
//     }
//   }
//
// It lives in the repository because it describes the repository (its build
// command, where its artifact lands), is reviewed like any other file, and
// reaches every machine through git. `machines` gives the roles a workflow
// speaks of a default machine; whoever runs a workflow can name others, so a
// teammate's machines need no edit to the file.
import { ChannelError, safeRelativePath } from "./channel";

export const RECIPE_PATH = ".canopy/machines.json";

export type Step =
  | { kind: "sync"; from: string; to: string; overwrite: boolean }
  | { kind: "run"; on: string; command: string; dir?: string; timeoutMinutes?: number }
  | { kind: "copy"; from: string; to: string; path: string; toPath?: string };

export interface Workflow {
  description?: string;
  steps: Step[];
}

export interface Recipe {
  /** Role → machine (a name, an id, "this-mac" or "here"). */
  machines: Record<string, string>;
  /** Role or machine name → where the repository is checked out there, for a
   *  machine with more than one checkout of it. */
  checkouts: Record<string, string>;
  /** Ignored files a sync should bring along (a `.env` the build reads). */
  carry: string[];
  workflows: Record<string, Workflow>;
}

export const EMPTY_RECIPE: Recipe = { machines: {}, checkouts: {}, carry: [], workflows: {} };

const MAX_STEPS = 40;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function str(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ChannelError(`${RECIPE_PATH}: ${what} must be a non-empty string.`);
  return value.trim();
}

function stringMap(value: unknown, what: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value)) throw new ChannelError(`${RECIPE_PATH}: "${what}" must be an object of names to strings.`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!NAME.test(key)) throw new ChannelError(`${RECIPE_PATH}: "${key}" in "${what}" is not a usable name (letters, digits, - _ . only).`);
    out[key] = str(entry, `"${what}.${key}"`);
  }
  return out;
}

function parseStep(raw: unknown, where: string): Step {
  if (!isObject(raw)) throw new ChannelError(`${RECIPE_PATH}: ${where} must be an object with one of "sync", "run" or "copy".`);
  const kinds = Object.keys(raw);
  if (kinds.length !== 1 || !["sync", "run", "copy"].includes(kinds[0])) {
    throw new ChannelError(`${RECIPE_PATH}: ${where} must have exactly one of "sync", "run" or "copy" (found ${kinds.join(", ") || "nothing"}).`);
  }
  const kind = kinds[0] as "sync" | "run" | "copy";
  const body = raw[kind];
  if (!isObject(body)) throw new ChannelError(`${RECIPE_PATH}: ${where}.${kind} must be an object.`);
  if (kind === "sync") {
    return { kind, from: body.from === undefined ? "here" : str(body.from, `${where}.sync.from`), to: str(body.to, `${where}.sync.to`), overwrite: body.overwrite === true };
  }
  if (kind === "run") {
    const minutes = body.timeoutMinutes;
    if (minutes !== undefined && (typeof minutes !== "number" || !(minutes > 0))) {
      throw new ChannelError(`${RECIPE_PATH}: ${where}.run.timeoutMinutes must be a positive number.`);
    }
    return {
      kind,
      on: str(body.on, `${where}.run.on`),
      command: str(body.command, `${where}.run.command`),
      ...(body.dir !== undefined ? { dir: safeRelativePath(str(body.dir, `${where}.run.dir`)) } : {}),
      ...(typeof minutes === "number" ? { timeoutMinutes: minutes } : {}),
    };
  }
  return {
    kind,
    from: str(body.from, `${where}.copy.from`),
    to: str(body.to, `${where}.copy.to`),
    path: safeRelativePath(str(body.path, `${where}.copy.path`)),
    ...(body.toPath !== undefined ? { toPath: safeRelativePath(str(body.toPath, `${where}.copy.toPath`)) } : {}),
  };
}

/** Read a recipe. Every problem is named with where it is in the file, since
 *  the reader is usually the agent that just wrote it. */
export function parseRecipe(text: string): Recipe {
  if (!text.trim()) return EMPTY_RECIPE;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ChannelError(`${RECIPE_PATH} is not valid JSON: ${String((error as { message?: string })?.message ?? error)}`);
  }
  if (!isObject(raw)) throw new ChannelError(`${RECIPE_PATH} must be a JSON object.`);
  const workflows: Record<string, Workflow> = {};
  if (raw.workflows !== undefined) {
    if (!isObject(raw.workflows)) throw new ChannelError(`${RECIPE_PATH}: "workflows" must be an object of workflow names.`);
    for (const [name, value] of Object.entries(raw.workflows)) {
      if (!NAME.test(name)) throw new ChannelError(`${RECIPE_PATH}: "${name}" is not a usable workflow name (letters, digits, - _ . only).`);
      // A bare list of steps is a workflow with no description.
      const body = Array.isArray(value) ? { steps: value } : value;
      if (!isObject(body) || !Array.isArray(body.steps)) throw new ChannelError(`${RECIPE_PATH}: workflow "${name}" needs "steps": a list.`);
      if (!body.steps.length) throw new ChannelError(`${RECIPE_PATH}: workflow "${name}" has no steps.`);
      if (body.steps.length > MAX_STEPS) throw new ChannelError(`${RECIPE_PATH}: workflow "${name}" has more than ${MAX_STEPS} steps.`);
      workflows[name] = {
        ...(typeof body.description === "string" && body.description.trim() ? { description: body.description.trim() } : {}),
        steps: body.steps.map((step, i) => parseStep(step, `workflow "${name}" step ${i + 1}`)),
      };
    }
  }
  let carry: string[] = [];
  if (raw.carry !== undefined) {
    if (!Array.isArray(raw.carry) || raw.carry.length > 32) throw new ChannelError(`${RECIPE_PATH}: "carry" must be a list of at most 32 paths.`);
    carry = raw.carry.map((path, i) => safeRelativePath(str(path, `"carry"[${i}]`)));
  }
  const checkouts = stringMap(raw.checkouts, "checkouts");
  for (const [key, path] of Object.entries(checkouts)) {
    if (!path.startsWith("/")) throw new ChannelError(`${RECIPE_PATH}: "checkouts.${key}" must be an absolute path on that machine.`);
  }
  return { machines: stringMap(raw.machines, "machines"), checkouts, carry, workflows };
}

/** Every machine reference a workflow makes, in order of first use. */
export function workflowMachines(workflow: Workflow): string[] {
  const seen: string[] = [];
  const add = (ref: string) => {
    if (!seen.includes(ref)) seen.push(ref);
  };
  for (const step of workflow.steps) {
    if (step.kind === "run") add(step.on);
    else {
      add(step.from);
      add(step.to);
    }
  }
  return seen;
}

/** A starting point, shown when a repository has no recipe yet. */
export const RECIPE_EXAMPLE = `{
  "machines": { "build": "<name of the machine that compiles>", "device": "this-mac" },
  "workflows": {
    "build": {
      "description": "Build on the build machine, bring the artifact here, install it",
      "steps": [
        { "sync": { "from": "here", "to": "build" } },
        { "run": { "on": "build", "command": "<the build command>", "timeoutMinutes": 20 } },
        { "copy": { "from": "build", "to": "device", "path": "<path/to/artifact>" } },
        { "run": { "on": "device", "command": "<the install command>" } }
      ]
    }
  }
}`;
