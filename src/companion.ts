// The companion: Ash with a session behind it.
//
// Ash already existed as a *face* — eight lifecycle states every surface renders
// through <Mascot state=… /> (see ash.ts, mascots.ts). This is the other half:
// one persistent agent that floats over the whole app, belongs to no project,
// and answers about all of them.
//
// The distinction that shapes every decision here is that the companion is NOT
// a coding agent that happens to be pinned. A coding agent is born in one
// checkout, does one job against it, and dies. The companion outlives every
// project, is asked "which repos have unpushed work" as often as "what does
// this function do", and is the only agent that can act somewhere the user is
// not looking. That last property is why authority is a first-class setting
// rather than a permission flag, and why the write gate is enforced at the
// bridge rather than requested in a prompt.
//
// Everything here is pure — vocabulary, geometry and resolution — so the
// placement and authority rules can be tested without a CLI, a PTY or a DOM.
// The live session lives in companionSession.ts, the drawing in
// components/Companion.tsx.

import { AGENT_CLIS, type AgentCli } from "./projects";
import { mascotDef } from "./mascots";
import { getSettings, updateSettings } from "./settings";

/** What the companion may do on its own.
 *
 *  The default is `confirm`, and the reason is the cross-project reach rather
 *  than any general caution about agents: an agent acting inside the checkout
 *  you are staring at is visible and therefore correctable, whereas this one
 *  can start a server or move a branch in a repo whose tab is not even open. A
 *  confirmation is the only moment the user is told *where* the action lands.
 *
 *  `read` is not "safe mode" — it is a coherent product in its own right for
 *  someone who wants a librarian and not a deputy — and `auto` exists because
 *  a user who has watched it work for a week should be able to stop clicking. */
export type CompanionAuthority = "read" | "confirm" | "auto";

export const COMPANION_AUTHORITIES: {
  id: CompanionAuthority;
  label: string;
  note: string;
}[] = [
  {
    id: "read",
    label: "Answer only",
    note: "Reads everything, changes nothing.",
  },
  {
    id: "confirm",
    label: "Ask before acting",
    note: "Asks before it changes anything.",
  },
  {
    id: "auto",
    label: "Act on its own",
    note: "Acts without asking, anywhere.",
  },
];

/** Whether an action that changes something may run at all, and whether it has
 *  to be put to the user first. Read by the bridge, not by the prompt — a rule
 *  an agent is merely *told* is a rule it can talk itself out of. */
export function actionPolicy(a: CompanionAuthority): "deny" | "confirm" | "allow" {
  return a === "read" ? "deny" : a === "confirm" ? "confirm" : "allow";
}

// ---------------------------------------------------------------- identity

/** What the companion is called.
 *
 *  Defaults to the chosen mascot's own name rather than a hardcoded "Ash", so
 *  a second mascot arrives already named and no call site has to learn about
 *  the first one — the same rule mascots.ts sets for the face. A non-empty
 *  setting is the user overriding that, which is the whole point of a
 *  companion you address by name. */
export function companionName(): string {
  return getSettings().companionName.trim() || mascotDef().label;
}

/** The name as it appears where only ASCII survives — an env var the CLI reads,
 *  a session title, a log line. */
export function companionSlug(): string {
  const slug = companionName()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "ash";
}

// ---------------------------------------------------------------- the CLI

/** How well a given CLI can carry a chat.
 *
 *  `structured` — the CLI speaks a documented streaming JSON protocol on stdio,
 *  so replies arrive as tokens, tool calls arrive as events, and the chat can
 *  render thinking, tools and prose as the different things they are. This is
 *  the experience the companion is designed around.
 *
 *  `terminal` — everything else. The CLI is driven the way a person drives it,
 *  through a PTY, and its answer is recovered by replaying what it painted
 *  (ptyText.ts). It works with any agent the user has, which is the point, but
 *  a redrawing TUI cannot be separated cleanly into turns, so the chat shows
 *  the reply whole rather than streaming and cannot label tool calls.
 *
 *  Declared per CLI rather than detected, under the same rule projects.ts sets
 *  for `resume` and `prompt`: only syntax verified against the CLI's own help
 *  is written down, because a wrong flag does not error — it silently produces
 *  a session that ignores half of what it was told. */
export type CompanionTier = "structured" | "oneshot" | "terminal";

