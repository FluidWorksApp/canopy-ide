// What a workflow agent step's prompt may refer to, and where its run keeps
// files.
//
// A workflow definition is a committed file, so its prompts are static text.
// Two things are only known per run: which run this is (and so where its
// artifacts live), and what started it — a research entry, a request typed into
// the Run box. Placeholders carry those in. They are rendered once, before the
// attempt is reserved, so the task ledger records the prompt the agent actually
// read rather than the template it was made from.
//
// Pure on purpose: the executor and the launcher both need these, and the rules
// (which keys exist, how long a value may be, what an absent one says) are the
// part worth testing directly.

/** The per-run directory, inside the worktree because fs reads are limited to
 *  registered roots — the same reason PR tasks write under `.canopy/`. The
 *  launcher keeps it out of git via `.git/info/exclude`. */
export const WORKFLOW_RUNS_DIR = ".canopy/workflow-runs";

export const workflowRunDir = (worktreePath: string, runId: string): string =>
  `${worktreePath.replace(/[\\/]+$/, "")}/${WORKFLOW_RUNS_DIR}/${runId}`;

/** Where a verdict step leaves its verdict for this round. Keyed by round so a
 *  step re-entered through a loop can never be read back as the previous
 *  pass's answer. */
export const verdictPath = (runDir: string, stepId: string, round: number): string =>
  `${runDir}/verdicts/${stepId}.r${round}.json`;

export interface WorkflowPromptScope {
  runId: string;
  runDir: string;
  round: number;
  trigger: Record<string, unknown>;
}

/** A payload value is user- or event-supplied text going into an agent brief.
 *  Capped so one oversized comment body cannot crowd out the step's own
 *  instructions. */
export const TRIGGER_VALUE_MAX = 8 * 1024;
export const ABSENT = "(not provided)";

const triggerValue = (payload: Record<string, unknown>, key: string): string => {
  const value = Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string" || !value.trim()) return ABSENT;
  const chars = Array.from(value.trim());
  return chars.length <= TRIGGER_VALUE_MAX
    ? chars.join("")
    : `${chars.slice(0, TRIGGER_VALUE_MAX - 1).join("")}…`;
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/g;

/** Replace the known placeholders. Anything else between braces is left as
 *  written — a prompt that talks about `{{handlebars}}` should not lose it. */
export function renderWorkflowPrompt(template: string, scope: WorkflowPromptScope): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    if (name === "run.id") return scope.runId;
    if (name === "run.dir") return scope.runDir;
    if (name === "round") return String(scope.round);
    if (name.startsWith("trigger.") && name.length > "trigger.".length) {
      return triggerValue(scope.trigger, name.slice("trigger.".length));
    }
    return whole;
  });
}

/** The line appended to a verdict step's brief. Spelled out rather than left to
 *  the definition author, because the executor reads exactly this path and
 *  exactly this shape — a prompt that drifted from it would turn every run of
 *  the step into a failure. */
export function verdictProtocol(path: string, verdicts: readonly string[]): string {
  const choices = verdicts.map((verdict) => `"${verdict}"`).join(", ");
  return (
    `Before you finish, record your verdict: create the directory if needed and write ` +
    `\`${path}\` containing exactly {"verdict": "<one of ${choices}>"}. ` +
    `Canopy routes the workflow on that file alone; without it this step counts as failed.`
  );
}

/** Read a verdict file's contents. Returns the verdict only when it is one the
 *  step declared — an invented one is as unroutable as a missing one. */
export function parseVerdict(source: string | null, verdicts: readonly string[]): string | null {
  if (!source) return null;
  try {
    const value = JSON.parse(source) as { verdict?: unknown };
    const verdict = typeof value?.verdict === "string" ? value.verdict.trim() : "";
    return verdicts.includes(verdict) ? verdict : null;
  } catch {
    return null;
  }
}
