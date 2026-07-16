// Derive pending questionnaires / notifications from the agent hook event
// stream. A Notification (permission request, idle prompt) or an
// AskUserQuestion (questionnaire) stays pending until a later event from the
// same session shows the agent moved on (tool ran, turn ended).
import type { AgentEventEntry } from "./types";

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

export interface PendingItem {
  key: string;
  kind: "question" | "notification";
  agent: string;
  sessionId: string;
  cwd: string;
  ts: number;
  message?: string;
  questions?: PendingQuestion[];
}

export function derivePending(events: AgentEventEntry[]): PendingItem[] {
  const pendingBySession = new Map<string, PendingItem[]>();

  for (const entry of events) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(entry.raw);
    } catch {
      continue;
    }
    const sessionId = String(parsed.session_id ?? parsed["conversation-id"] ?? "");
    if (!sessionId) continue;
    const cwd = String(parsed.cwd ?? "");
    const event = String(parsed.hook_event_name ?? parsed.type ?? "");
    const tool = String(parsed.tool_name ?? "");

    if (event === "PreToolUse" && tool === "AskUserQuestion") {
      const input = parsed.tool_input as { questions?: unknown[] } | undefined;
      const questions: PendingQuestion[] = Array.isArray(input?.questions)
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
      const list = pendingBySession.get(sessionId) ?? [];
      list.push({
        key: `${sessionId}-${entry.ts}-q`,
        kind: "question",
        agent: "claude",
        sessionId,
        cwd,
        ts: entry.ts,
        questions,
      });
      pendingBySession.set(sessionId, list);
    } else if (event === "Notification") {
      const list = pendingBySession.get(sessionId) ?? [];
      list.push({
        key: `${sessionId}-${entry.ts}-n`,
        kind: "notification",
        agent: "claude",
        sessionId,
        cwd,
        ts: entry.ts,
        message: String(parsed.message ?? "Agent needs attention"),
      });
      pendingBySession.set(sessionId, list);
    } else {
      // Any other event from this session (PostToolUse, Stop, ...) means the
      // agent progressed — everything pending before it is resolved.
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

export const pendingForRoots = (items: PendingItem[], roots: string[]): PendingItem[] =>
  items.filter((i) => roots.some((r) => i.cwd === r || i.cwd.startsWith(r + "/")));

/** The PTY an event came from, stamped into the payload by our hook command
 *  (agents.rs) from $CANOPY_PTY. Null for agents whose hooks can't carry it
 *  (e.g. codex), which then fall back to cwd matching. */
export function eventPtyId(raw: string): number | null {
  try {
    const v = (JSON.parse(raw) as { canopy_pty?: unknown }).canopy_pty;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

export function eventCwd(raw: string): string {
  try {
    return String((JSON.parse(raw) as { cwd?: unknown }).cwd ?? "");
  } catch {
    return "";
  }
}

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
    const pty = eventPtyId(e.raw);
    if (pty != null) return ptyIds.has(pty);
    const cwd = eventCwd(e.raw);
    return cwd !== "" && roots.some((r) => cwd === r || cwd.startsWith(r + "/"));
  });
}
