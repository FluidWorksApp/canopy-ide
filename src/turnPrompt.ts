// What a turn's stored prompt says, in words a person can read.
//
// A turn starts on the CLI's UserPromptSubmit, and that fires for more than
// typing: a background task reporting back (`<task-notification>…`), another
// session's message (`<cross-session-message …>`), a task sent from the agent
// card, a paste, a prompt that opens with `[Image #2]`. The turn list used to
// print those verbatim. `readTurnPrompt` turns one into a label and a line;
// `condenseTurnPrompt` reorders one before it is stored, because the snapshot
// keeps only the first 200 characters (turn_rollback.rs) and a notification
// spends those on ids and a temp path before it reaches its status.
//
// Stored prompts are already cut, so every reader here accepts a tag that
// never closes.

import type { SubagentRun } from "./ipc";

export type TurnPromptKind =
  /** Typed (or pasted) by the person. */
  | "you"
  /** A background command or subagent reporting back. */
  | "task"
  /** Another agent session wrote to this one. */
  | "message"
  /** Sent from the agent card's task list. */
  | "queued"
  /** A slash command. */
  | "command"
  /** Some other injected payload. */
  | "auto";

export type TurnPromptTone = "ok" | "fail" | "stop";

export interface TurnPromptView {
  kind: TurnPromptKind;
  /** Short chip naming where the turn came from; null when the person typed it. */
  label: string | null;
  /** The outcome of a background task, when the prompt still says. */
  status: string | null;
  tone: TurnPromptTone | null;
  /** The readable line. May be empty (an image with no words). */
  text: string;
  /** Images attached ahead of the text. */
  images: number;
  pasted: boolean;
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** A tag's text. A tag that opens and never closes (the prompt was cut)
 *  yields what there is; `cut` says so. */
function tag(text: string, name: string): { value: string; cut: boolean } | null {
  const open = `<${name}>`;
  const s = text.indexOf(open);
  if (s < 0) return null;
  const from = s + open.length;
  const e = text.indexOf(`</${name}>`, from);
  if (e >= 0) return { value: text.slice(from, e).trim(), cut: false };
  // Cut mid-value: drop a trailing half-written tag ("…</summ").
  return { value: text.slice(from).replace(/<\/?[a-z-]*$/i, "").trim(), cut: true };
}

const attr = (head: string, name: string): string | null => {
  const m = head.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? m[1] : null;
};

/** Drop whole `<system-reminder>` blocks, then any other tags, keeping text. */
const stripTags = (s: string) =>
  flat(
    s
      .replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g, " ")
      .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
      .replace(/<\/?[a-zA-Z][^>]*$/, " "),
  );

const STATUS_WORDS: [TurnPromptTone, string[]][] = [
  ["fail", ["failed", "error"]],
  ["stop", ["killed", "stopped", "cancelled", "canceled"]],
  ["ok", ["completed", "success", "done", "finished"]],
];

/** The task's own `<status>` decides. Only a prompt without one is read from
 *  its summary's closing words — a description may say "failed" itself. */
function statusOf(raw: string | undefined, tail: string): { status: string | null; tone: TurnPromptTone | null } {
  const word = (raw ?? "").toLowerCase();
  let tone = STATUS_WORDS.find(([, words]) => words.includes(word))?.[0] ?? null;
  if (!tone && !word) {
    tone = /\bfailed\b/i.test(tail)
      ? "fail"
      : /\b(stopped|killed|cancell?ed)\b/i.test(tail)
        ? "stop"
        : /\b(completed|finished)\b/i.test(tail)
          ? "ok"
          : null;
  }
  if (tone === "fail") {
    const exit = tail.match(/exit code (\d+)/i)?.[1];
    return { status: exit && exit !== "0" ? `failed, exit ${exit}` : "failed", tone };
  }
  if (tone === "stop") return { status: "stopped", tone };
  if (tone === "ok") return { status: "finished", tone };
  return { status: null, tone: null };
}

