// The brain's two jobs in the Rules panel: turn a plain-language rule into a
// gate, and read an instruction file for lines that should be gates instead.
//
// Both are user-initiated (a "Compile" or "Suggest" click), so they use the
// main tier: someone is waiting on the answer. Both are validated against the
// closed DSL in dsl.ts before anything is shown, so the person only ever
// approves a gate the hook can actually enforce.

import { askBrain } from "../brainCall";
import {
  compilePrompt,
  suggestPrompt,
  validateCompiled,
  validateSuggestions,
  type CompiledRule,
  type RuleSuggestion,
} from "./dsl";

export type BrainResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Why a brain call didn't produce something, in one line for the panel. */
function failure(reason: string, message: string): string {
  switch (reason) {
    case "no-brain":
      return "No brain connected — connect an agent CLI in Settings to compile rules.";
    case "signed-out":
      return "The brain's CLI is signed out — sign in again to compile rules.";
    case "rate-limited":
      return "The brain is rate-limited right now — try again in a few minutes.";
    case "over-budget":
      return "Today's brain budget is used up — raise it in Settings to compile rules.";
    case "timeout":
      return "The brain took too long — try again.";
    case "invalid-output":
      return "The brain's answer wasn't a gate Canopy can enforce — try rewording the rule.";
    default:
      return message || "The brain couldn't answer.";
  }
}

/** In a Linux workspace the project path names a VM directory, but the brain
 *  is the CLI on this computer: there it doesn't exist. The prompt already
 *  carries what the brain needs, so ask again from home rather than fail. */
async function askWithFallback<T>(req: Parameters<typeof askBrain<T>>[0]) {
  const first = await askBrain<T>(req);
  if (!first.ok && first.reason === "failed" && /cwd does not exist/i.test(first.message) && req.cwd) {
    return askBrain<T>({ ...req, cwd: "" });
  }
  return first;
}

export async function compileRule(
  rule: string,
  cwd: string,
  opts: { files?: string[]; signal?: AbortSignal } = {},
): Promise<BrainResult<CompiledRule>> {
  const answer = await askWithFallback<CompiledRule>({
    feature: "gates",
    tier: "main",
    json: true,
    cwd,
    prompt: compilePrompt(rule, { files: opts.files }),
    validate: validateCompiled,
    timeoutMs: 90_000,
    signal: opts.signal,
  });
  if (!answer.ok) return { ok: false, message: failure(answer.reason, answer.message) };
  return { ok: true, value: answer.value! };
}

export async function suggestRules(
  fileLabel: string,
  text: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<BrainResult<RuleSuggestion[]>> {
  const answer = await askWithFallback<RuleSuggestion[]>({
    feature: "gates",
    tier: "main",
    json: true,
    cwd,
    prompt: suggestPrompt(fileLabel, text),
    validate: (v) => validateSuggestions(v, text),
    timeoutMs: 120_000,
    signal,
  });
  if (!answer.ok) return { ok: false, message: failure(answer.reason, answer.message) };
  return { ok: true, value: answer.value! };
}

/** Take the accepted lines out of the instruction file — the "shrink" half of
 *  moving a rule into a gate. Only whole lines that match exactly; anything
 *  else is left for the person to edit, never guessed at. */
export function removeLines(text: string, lines: string[]): string {
  const drop = new Set(lines.map((l) => l.trim()).filter(Boolean));
  return text
    .split("\n")
    .filter((l) => !drop.has(l.trim()))
    .join("\n");
}
