// The brain-written change note: what the finishing agent just changed, in
// the terms that matter to the agent it overlaps with.
//
// One brain call per finished turn, however many agents it overlaps (the
// batch), on the background tier. The prompt carries everything — the brain
// call has no canopy tools — and asks, per overlapping agent, for
// `{relevant, note, risk}`: most overlaps are harmless (two agents both
// adding to a README) and an irrelevant note teaches agents to ignore notes.

import type { FileOverlap } from "./overlap";
import { OVERLAP_LABEL } from "./overlap";

export type AwarenessRisk = "none" | "low" | "conflict";

export interface AwarenessVerdict {
  relevant: boolean;
  /** ≤ 2 sentences: what changed and why it matters to this agent. */
  note: string;
  risk: AwarenessRisk;
}

/** The diff, capped: enough for the brain to say what changed, never a
 *  whole refactor on the person's plan. */
export const MAX_DIFF_CHARS = 6000;
export const MAX_PROMPT_CHARS = 1200;
export const MAX_NOTE_CHARS = 360;

export interface DiffEdit {
  path: string;
  tool?: string;
  old: string | null;
  new: string | null;
}

/** The turn's edits as a readable, capped diff. Each hunk is `--- path`
 *  followed by `-`/`+` lines; the tail is dropped with a marker, not cut
 *  mid-line. */
export function buildDiff(edits: readonly DiffEdit[], cap = MAX_DIFF_CHARS): string {
  const parts: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const e of edits) {
    if ((e.old ?? "") === (e.new ?? "")) continue;
    const lines = [`--- ${e.path}${e.tool ? ` (${e.tool})` : ""}`];
    for (const l of (e.old ?? "").split("\n")) if (e.old) lines.push(`- ${l}`);
    for (const l of (e.new ?? "").split("\n")) if (e.new) lines.push(`+ ${l}`);
    const hunk = lines.join("\n");
    if (used + hunk.length > cap) {
      if (!parts.length) parts.push(hunk.slice(0, cap));
      else dropped++;
      used = cap;
      continue;
    }
    parts.push(hunk);
    used += hunk.length + 1;
  }
  if (dropped) parts.push(`… (${dropped} more edit(s) not shown)`);
  return parts.join("\n");
}

/** A stable 53-bit hash (cyrb53) as hex: the dedupe key for a diff. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export interface NoteTarget {
  name: string;
  task: string | null;
  /** Files it is working in (repo-relative), for context. */
  files: string[];
  overlap: FileOverlap[];
}

export interface NotePromptInput {
  from: { name: string; cli: string };
  /** What the finishing agent was asked to do. */
  prompt?: string;
  diff: string;
  targets: NoteTarget[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildNotePrompt(input: NotePromptInput): string {
  const asked = input.prompt?.trim() ? clip(input.prompt.trim(), MAX_PROMPT_CHARS) : "(not recorded)";
  const targets = input.targets
    .map((t, i) => {
      const overlap = t.overlap
        .map((o) => `${o.path} (${OVERLAP_LABEL[o.why]}${o.symbol ? `: ${o.symbol}` : ""})`)
        .join("; ");
      return [
        `Agent ${i + 1}: ${t.name}`,
        `  Task: ${t.task ? clip(t.task, 300) : "(unknown)"}`,
        `  Working in: ${t.files.slice(0, 12).join(", ") || "(unknown)"}`,
        `  Overlap: ${overlap}`,
      ].join("\n");
    })
    .join("\n\n");
  return [
    "You are the coordinator of a workspace where several coding agents work on the same repository at once.",
    `One agent (${input.from.name}) just finished a turn. Decide, for each OTHER agent listed below, whether this change matters to it, and if so write it a short heads-up.`,
    "",
    "What the finishing agent was asked:",
    asked,
    "",
    "What it changed (capped diff):",
    input.diff || "(no textual diff recorded)",
    "",
    "Other agents whose work overlaps:",
    targets,
    "",
    "Rules:",
    "- relevant=false when the change cannot affect that agent's task (unrelated lines, cosmetic edits, docs it does not use).",
    "- note: at most 2 sentences, addressed to that agent: what changed (name files and symbols), and what it should do or watch for. No greetings.",
    "- risk: \"conflict\" if the change likely breaks or contradicts that agent's in-progress work (renamed/removed something it uses, edited the same lines); \"low\" if it is worth knowing; \"none\" otherwise.",
    "",
    'Reply with ONLY one JSON object: {"notes":[{"agent":1,"relevant":true,"note":"...","risk":"low"}]} with one entry per agent number.',
  ].join("\n");
}

/** At most two sentences, capped — the brain is asked, this enforces. */
export function clampNote(note: string): string {
  const flat = note.replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g);
  const two = sentences && sentences.length > 2 ? sentences.slice(0, 2).join("").trim() : flat;
  return clip(two, MAX_NOTE_CHARS);
}

const RISKS: readonly AwarenessRisk[] = ["none", "low", "conflict"];

/** Validate the batch reply into one verdict per target (null = the brain
 *  said nothing usable about that agent, treated as not relevant). Rejects
 *  the whole reply (null) only when it is not the asked-for shape at all. */
export function validateNotes(raw: unknown, targets: number): (AwarenessVerdict | null)[] | null {
  const list =
    raw && typeof raw === "object" && Array.isArray((raw as { notes?: unknown }).notes)
      ? ((raw as { notes: unknown[] }).notes)
      : // A single target sometimes gets the bare object back.
        targets === 1 && raw && typeof raw === "object" && "relevant" in raw
        ? [{ agent: 1, ...(raw as object) }]
        : null;
  if (!list) return null;
  const out: (AwarenessVerdict | null)[] = Array.from({ length: targets }, () => null);
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const agent = typeof v.agent === "number" ? v.agent : Number(v.agent);
    if (!Number.isInteger(agent) || agent < 1 || agent > targets) continue;
    if (typeof v.relevant !== "boolean") continue;
    const note = typeof v.note === "string" ? clampNote(v.note) : "";
    const risk = RISKS.includes(v.risk as AwarenessRisk) ? (v.risk as AwarenessRisk) : "low";
    if (v.relevant && !note) continue;
    out[agent - 1] = { relevant: v.relevant, note, risk };
  }
  return out;
}
