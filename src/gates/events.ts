// What the person sees when a gate acts: the blocked-action cards in the
// agent's terminal, the approve-once question for irreversible actions, and
// the ledger record when the hook could not write it itself.
//
// Source of truth is canopy-hook: it decides, refuses the tool call, writes the
// block to the ledger and stamps the verdict on the hook event as
// `canopy_gate`. That event reaches this window over the same bus every hook
// event does (parsed in shared/notifications.ts), in both desktop and Linux
// workspace mode, so nothing here has to poll.

import type { AgentEventData, GateStamp } from "../../shared/notifications";
import * as ipc from "../ipc";
import { postAttention, resolveAttention } from "../attention";
import { appendLedger, queryLedger } from "../ledger";
import type { BlockData } from "./rules";

export type NoticeResolution = "approved" | "denied" | "dismissed";

export interface GateNotice {
  id: string;
  stamp: GateStamp;
  cwd: string;
  sessionId: string;
  ptyId: number | null;
  agent: string;
  ts: number;
  attentionId?: string;
  resolved?: NoticeResolution;
}

const MAX_NOTICES = 50;
let notices: GateNotice[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function gateNotices(): readonly GateNotice[] {
  return notices;
}

export function subscribeGateNotices(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The finding the card leads with: a written rule over a built-in. */
export function leadFinding(stamp: GateStamp) {
  return (
    stamp.findings.find((f) => f.kind === "rule") ??
    stamp.findings.find((f) => f.kind === "self-protect") ??
    stamp.findings[0]
  );
}

/** The card's headline, in the person's words, not the agent's. */
export function noticeTitle(stamp: GateStamp): string {
  const f = leadFinding(stamp);
  const what = f?.label ?? "an action";
  switch (stamp.status) {
    case "needs-approval":
      return f?.ruleText
        ? `Needs your OK (team rule '${f.ruleText}'): this ${what}`
        : `Needs your OK: this ${what}, which can't be undone`;
    case "allowed-once":
      return `Allowed once: this ${what}`;
    case "warned":
      return `Heads up: this ${what}`;
    case "refused":
      return `Canopy blocked: this ${what}`;
    default:
      return f?.ruleText
        ? `Canopy blocked: this ${what} — team rule '${f.ruleText}'`
        : `Canopy blocked: this ${what}`;
  }
}

/** What the action was, shortened for a card. */
export function actionText(stamp: GateStamp): string {
  const a = stamp.action.replace(/^(write|read|fetch):/, "");
  return a.length > 160 ? `${a.slice(0, 157)}…` : a;
}

/** Record the block in this window's ledger if the hook's own write didn't
 *  reach it — the Linux workspace case, where the hook writes the VM's ledger
 *  and the Rules panel reads the desktop's. Keyed on the event id, so the
 *  desktop case (already written) is a cheap no-op. */
async function ensureLedgered(n: GateNotice): Promise<void> {
  try {
    const found = await queryLedger(n.cwd, {
      kinds: ["rule"],
      refKind: "gate-event",
      refId: n.stamp.id,
      limit: 1,
    });
    if (found.length) return;
    const f = leadFinding(n.stamp);
    await appendLedger<BlockData>(n.cwd, {
      kind: "rule",
      author: { kind: "workspace", name: "gates", sessionId: n.sessionId || undefined, cli: n.agent || undefined },
      scope: "project",
      subject: f?.label ?? "",
      ref: { kind: "gate-event", id: n.stamp.id },
      status: n.stamp.status,
      data: {
        type: "block",
        status: n.stamp.status,
        ruleId: f?.ruleId ?? null,
        ruleText: f?.ruleText ?? null,
        class: f?.class ?? null,
        findingKind: f?.kind ?? null,
        label: f?.label ?? null,
        tool: n.stamp.tool,
        action: n.stamp.action,
        key: n.stamp.key,
        sessionId: n.sessionId,
      },
    });
  } catch {
    // A missing ledger costs a count, never the notice.
  }
}

/** Called with each hook-bridge batch (App.tsx). */
export function observeGateEvents(events: readonly (AgentEventData | null)[], ts = Date.now()): void {
  let changed = false;
  for (const e of events) {
    const stamp = e?.gate;
    if (!e || !stamp || notices.some((n) => n.id === stamp.id)) continue;
    const notice: GateNotice = {
      id: stamp.id,
      stamp,
      cwd: e.cwd,
      sessionId: e.sessionId,
      ptyId: e.pty,
      agent: e.agent,
      ts,
    };
    // An irreversible action waits on the person, so it is a question: it is
    // counted, it reaches the OS, and it stays outstanding until answered.
    // A plain block is worth knowing about but nobody is waiting.
    if (stamp.status === "needs-approval") {
      notice.attentionId = postAttention({
        kind: "question",
        tone: "warn",
        title: noticeTitle(stamp),
        body: actionText(stamp),
        source: "agent",
        dedupeKey: `gate:${stamp.key}`,
        where: e.pty != null ? { kind: "terminal", ptyId: e.pty, path: e.cwd } : { kind: "project", path: e.cwd },
      });
    } else if (stamp.status === "blocked" || stamp.status === "refused") {
      postAttention({
        kind: "fyi",
        tone: "warn",
        title: noticeTitle(stamp),
        body: actionText(stamp),
        source: "agent",
        where: e.pty != null ? { kind: "terminal", ptyId: e.pty, path: e.cwd } : { kind: "project", path: e.cwd },
      });
    }
    notices = [notice, ...notices].slice(0, MAX_NOTICES);
    changed = true;
    void ensureLedgered(notice);
  }
  if (changed) emit();
}

function resolve(id: string, resolution: NoticeResolution) {
  notices = notices.map((n) => (n.id === id ? { ...n, resolved: resolution } : n));
  emit();
}

/** Tell the agent, in its own terminal, what the person decided — it was told
 *  to stop and wait, so without this it would wait forever. */
function tellAgent(n: GateNotice, text: string) {
  if (n.ptyId == null) return;
  const pty = n.ptyId;
  void ipc.ptyWrite(pty, text).catch(() => {});
  window.setTimeout(() => void ipc.ptyWrite(pty, "\r").catch(() => {}), 350);
}

/** "Approve once" / "Allow once": mint the token for exactly this action and
 *  tell the agent it may retry. */
export async function allowOnce(n: GateNotice, opts: { tell?: boolean } = {}): Promise<void> {
  await ipc.gatesAllowOnce(n.stamp.key);
  if (n.attentionId) resolveAttention(n.attentionId, "answered");
  resolve(n.id, "approved");
  if (opts.tell !== false) {
    tellAgent(
      n,
      `Canopy: the person approved this once — you may run it now, exactly as before: ${actionText(n.stamp)}`,
    );
  }
}

export function denyNotice(n: GateNotice, opts: { tell?: boolean } = {}): void {
  if (n.attentionId) resolveAttention(n.attentionId, "answered");
  resolve(n.id, "denied");
  if (opts.tell !== false && n.stamp.status === "needs-approval") {
    tellAgent(n, `Canopy: the person declined. Don't run it, and don't try another way to do the same thing: ${actionText(n.stamp)}`);
  }
}

export function dismissNotice(n: GateNotice): void {
  if (n.attentionId) resolveAttention(n.attentionId, "dismissed");
  resolve(n.id, "dismissed");
}

/** Project roots whose view has the Rules panel ready to open — what
 *  "is there a rules editor for this project?" is answered from. */
const rulesEditors = new Map<number, () => readonly string[]>();
let nextEditor = 0;

/** A project view announces it can open the Rules panel for `roots` (it
 *  listens for OPEN_RULES_EVENT). Returns the unregister. */
export function registerRulesEditor(roots: () => readonly string[]): () => void {
  const id = ++nextEditor;
  rulesEditors.set(id, roots);
  return () => {
    rulesEditors.delete(id);
  };
}

/** Whether pressing "Team rules" for `path` opens a Rules panel. */
export function rulesEditorFor(path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const roots of rulesEditors.values()) {
    for (const raw of roots()) {
      const r = raw.replace(/\\/g, "/").replace(/\/+$/, "");
      if (r && (p === r || p.startsWith(`${r}/`))) return true;
    }
  }
  return false;
}

/** Ask the project view to open the Rules panel (ProjectView listens). */
export const OPEN_RULES_EVENT = "canopy:open-rules";
export function openRules(detail: { cwd: string; ruleId?: string }) {
  window.dispatchEvent(new CustomEvent(OPEN_RULES_EVENT, { detail }));
}

export function resetGateNoticesForTests(): void {
  notices = [];
  rulesEditors.clear();
  listeners.clear();
}