/** `Background command "Wait for CI" failed with exit code 144` → its parts. */
function splitSummary(summary: string): { who: string; what: string; tail: string } | null {
  const m = summary.match(/^([A-Za-z][A-Za-z ]*?)\s+"([\s\S]*)"\s*([^"]*)$/);
  return m ? { who: m[1].toLowerCase(), what: m[2].trim(), tail: m[3].trim() } : null;
}

// Shown when a payload has no words left to show; not something it said.
const TASK_PLACEHOLDER = "Reported back";
const AUTO_PLACEHOLDER = "Automatic message";

export interface ReadOptions {
  /** Build lens: no "subagent". */
  builder?: boolean;
  /** The session's subagents, to name a notification whose own summary was
   *  cut off before it was stored. */
  subagents?: readonly Pick<SubagentRun, "id" | "agent_id" | "description" | "status">[];
}

function readTask(body: string, o: ReadOptions): TurnPromptView {
  const summary = tag(body, "summary");
  const parts = summary ? splitSummary(summary.value) : null;
  const toolUseId = tag(body, "tool-use-id")?.value;
  const taskId = tag(body, "task-id")?.value;
  const sub = o.subagents?.find(
    (s) => (toolUseId && s.id === toolUseId) || (taskId && s.agent_id === taskId),
  );
  const isAgent = !!sub || parts?.who === "agent" || /^Agent\s+"/.test(summary?.value ?? "");
  let { status, tone } = statusOf(tag(body, "status")?.value, parts?.tail ?? (summary?.cut ? "" : (summary?.value ?? "")));
  // An old row cut before its status: the transcript knows how the subagent ended.
  if (!status && sub && sub.status !== "running") {
    ({ status, tone } = statusOf(sub.status, ""));
  }
  let text = parts?.what ?? summary?.value ?? sub?.description ?? "";
  // Cut mid-summary: keep the words that made it, without the `Agent "` lead.
  if (summary?.cut && text) text = `${text.replace(/^[A-Za-z][A-Za-z ]*?\s+"/, "").replace(/"$/, "")}…`;
  return {
    kind: "task",
    label: isAgent ? (o.builder ? "Helper agent" : "Subagent") : "Background task",
    status,
    tone,
    text: flat(text) || TASK_PLACEHOLDER,
    images: 0,
    pasted: false,
  };
}

function readMessage(raw: string, name: string): TurnPromptView {
  const close = raw.indexOf(">");
  const head = close < 0 ? raw : raw.slice(0, close);
  const from = attr(head, "from-name") ?? attr(head, "from");
  // A bare socket path or hex id names nobody.
  const named = from && !/^(uds:|[0-9a-f]{12,}$)/i.test(from) ? from : null;
  return {
    kind: "message",
    label: named ? `From ${named}` : name === "agent-message" ? "Subagent report" : "From another agent",
    status: null,
    tone: null,
    text: close < 0 ? "" : stripTags(raw.slice(close + 1)),
    images: 0,
    pasted: false,
  };
}

// agentTasks.ts taskFocusPrompt / taskCompletePrompt.
const QUEUED = [
  /^Please focus on this task next and finish it before continuing with the others:\s*/,
  /^Please complete this task now:\s*/,
];
const QUEUED_TAIL = /\.? Mark it done in your task list when it is finished\.?$/;

/** A stored turn prompt as a label and a readable line. */
export function readTurnPrompt(raw: string | null | undefined, o: ReadOptions = {}): TurnPromptView | null {
  const src = (raw ?? "").trim();
  if (!src) return null;
  const plain = (extra: Partial<TurnPromptView>): TurnPromptView => ({
    kind: "you",
    label: null,
    status: null,
    tone: null,
    text: "",
    images: 0,
    pasted: false,
    ...extra,
  });

  if (src.startsWith("<task-notification")) return readTask(src, o);
  for (const name of ["cross-session-message", "agent-message"]) {
    if (src.startsWith(`<${name}`)) return readMessage(src, name);
  }
  const command = tag(src, "command-name");
  if (command && src.startsWith("<command-")) {
    const args = tag(src, "command-args")?.value ?? "";
    return plain({ kind: "command", label: "Command", text: flat(`${command.value} ${args}`) });
  }

  // Attachment markers ahead of the words: `[Image #3] [Image #4]Also, …`.
  const lead = src.match(/^(?:\[Image #\d+\]\s*)+/i)?.[0] ?? "";
  const images = lead.match(/\[Image #\d+\]/gi)?.length ?? 0;
  const rest = src.slice(lead.length);

  for (const re of QUEUED) {
    if (re.test(rest)) {
      return plain({
        kind: "queued",
        label: "From task list",
        text: flat(rest.replace(re, "").replace(QUEUED_TAIL, "")),
        images,
      });
    }
  }
  if (rest.includes("<pasted_content")) {
    return plain({ text: stripTags(rest), images, pasted: true });
  }
  if (rest.startsWith("<")) {
    const text = stripTags(rest);
    return plain({ kind: "auto", label: "Automatic", text: text || AUTO_PLACEHOLDER, images });
  }
  return plain({ text: flat(rest), images });
}

/** The words of a turn prompt alone — what to hand a summariser or put in a
 *  compaction instruction instead of the raw payload. */
export function turnPromptText(raw: string | null | undefined): string {
  const v = readTurnPrompt(raw);
  if (!v || v.text === TASK_PLACEHOLDER || v.text === AUTO_PLACEHOLDER) return "";
  if (v.kind === "task") return flat(`${v.label}: ${v.text}${v.status ? ` (${v.status})` : ""}`);
  return v.label && v.kind !== "queued" ? flat(`${v.label}: ${v.text}`) : v.text;
}

/** Reorder a prompt so the part worth reading survives the 200-character cut
 *  it is stored under. Same tags, so `readTurnPrompt` reads either form. */
export function condenseTurnPrompt(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const src = raw.trimStart();
  if (src.startsWith("<task-notification")) {
    const out = ["<task-notification>"];
    // Status and summary first; the ids go last, where the cut can have them.
    for (const name of ["status", "summary", "tool-use-id", "task-id"]) {
      const t = tag(src, name);
      if (t && !t.cut && t.value) out.push(`<${name}>${flat(t.value)}</${name}>`);
    }
    return out.length > 1 ? out.join("") : raw;
  }
  if (src.startsWith("<cross-session-message")) {
    const close = src.indexOf(">");
    const name = close < 0 ? null : attr(src.slice(0, close), "from-name");
    if (name) return `<cross-session-message from-name="${name}">${src.slice(close + 1)}`;
  }
  return raw;
}
