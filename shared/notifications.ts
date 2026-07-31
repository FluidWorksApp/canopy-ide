// Derive pending questionnaires / notifications from the agent hook event
// stream. A Notification (permission request, idle prompt) or an
// AskUserQuestion (questionnaire) stays pending until a later event from the
// same session shows the agent moved on (tool ran, turn ended).
//
// Shared, not desktop-only: `agent:event` is forwarded verbatim to every remote
// socket (see FORWARDED_EVENTS in portal.rs), so the portal derives the same
// cards from the same bytes. Two implementations of "is this agent blocked on
// me?" would disagree the day one of them is edited, and that disagreement is
// exactly the bug you cannot see from either screen alone. `src/types.ts`
// re-exports the four types below so the desktop keeps importing them from
// where it always has.

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

/** The projection of one agent hook event that the app actually reads. The raw
 *  line can carry tens of KB of tool payload (tool_input/tool_response) and
 *  used to be re-JSON.parsed by every consumer on every render — it is parsed
 *  exactly once, at ingest, and only these fields are kept. */
export interface AgentEventData {
  sessionId: string;
  cwd: string;
  /** canopy_pty stamp; null when the agent's hooks can't carry it (codex). */
  pty: number | null;
  /** hook_event_name, falling back to codex's `type`. */
  event: string;
  tool: string;
  /** Empty when the hook carried no agent stamp (a bare claude). */
  agent: string;
  message?: string;
  /** codex's turn-complete carries the agent's last words. */
  lastAssistantMessage?: string;
  transcriptPath?: string;
  /** AskUserQuestion payload, when this event is its PreToolUse. */
  questions?: PendingQuestion[];
}

export interface AgentEventEntry {
  ts: number;
  /** null: the line wasn't JSON. */
  data: AgentEventData | null;
}

export interface PendingItem {
  key: string;
  /** question/notification = the agent is blocked on the user (urgent).
   *  idle = the agent finished and is merely waiting — informational. */
  kind: "question" | "notification" | "idle";
  agent: string;
  sessionId: string;
  cwd: string;
  /** The terminal that raised it (canopy_pty stamp) — lets the UI clear items
   *  for a terminal the user is already looking at. Null when unstamped. */
  pty: number | null;
  ts: number;
  message?: string;
  questions?: PendingQuestion[];
}

/** Parse one raw hook line into the projection the app keeps. Done once, at
 *  ingest — everything downstream reads fields off `entry.data`. */
export function parseAgentEvent(raw: string): AgentEventData | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const event = String(parsed.hook_event_name ?? parsed.type ?? "");
  const tool = String(parsed.tool_name ?? "");
  const data: AgentEventData = {
    sessionId: String(parsed.session_id ?? parsed["conversation-id"] ?? ""),
    cwd: String(parsed.cwd ?? ""),
    pty: typeof parsed.canopy_pty === "number" ? parsed.canopy_pty : null,
    event,
    tool,
    // The helper stamps `agent` for every non-claude CLI it fronts; bare
    // claude events carry none.
    agent: typeof parsed.agent === "string" ? parsed.agent : "",
  };
  if (parsed.message != null) data.message = String(parsed.message);
  const last = parsed["last-assistant-message"];
  if (typeof last === "string" && last.trim())
    data.lastAssistantMessage = last.trim();
  if (typeof parsed.transcript_path === "string")
    data.transcriptPath = parsed.transcript_path;
  if (event === "PreToolUse" && tool === "AskUserQuestion") {
    const input = parsed.tool_input as { questions?: unknown[] } | undefined;
    data.questions = Array.isArray(input?.questions)
      ? (input!.questions as Record<string, unknown>[]).map((q) => ({
          question: String(q.question ?? ""),
          header: q.header ? String(q.header) : undefined,
          multiSelect: Boolean(q.multiSelect),
          options: Array.isArray(q.options)
            ? (q.options as Record<string, unknown>[]).map((o) => ({
                label: String(o.label ?? ""),
                description: o.description ? String(o.description) : undefined,
              }))
            : [],
        }))
      : [];
  }
  return data;
}

/** Claude's post-completion idle notice arrives through the same Notification
 *  hook as real permission requests — the message text is the only thing that
 *  tells "I'm blocked on you" apart from "I'm done and waiting". */
const IDLE_RE = /waiting for (your )?input/i;