/** The verified way to run one CLI as a companion.
 *
 *  Absent from the table entirely means `terminal`: the fallback needs no
 *  knowledge beyond what projects.ts already has, which is what makes every
 *  agent the user installs usable here on day one.
 */
export interface CompanionRunner {
  tier: "structured" | "oneshot";
  /** Build the argv tail for a fresh session. `bin` is the *resolved* binary
   *  (Settings → Agents can rebind it), never the vendor's name. */
  args(o: CompanionLaunch): string[];
  /** The same, resuming the session id the companion has been using. A CLI
   *  that cannot resume by id has no business in this tier: the companion's
   *  memory of the user *is* its conversation, and losing it on every restart
   *  would make "remembers who it is" false. */
  resumeArgs(o: CompanionLaunch & { sessionId: string }): string[];
}

export interface CompanionLaunch {
  bin: string;
  sessionId: string;
  systemPrompt: string;
  /** Every project root in the workspace — the companion's reach. */
  roots: string[];
  /** Empty means "the CLI's own default model". */
  model: string;
  authority: CompanionAuthority;
}

/**
 * Verified against `claude --help` on the installed CLI:
 *   --session-id <uuid>            fixed id, so the conversation is ours to resume
 *   --append-system-prompt <text>  adds to the default prompt, does not replace it
 *   --add-dir <dirs...>            the cross-project reach, in one session
 *   --model <model>                alias or full id
 *   -p --input-format stream-json --output-format stream-json
 *                                  JSONL both ways, which is the whole tier
 *   --include-partial-messages     token deltas rather than whole turns
 *   --verbose                      REQUIRED with `-p --output-format stream-json`;
 *                                  without it the CLI refuses to start at all
 *   --permission-mode <mode>       the CLI's own gate on its own tools
 *
 * `--append-system-prompt` rather than `--system-prompt` on purpose: replacing
 * the prompt would also throw away the CLI's knowledge of its own tools, and
 * the companion's brief is an addition to that, not a substitute for it.
 */
/**
 * Permission flags — the half of the design that nearly sank it.
 *
 * Claude Code does not auto-grant MCP tools: they wait on a prompt. In headless
 * `-p` mode there is nobody to answer that prompt, so every `canopy_*` call
 * came back ungranted — including read-only ones like `canopy_project`. The
 * companion could see its tools, call them, and have all of them refused, which
 * it then explained to the user as "approve these in Canopy's permission
 * settings" — a screen that does not exist.
 *
 * So the CLI's own prompt is bypassed, and the gating is done where it can
 * actually reach a human: `companion_gate` in canopy_hook.rs, which puts the
 * action on screen and blocks on the answer.
 *
 * That leaves the CLI's *built-in* tools, which the bridge cannot see. Bash,
 * Edit and Write would change the world without ever passing the gate, so they
 * are disallowed outright — at every authority, including "act freely".
 *
 * At every authority because the companion does not edit files. That is what it
 * *is*, not a caution that scales with trust: it is the assistant that answers
 * across eight projects, and the thing that edits code is a coding agent in one
 * checkout, whose work the user can see in a diff, on a branch, in a session
 * they opened. "Act freely" is freedom with Canopy's own tools — start a
 * server, make a worktree, write a note — not a licence to rewrite source in a
 * project whose tab is not even open.
 *
 * Withheld rather than requested, on this file's usual terms: the brief also
 * says it, but a brief is a rule an agent can reason its way past, and this is
 * the worst agent to discover that on. Reading is untouched (Read, Grep, Glob),
 * which is what "understand code across repos" actually needs.
 */
const BUILTIN_WRITERS = ["Edit", "Write", "NotebookEdit", "Bash", "KillShell"];

export function permissionArgs(_authority: CompanionAuthority): string[] {
  return [
    "--permission-mode",
    "bypassPermissions",
    "--disallowedTools",
    ...BUILTIN_WRITERS,
  ];
}

