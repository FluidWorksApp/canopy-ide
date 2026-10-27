// Ownership approval without a pull request: a `layer-approval` card in team
// chat, sent to the layer's owner, and their answer flowing back.
//
//  1. An agent's write into an owned layer is stopped by the layer's gate
//     (lensGates.ts), or the builder lens sees a step that touched it.
//  2. "Send for approval" records a pending request (a `review` ledger entry)
//     and opens the share dialog addressed to the owner, with the card
//     carrying the files and a plain summary of the change.
//  3. The owner presses Approve or Reject on the card. That posts a
//     `layer-approval-outcome` card in the request's thread.
//  4. On the requester's machine the outcome is applied here, whether or not a
//     chat view is open (`startLensApprovals` listens to every team session):
//     only the owner's own answer counts, the ledger entry moves to approved
//     or rejected, and the policy is republished so the approved files pass
//     the gate. The person is told, and the builder lens offers to tell Build.

import { postAttention } from "./attention";
import { cardOf, LIMITS, cleanLine, validCardPath, type LayerApprovalCard } from "./teamMessaging/cardSchema";
import { subscribeTeamMessages, type TeamMessageEvent } from "./teamMessaging/session";
import { openShareDialog, repoRefFor, clipLines, cleanBlock } from "./shareCards";
import { republishPolicy } from "./gates/rules";
import { LAYER_LABEL, relativeTo, type OwnedLayerHit } from "./lensLayers";
import {
  layerApprovals,
  writeApproval,
  type ApprovalStatus,
  type LayerApprovalData,
} from "./lensGates";
import type { LedgerEntry } from "./ledger";

/** Same shape cardSchema accepts (APPROVAL_ID). */
export function newApprovalId(now: number = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, "") || "0";
  return `la-${now.toString(36)}${rand}`.slice(0, 35);
}

// ------------------------------------------------------------- registry
// Which repository each request this machine sent belongs to, so an answer
// arriving in chat (which names no path) finds its ledger.

const REGISTRY_KEY = "canopy.lens.approvals";
const REGISTRY_MAX = 200;

function readRegistry(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function remember(id: string, root: string): void {
  const next = { ...readRegistry(), [id]: root };
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - REGISTRY_MAX))) delete next[k];
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(next));
  } catch {
    // Private window: the answer still shows in chat, it just can't lift the gate here.
  }
}

export const approvalRoot = (id: string): string | null => readRegistry()[id] ?? null;

// ------------------------------------------------------------- changes