export function derivePending(events: AgentEventEntry[]): PendingItem[] {
  const pendingBySession = new Map<string, PendingItem[]>();

  for (const entry of events) {
    const d = entry.data;
    if (!d) continue;
    const sessionId = d.sessionId;
    if (!sessionId) continue;
    const { cwd, pty, event, tool } = d;
    const agent = d.agent || "claude";

    if (event === "PreToolUse" && tool === "AskUserQuestion") {
      // An agent does one thing at a time, so one urgent card per session:
      // a new ask supersedes whatever was pending (the permission prompt for
      // this very tool call, an earlier answered-but-unresolved ask). Without
      // this, the same interaction showed as both "needs your permission" and
      // the question card, and stale asks accumulated.
      const list = pendingBySession.get(sessionId) ?? [];
      pendingBySession.set(sessionId, [
        ...list.filter((i) => i.kind === "idle"),
        {
          key: `${sessionId}-${entry.ts}-q`,
          kind: "question",
          agent,
          sessionId,
          cwd,
          pty,
          ts: entry.ts,
          questions: d.questions ?? [],
        },
      ]);
    } else if (event === "Notification" || event === "PermissionRequest") {
      const message =
        d.message ??
        (event === "PermissionRequest"
          ? `${agent} needs permission${tool ? `: ${tool}` : ""}`
          : "Agent needs attention");
      const list = pendingBySession.get(sessionId) ?? [];
      if (IDLE_RE.test(message)) {
        // Completion notice, not a request. One per session is enough —
        // replace an earlier one instead of stacking.
        pendingBySession.set(sessionId, [
          ...list.filter((i) => i.kind !== "idle"),
          {
            key: `${sessionId}-${entry.ts}-i`,
            kind: "idle",
            agent,
            sessionId,
            cwd,
            pty,
            ts: entry.ts,
            message,
          },
        ]);
      } else if (list.some((i) => i.kind === "question")) {
        // The question card already says "answer in terminal" — a permission
        // prompt for the same interaction adds a duplicate, not information.
      } else {
        pendingBySession.set(sessionId, [
          ...list.filter((i) => i.kind !== "notification"),
          {
            key: `${sessionId}-${entry.ts}-n`,
            kind: "notification",
            agent,
            sessionId,
            cwd,
            pty,
            ts: entry.ts,
            message,
          },
        ]);
      }
    } else if (event === "Stop" || /turn.complete/i.test(event)) {
      // The turn ended: everything pending is resolved, and the completion is
      // itself worth a calm card until the user re-engages (the next
      // UserPromptSubmit clears it). Codex's agent-turn-complete carries the
      // agent's last words; Claude's Stop carries nothing.
      const last = d.lastAssistantMessage ?? "";
      pendingBySession.set(sessionId, [
        ...(pendingBySession.get(sessionId) ?? []).filter(
          (i) => i.ts > entry.ts,
        ),
        {
          key: `${sessionId}-${entry.ts}-i`,
          kind: "idle",
          agent: d.agent || (event === "Stop" ? "claude" : "codex"),
          sessionId,
          cwd,
          pty,
          ts: entry.ts,
          message: last ? last.slice(0, 140) : "Finished — waiting for you",
        },
      ]);
    } else {
      // Any other event from this session (PostToolUse, SessionEnd, a new
      // prompt, ...) means the agent progressed — everything pending before
      // it is resolved.
      const list = pendingBySession.get(sessionId);
      if (list) {
        pendingBySession.set(
          sessionId,
          list.filter((item) => item.ts > entry.ts),
        );
      }
    }
  }

  return [...pendingBySession.values()].flat().sort((a, b) => b.ts - a.ts);
}

export const pendingForRoots = (
  items: PendingItem[],
  roots: string[],
): PendingItem[] =>
  items.filter((i) =>
    roots.some((r) => i.cwd === r || i.cwd.startsWith(r + "/")),
  );

/** The PTY an event came from, stamped into the payload by our hook command
 *  (agents.rs) from $CANOPY_PTY. Null for agents whose hooks can't carry it
 *  (e.g. codex), which then fall back to cwd matching. */
export const eventPtyId = (e: AgentEventEntry): number | null =>
  e.data?.pty ?? null;

/** Whether this hook event is the given terminal's turn ending — Claude's
 *  Stop, or codex's turn-complete. Micro-tasks wait on this before closing the
 *  tab: it means the job_done tool result reached the agent and the terminal
 *  has quiesced. */
export function isStopFor(e: AgentEventEntry, pty: number): boolean {
  const d = e.data;
  return (
    !!d &&
    d.pty === pty &&
    (d.event === "Stop" || /turn.complete/i.test(d.event))
  );
}

/** The last tool a terminal's agent finished using, from its PostToolUse hooks —
 *  "Bash", "Edit", "WebFetch". The only live progress signal a detached
 *  micro-task has: with no tab to glance at, "Bash · 2m" in the Tasks panel is
 *  the difference between a task working and a task wedged. */
export function lastStepFor(
  events: AgentEventEntry[],
  pty: number,
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const d = events[i].data;
    if (!d || d.pty !== pty || d.event !== "PostToolUse") continue;
    const tool = d.tool.trim();
    if (tool) return tool;
  }
  return undefined;
}

export const eventCwd = (e: AgentEventEntry): string => e.data?.cwd ?? "";

/** Keep only events belonging to this project: raised by one of its terminals,
 *  or (when unstamped) from a cwd inside it. Hooks are installed globally in
 *  ~/.claude/settings.json, so without this a claude running in any other app
 *  — or in another project's tab — would show up here. */
export function eventsForProject(
  events: AgentEventEntry[],
  ptyIds: Set<number>,
  roots: string[],
): AgentEventEntry[] {
  return events.filter((e) => {
    const d = e.data;
    if (!d) return false;
    if (d.pty != null) return ptyIds.has(d.pty);
    return (
      d.cwd !== "" &&
      roots.some((r) => d.cwd === r || d.cwd.startsWith(r + "/"))
    );
  });
}