const CLAUDE_RUNNER: CompanionRunner = {
  tier: "structured",
  args: (o) => [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    // Not optional and not cosmetic: `-p --output-format stream-json` without
    // it exits immediately with "requires --verbose", so the companion never
    // starts. It costs a few extra `type: "system"` lines the parser ignores.
    "--verbose",
    "--session-id",
    o.sessionId,
    "--append-system-prompt",
    o.systemPrompt,
    ...o.roots.flatMap((r) => ["--add-dir", r]),
    ...(o.model ? ["--model", o.model] : []),
    ...permissionArgs(o.authority),
  ],
  // --resume takes the id and keeps the same conversation; the prompt and dirs
  // are passed again because they describe *this* launch (the workspace may
  // have gained a project since) and neither is stored in the transcript.
  resumeArgs: (o) => [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--resume",
    o.sessionId,
    "--append-system-prompt",
    o.systemPrompt,
    ...o.roots.flatMap((r) => ["--add-dir", r]),
    ...(o.model ? ["--model", o.model] : []),
    ...permissionArgs(o.authority),
  ],
};

/**
 * Codex, in the `oneshot` tier.
 *
 * `codex exec` is non-interactive and ends with its turn — there is no
 * long-lived stdin to write the next message to, so a process per turn is not
 * a workaround, it is the shape of the CLI. `exec resume <thread_id>` is what
 * makes that a conversation rather than a series of strangers.
 *
 * Verified against the installed CLI, both halves:
 *   codex exec --json                 -> {"type":"thread.started","thread_id":…}
 *                                       {"type":"item.completed","item":{"type":"agent_message","text":…}}
 *                                       {"type":"turn.completed",…}
 *   codex exec resume <id> --json     -> same thread_id, and it recalled a fact
 *                                       from the previous turn
 *
 * `--skip-git-repo-check` is required: the companion runs in ~/.canopy/companion,
 * which is deliberately not a repo, and codex refuses to start outside one.
 *
 * The thread id comes back on the FIRST turn rather than being chosen up front
 * (unlike claude's `--session-id`), which is why `sessionId` is ignored here and
 * companionSession records what `thread.started` reports.
 */
const CODEX_RUNNER: CompanionRunner = {
  tier: "oneshot",
  args: (o) => [
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...(o.model ? ["-m", o.model] : []),
    ...codexSandbox(o.authority),
  ],
  resumeArgs: (o) => [
    "exec",
    "resume",
    o.sessionId,
    "--json",
    "--skip-git-repo-check",
    ...(o.model ? ["-m", o.model] : []),
    ...codexSandbox(o.authority),
  ],
};

/** Codex's own sandbox — read-only at every authority, which is codex's half of
 *  "the companion does not edit files".
 *
 *  The same reasoning as claude's disallowed built-ins, and it has to be the
 *  same *answer* or the guarantee would depend on which CLI the user happened
 *  to pick: codex's default sandbox is workspace-write, so leaving anything
 *  above answer-only to the default meant the companion could edit files
 *  through its own tools on codex while it could not on claude. The gate only
 *  governs `canopy_*` calls; it never sees a write codex makes on its own.
 *
 *  `authority` is still what decides the gate, and every mutating canopy_* tool
 *  it grants keeps working — this sandbox governs codex's own shell and file
 *  ops, not MCP. */
function codexSandbox(_authority: CompanionAuthority): string[] {
  return ["-c", "sandbox_mode=\"read-only\""];
}

/** Keyed by the registry id in projects.ts. Each entry is a statement about
 *  what has been *verified* against that CLI, not about what is supported:
 *  every CLI without one still runs, in the terminal tier. */
export const COMPANION_RUNNERS: Record<string, CompanionRunner> = {
  claude: CLAUDE_RUNNER,
  codex: CODEX_RUNNER,
};

export function tierFor(cliId: string): CompanionTier {
  return COMPANION_RUNNERS[cliId]?.tier ?? "terminal";
}

/** One line for the settings row, so the choice is made with its consequence
 *  visible rather than discovered afterwards. */
export function tierNote(cliId: string): string {
  switch (tierFor(cliId)) {
    case "structured":
      return "Streams replies.";
    case "oneshot":
      return "Replies arrive whole; conversation is kept.";
    default:
      return "Replies arrive whole, not streamed.";
  }
}

/** Which CLI the companion runs on. The only answer to that question — the
 *  session, the settings screen and anything else all ask here.
 *
 *  The order is the user's, and nothing else gets a vote:
 *
 *    1. what they picked for the companion
 *    2. their default agent, so someone who never opened this screen gets the
 *       CLI they already use
 *    3. whatever is installed
 *
 *  Deliberately NOT ranked by whether Canopy has a verified runner for the CLI.
 *  A tier is a statement about which flags were checked against which binary —
 *  it says nothing about which agent the user would rather talk to, and using
 *  it to reorder this list would quietly overrule a choice they made. A CLI
 *  with no runner still works; it just runs in the terminal tier, and the
 *  settings row says so before they pick. */
