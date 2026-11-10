// What a teleport brings along, as the dialog's checklist. Pure, so the default
// (everything ticked, secrets not) is tested rather than looked at.
import { looksSecret } from "../commitPushPr";
import { MOVE_STEPS, type MoveStep } from "./sessionMove";

export type TeleportItemKind = "changes" | "commits" | "ignored" | "conversation";

export interface TeleportItem {
  id: string;
  kind: TeleportItemKind;
  label: string;
  /** Right-aligned detail, e.g. "+8,152 −36" or "git-ignored". */
  detail?: string;
  /** Looks like a credential: starts unticked. */
  secret?: boolean;
  /** Cannot be turned off: without it the move is not a move. */
  required?: boolean;
}

/** A git-ignored file as a checklist row; flagged when its name looks like a credential. */
export const ignoredItem = (path: string): TeleportItem => ({
  id: `ignored:${path}`,
  kind: "ignored",
  label: path,
  detail: "git-ignored",
  secret: looksSecret(path),
});

/** Everything ticked except what looks like a secret. */
export function defaultSelection(items: readonly TeleportItem[]): Set<string> {
  return new Set(items.filter((i) => !i.secret).map((i) => i.id));
}

/** The selection with `id` toggled; a required row stays ticked. */
export function toggled(items: readonly TeleportItem[], selected: ReadonlySet<string>, id: string): Set<string> {
  const item = items.find((i) => i.id === id);
  const next = new Set(selected);
  if (!item || item.required) return next;
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The ids to send: only rows that exist, plus every required one. */
export function chosen(items: readonly TeleportItem[], selected: ReadonlySet<string>): string[] {
  return items.filter((i) => i.required || selected.has(i.id)).map((i) => i.id);
}

export interface TeleportProgress {
  step: MoveStep;
  /** 0..1 within the step, when it can say. */
  fraction?: number;
  failed?: string;
}

/** Which dot a step is: done before the current one, current at it, waiting after. */
export function stepState(step: MoveStep, progress: TeleportProgress | null): "done" | "now" | "wait" | "failed" {
  if (!progress) return "wait";
  const at = MOVE_STEPS.indexOf(progress.step);
  const me = MOVE_STEPS.indexOf(step);
  if (me < at) return "done";
  if (me === at) return progress.failed ? "failed" : "now";
  return "wait";
}