const listeners = new Set<() => void>();
export function subscribeLayerApprovals(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
const changed = () => listeners.forEach((cb) => cb());

// --------------------------------------------------------------- request

export interface ApprovalRequestInput {
  root: string;
  projectName: string;
  hit: OwnedLayerHit;
  /** What was asked for, in the person's words. */
  goal?: string;
  /** What the agent tried and was stopped from doing, if anything. */
  attempted?: string[];
  /** Diff text of files already changed, if any. */
  diff?: string;
}

/** The plain summary the owner reads on the card. */
export function approvalSummary(input: Pick<ApprovalRequestInput, "goal" | "attempted" | "diff" | "hit">): string {
  const parts: string[] = [];
  if (input.goal?.trim()) parts.push(`What was asked for: ${cleanLine(input.goal, 400)}`);
  if (input.attempted?.length) {
    parts.push("What the agent tried and was stopped from doing:", ...input.attempted.slice(0, 8).map((a) => `- ${cleanLine(a, 200)}`));
  }
  if (input.diff?.trim()) {
    parts.push("The change so far:", clipLines(cleanBlock(input.diff), LIMITS.approvalSummaryBytes - 1500).text);
  }
  if (!parts.length) parts.push(`A change to ${input.hit.files.length} file(s) in ${LAYER_LABEL[input.hit.layer]}.`);
  return clipLines(parts.join("\n"), LIMITS.approvalSummaryBytes).text;
}

export type RequestResult = { ok: true; id: string } | { ok: false; message: string };

/** Record the request and open the share dialog addressed to the owner. */
export async function requestLayerApproval(input: ApprovalRequestInput): Promise<RequestResult> {
  const { root, hit } = input;
  if (!hit.ownerId) {
    return {
      ok: false,
      message: `${hit.owner} claimed ${LAYER_LABEL[hit.layer]} before ownership used Canopy accounts. Ask them to let go and claim it again while signed in.`,
    };
  }
  const files = [...new Set(hit.files.map((f) => relativeTo(root, f)).filter(validCardPath))].slice(0, LIMITS.approvalFiles);
  if (!files.length) return { ok: false, message: "There are no files to ask about." };
  const id = newApprovalId();
  const summary = approvalSummary(input);
  const repo = await repoRefFor(root).catch(() => undefined);
  const card: LayerApprovalCard = {
    type: "layer-approval",
    v: 1,
    approval: id,
    layer: hit.layer,
    owner: hit.ownerId,
    project: cleanLine(input.projectName, LIMITS.title) || "this project",
    files,
    summary,
    ...(repo ? { repo } : {}),
  };
  remember(id, root);
  await writeApproval(
    root,
    {
      type: "layer-approval",
      approvalId: id,
      layer: hit.layer,
      owner: hit.owner,
      ownerId: hit.ownerId,
      files,
      summary,
      status: "pending",
      requestedAt: Date.now(),
    },
    null,
  );
  changed();
  openShareDialog({ kind: "share", card, to: hit.ownerId });
  return { ok: true, id };
}

// ----------------------------------------------------------------- answer

export interface ApprovalAnswer {
  approval: string;
  outcome: "approved" | "rejected";
  /** The answering account's id, as the chat envelope proved it. */
  by: string;
  byName?: string;
  note?: string;
}

/** Apply an owner's answer on the requester's machine. Ignores answers from
 *  anyone but the owner, answers to requests this machine didn't send, and
 *  repeats. Resolves with the updated entry, or null when nothing changed. */
export async function applyLayerApprovalAnswer(
  answer: ApprovalAnswer,
  deps: { republish?: (root: string) => Promise<void>; now?: () => number } = {},
): Promise<LedgerEntry<LayerApprovalData> | null> {
  const root = approvalRoot(answer.approval);
  if (!root) return null;
  const entry = (await layerApprovals(root)).find((e) => e.data.approvalId === answer.approval);
  if (!entry || !entry.data.ownerId || entry.data.ownerId !== answer.by) return null;
  const status: ApprovalStatus = answer.outcome;
  if (entry.data.status === status) return null;
  const next = await writeApproval(
    root,
    {
      ...entry.data,
      status,
      decidedAt: (deps.now ?? Date.now)(),
      decidedBy: answer.byName || entry.data.owner,
      ...(answer.note ? { note: cleanLine(answer.note, 400) } : {}),
    },
    entry,
  );
  await (deps.republish ?? republishPolicy)(root).catch(() => undefined);
  postAttention({
    kind: "fyi",
    tone: status === "approved" ? "info" : "warn",
    title:
      status === "approved"
        ? `${answer.byName || entry.data.owner} approved the ${LAYER_LABEL[entry.data.layer]} change`
        : `${answer.byName || entry.data.owner} rejected the ${LAYER_LABEL[entry.data.layer]} change`,
    body:
      status === "approved"
        ? `The agent may now change ${entry.data.files.slice(0, 4).join(", ")}${entry.data.files.length > 4 ? "…" : ""} for the next day.`
        : answer.note || "The files stay protected. Ask Build for a different approach.",
    source: "agent",
    dedupeKey: `lens-approval:${answer.approval}:${status}`,
    where: { kind: "project", path: root },
  });
  changed();
  return next;
}

/** The answer a chat message carries, if it is one. */
export function answerFrom(event: Pick<TeamMessageEvent, "message" | "senderName">): ApprovalAnswer | null {
  const card = cardOf(event.message);
  if (card?.type !== "layer-approval-outcome") return null;
  const note = event.message.text.split("\n")[0]?.trim();
  return {
    approval: card.approval,
    outcome: card.outcome,
    by: event.message.sender,
    ...(event.senderName ? { byName: event.senderName } : {}),
    ...(note && !note.startsWith("✅") && !note.startsWith("⛔") ? { note } : {}),
  };
}

/** Listen for owners' answers in every team session, app-wide. */
export function startLensApprovals(): () => void {
  return subscribeTeamMessages((event) => {
    const answer = answerFrom(event);
    if (answer) void applyLayerApprovalAnswer(answer).catch(() => undefined);
  });
}

/** Tests only. */
export function resetLensApprovalsForTests(): void {
  listeners.clear();
  try {
    localStorage.removeItem(REGISTRY_KEY);
  } catch {
    /* nothing stored */
  }
}