export function companionCli(
  installed: (bin: string) => boolean,
): AgentCli | null {
  const s = getSettings();
  const usable = AGENT_CLIS.filter((c) => installed(c.bin));
  if (usable.length === 0) return null;
  return (
    usable.find((c) => c.id === s.companionCli) ??
    usable.find((c) => c.id === s.defaultAgent) ??
    usable[0]
  );
}

/** The companion's conversation with this CLI, minted once and then kept.
 *
 *  This is the load-bearing piece of "remembers who it is": the CLI stores the
 *  transcript against the id, so holding the id is what makes tomorrow's
 *  companion the same one as today's. Minted here rather than accepted from
 *  the CLI because the structured tier has to *name* the session at launch —
 *  it is `--session-id`, not something read back afterwards.
 *
 *  A v4 UUID because that is what the flag accepts. Kept per CLI: switching
 *  agent and switching back returns to the right conversation rather than
 *  fusing two transcripts that were never in the same format. */
export function companionSessionId(cliId: string): string {
  const existing = getSettings().companionSessions[cliId];
  if (existing) return existing;
  const id = newSessionId();
  updateSettings({
    companionSessions: { ...getSettings().companionSessions, [cliId]: id },
  });
  return id;
}

/** Forget the conversation — the "start over" the settings screen offers. The
 *  next launch mints a new id, which is what makes it a fresh acquaintance
 *  rather than a cleared screen over the same memory. */
export function forgetCompanionSession(cliId: string): void {
  const rest = { ...getSettings().companionSessions };
  delete rest[cliId];
  updateSettings({ companionSessions: rest });
}

function newSessionId(): string {
  // randomUUID needs a secure context, which the app always is — but tests and
  // the odd embedded webview are not, and a companion that cannot start
  // because of an id generator is a poor trade.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

// ---------------------------------------------------------------- placement

/** Where the companion sits, as a fraction of the space it can occupy.
 *
 *  Fractions rather than pixels because the window is resized constantly — a
 *  remembered `left: 1380px` is off-screen the moment the window narrows, and
 *  a position you have to re-set after every resize is not a remembered
 *  position. 0 is flush left/top, 1 is flush right/bottom, so the value is
 *  meaningful at any window size and clamping is the same operation as
 *  validating it. */
export interface CompanionSpot {
  x: number;
  y: number;
}

/** Bottom-right, above the status bar: the corner least likely to sit over the
 *  editor's first column or the tab strip, and the one every floating helper
 *  in every other app has trained people to look at. */
export const DEFAULT_SPOT: CompanionSpot = { x: 0.97, y: 0.86 };

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function clampSpot(spot: Partial<CompanionSpot> | null | undefined): CompanionSpot {
  return { x: clamp01(spot?.x ?? DEFAULT_SPOT.x), y: clamp01(spot?.y ?? DEFAULT_SPOT.y) };
}

export interface Viewport {
  width: number;
  height: number;
}

/** The chat panel at rest, and the size the expand control grows it to.
 *
 *  Two sizes rather than a resize handle: the panel is anchored to a mascot the
 *  user drags around, so a remembered width and height would have to be
 *  re-clamped against every window and every corner — for a surface whose only
 *  real question is "am I reading a sentence or a conversation". */
export const PANEL = { width: 352, height: 380 };
export const PANEL_BIG = { width: 620, height: 660 };

/** The panel's box, never larger than the window it has to live in. Clamped
 *  here rather than in CSS because the placement arithmetic is done in pixels
 *  before anything is drawn — a panel that is 660 tall in a 500px window would
 *  be placed as if it fit and take its input off the bottom edge. */
export function panelSize(
  expanded: boolean,
  view: Viewport,
  gap = 14,
): { width: number; height: number } {
  const base = expanded ? PANEL_BIG : PANEL;
  return {
    width: Math.max(240, Math.min(base.width, view.width - gap * 2)),
    height: Math.max(220, Math.min(base.height, view.height - gap * 2)),
  };
}

// ------------------------------------------------------------- the tool trail

/** How a tool call is written for a reader.
 *
 *  An MCP tool arrives as `mcp__canopy__canopy_show_diff`, and on a single
 *  truncating line that is a row of prefix with the actual verb cut off the
 *  end — the one part of the name that says what is happening. */
export function toolLabel(name: string): string {
  const parts = name.split("__");
  return parts[0] === "mcp" && parts.length >= 3 ? parts.slice(2).join("__") : name;
}

const DETAIL_MAX = 44;

/** The argument, shortened from the front.
 *
 *  Paths are the common case and their meaning is at the tail: ten calls into a
 *  turn every chip said `/Users/shoaib/Documents/GitHub/canopy/…` and nothing
 *  else. Trailing ellipsis is kept for everything that is not a path, where the
 *  front is what identifies it. */
export function toolDetail(detail: string | undefined | null): string {
  const d = (detail ?? "").trim();
  if (d.length <= DETAIL_MAX) return d;
  if (d.includes("/") && !/\s/.test(d)) {
    const parts = d.split("/").filter(Boolean);
    let out = parts.pop() ?? d;
    while (parts.length && out.length + parts[parts.length - 1].length + 1 <= DETAIL_MAX) {
      out = `${parts.pop()}/${out}`;
    }
    return out.length > DETAIL_MAX ? `…${out.slice(-DETAIL_MAX)}` : `…/${out}`;
  }
  return `${d.slice(0, DETAIL_MAX - 1)}…`;
}

/** Fraction -> the pixel offset to render at, never off-screen by
 *  construction: the travel is the viewport minus the mascot, so x=1 puts its
 *  right edge on the right edge rather than its left edge past it. */
export function spotToPixels(spot: CompanionSpot, view: Viewport, size: number): {
  left: number;
  top: number;
} {
  const travelX = Math.max(0, view.width - size);
  const travelY = Math.max(0, view.height - size);
  const s = clampSpot(spot);
  return { left: Math.round(s.x * travelX), top: Math.round(s.y * travelY) };
}

/** The inverse, for the end of a drag. */
export function pixelsToSpot(
  left: number,
  top: number,
  view: Viewport,
  size: number,
): CompanionSpot {
  const travelX = Math.max(1, view.width - size);
  const travelY = Math.max(1, view.height - size);
  return clampSpot({ x: left / travelX, y: top / travelY });
}

/** Which side the chat panel opens on, and how far down it starts.
 *
 *  The panel is anchored to the companion rather than to a corner, because the
 *  companion is what the user just clicked and a surface that appears somewhere
 *  else reads as a different feature. It flips side when there is no room —
 *  measured against the actual panel width rather than a hardcoded midpoint, so
 *  it stays correct in a narrow window where *everything* is past the middle. */
export function panelPlacement(
  at: { left: number; top: number },
  view: Viewport,
  opts: { mascot: number; panelWidth: number; panelHeight: number; gap: number },
): { left: number; top: number; side: "left" | "right" } {
  const { mascot, panelWidth, panelHeight, gap } = opts;
  const rightEdge = at.left + mascot + gap + panelWidth;
  // Prefer the right, flip when it would overflow — and only take the left if
  // there is actually room there, otherwise a companion dragged into a corner
  // of a narrow window flips into a worse position than it started in.
  const fitsRight = rightEdge <= view.width;
  const fitsLeft = at.left - gap - panelWidth >= 0;
  const side: "left" | "right" = fitsRight || !fitsLeft ? "right" : "left";
  const left =
    side === "right"
      ? Math.min(at.left + mascot + gap, Math.max(0, view.width - panelWidth))
      : Math.max(0, at.left - gap - panelWidth);
  // Grows downward from the companion where it can, and is pushed up by the
  // bottom edge otherwise — a panel whose input sits below the window is a
  // panel you cannot type into, which is the one failure worth clamping for.
  const top = Math.max(0, Math.min(at.top, view.height - panelHeight));
  return { left, top, side };
}

/** Summoning it from the keyboard.
 *
 *  The panel's open state is the component's own — it is one mounted instance
 *  and nothing else has ever needed to move it — so this is a nudge rather than
 *  a store: App raises it when the chord fires, the companion decides what to
 *  do with it (open and take focus, or put itself away). A shortcut that had to
 *  own the state would mean hoisting the panel's whole open/close life into
 *  App for one keypress.
 */
export const COMPANION_SUMMON_EVENT = "canopy:companion-summon";

export const summonCompanion = () =>
  window.dispatchEvent(new CustomEvent(COMPANION_SUMMON_EVENT));
