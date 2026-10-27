// The handoff packet: everything a successor — a teammate, or a fresh agent on
// any CLI — needs to pick a session up without a rediscovery pass.
//
// Structured context is the point (state, decisions with their reasons,
// constraints, open questions, next steps, files, the latest proof receipt,
// how to resume): successors handed that do measurably less re-work than ones
// handed only the repository. The judgment parts are the brain's, on the main
// tier because a person pressed "Hand off…" and is waiting; the factual parts
// (files, receipt, session identity) are filled in here from the document, so
// the brain cannot misremember them.
//
// A packet is a durable artifact, so it goes in the ledger as a `handoff`
// entry referencing the session. Its markdown is what every target carries —
// the clipboard, the team-chat card, a new agent's brief — so what the person
// previews is byte for byte what leaves.

import { askBrain, type BrainAnswer } from "../brainCall";
import { appendLedger, type LedgerEntry } from "../ledger";
import { transcriptTail, turnLines, type ReceiptVerdict, type SessionDocument } from "./assemble";
import { askInSession, validateNarrative, type Decision, type SessionNarrative } from "./narrative";

export interface HandoffPacket {
  v: 1;
  title: string;
  goal: string;
  /** Where the work stands right now, in a few sentences. */
  state: string;
  decisions: Decision[];
  /** Things the successor must keep true: agreed scope, "don't touch X",
   *  conventions the session followed. */
  constraints: string[];
  openQuestions: string[];
  nextSteps: string[];
  risks: string[];
  files: string[];
  latestReceipt?: { verdict: ReceiptVerdict; label: string };
  /** The brain's advice on how to resume, plus what Canopy knows (the CLI's
   *  own resume, when it has one). */
  howToResume: string;
  session: { id: string; agent: string; dir: string; branch?: string };
  createdAt: number;
}

/** What the brain is asked to write; the rest is filled in from the doc. */
interface BrainPacket {
  title: string;
  state: string;
  decisions: Decision[];
  constraints: string[];
  openQuestions: string[];
  nextSteps: string[];
  risks: string[];
  howToResume: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function validateBrainPacket(v: unknown): BrainPacket | null {
  if (!isObj(v)) return null;
  const state = typeof v.state === "string" ? v.state.trim() : "";
  if (!state) return null;
  // Decisions, open questions, next steps and risks share the narrative's
  // rules; reuse its validator rather than restating them.
  const shared = validateNarrative({ ...v, summary: state });
  if (!shared) return null;
  const constraints = Array.isArray(v.constraints)
    ? v.constraints.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => clip(s.trim(), 300)).slice(0, 12)
    : v.constraints === undefined
      ? []
      : null;
  if (!constraints) return null;
  return {
    title: typeof v.title === "string" && v.title.trim() ? clip(v.title.trim(), 120) : "",
    state: clip(state, 2000),
    decisions: shared.decisions,
    constraints,
    openQuestions: shared.openQuestions,
    nextSteps: shared.nextSteps,
    risks: shared.risks,
    howToResume: typeof v.howToResume === "string" ? clip(v.howToResume.trim(), 1200) : "",
  };
}

export function handoffPrompt(doc: SessionDocument, narrative?: SessionNarrative | null): string {
  const files = doc.files.slice(0, 40).map((f) => `- ${f.path}`).join("\n");
  const prior = narrative
    ? `\nAn earlier reading of this session (may be one or more turns old):\n${JSON.stringify(narrative)}\n`
    : "";
  return [
    "Write a handoff packet for this coding-agent session. Someone else — a teammate, or a fresh agent on a different tool — will continue the work from this packet alone, without the conversation.",
    "Be concrete and faithful to the material: name files, commands, decisions and the reasons given. Do not invent progress. Anything uncertain goes under openQuestions.",
    "",
    `Goal: ${doc.goal.text || "(none captured)"}`,
    doc.goal.steps.length ? `Plan steps:\n${doc.goal.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "",
    "",
    "Turns (prompt — files changed — proof receipt):",
    turnLines(doc) || "(no turns recorded)",
    "",
    "Files changed:",
    files || "(none recorded)",
    doc.latestReceipt ? `\nLatest proof receipt: ${doc.latestReceipt.verdict} — ${doc.latestReceipt.label}` : "",
    prior,
    "End of the conversation transcript (oldest first, may be cut at the start):",
    transcriptTail(doc.transcript, 30_000) || "(transcript not available)",
    "",
    "Reply with ONE JSON object and nothing else:",
    '{"title": "short name for the work",',
    ' "state": "where the work stands right now: done, half-done, broken, verified or not",',
    ' "decisions": [{"decision": "...", "why": "...", "alternativesRejected": ["..."]}],',
    ' "constraints": ["things the successor must keep true or must not do"],',
    ' "openQuestions": ["..."],',
    ' "nextSteps": ["ordered, concrete next actions"],',
    ' "risks": ["..."],',
    ' "howToResume": "how to pick this up: what to check first, what to run, where to look"}',
    "Use empty arrays where there is nothing to say. At most 8 items per list.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** The packet, from the brain's part and the document's facts. */
export function buildPacket(
  doc: SessionDocument,
  brain: BrainPacket,
  extra: { branch?: string; resumeCommand?: string | null; now?: number } = {},
): HandoffPacket {
  const dir = doc.cwd.split(/[\\/]/).filter(Boolean).pop() ?? doc.cwd;
  const resume = [
    brain.howToResume,
    extra.resumeCommand
      ? `The original ${doc.agent} conversation can be resumed on the machine it ran on with: ${extra.resumeCommand}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    v: 1,
    title: brain.title || doc.title,
    goal: doc.goal.text,
    state: brain.state,
    decisions: brain.decisions,
    constraints: brain.constraints,
    openQuestions: brain.openQuestions,
    nextSteps: brain.nextSteps,
    risks: brain.risks,
    files: doc.files.map((f) => f.path).slice(0, 60),
    ...(doc.latestReceipt
      ? { latestReceipt: { verdict: doc.latestReceipt.verdict, label: doc.latestReceipt.label } }
      : {}),
    howToResume: resume || "Start from the next steps; check the files listed above first.",
    session: { id: doc.sessionId, agent: doc.agent, dir, ...(extra.branch ? { branch: extra.branch } : {}) },
    createdAt: extra.now ?? Date.now(),
  };
}

const list = (items: readonly string[]) => items.map((s) => `- ${s.replace(/\n+/g, " ")}`).join("\n");
const RECEIPT_WORD: Record<ReceiptVerdict, string> = {
  pass: "passed",
  fail: "failed",
  partial: "partly passed",
  unknown: "filed",
};

/** The packet as markdown — the one form every target carries. Sections with
 *  nothing in them are left out rather than padded with "none". */
export function packetMarkdown(p: HandoffPacket): string {
  const when = new Date(p.createdAt).toISOString().slice(0, 16).replace("T", " ");
  const out: string[] = [
    `# Handoff: ${p.title}`,
    "",
    `From a ${p.session.agent} session (\`${p.session.id}\`) in \`${p.session.dir}\`${p.session.branch ? ` on branch \`${p.session.branch}\`` : ""} · ${when} UTC`,
  ];
  const section = (title: string, body: string) => {
    if (body.trim()) out.push("", `## ${title}`, "", body);
  };
  section("Goal", p.goal);
  section("Where it stands", p.state);
  section(
    "Decisions and why",
    p.decisions
      .map(
        (d) =>
          `- **${d.decision}** — ${d.why}${d.alternativesRejected.length ? ` (rejected: ${d.alternativesRejected.join("; ")})` : ""}`,
      )
      .join("\n"),
  );
  section("Constraints", list(p.constraints));
  section("Open questions", list(p.openQuestions));
  section("Next steps", p.nextSteps.map((s, i) => `${i + 1}. ${s.replace(/\n+/g, " ")}`).join("\n"));
  section("Risks", list(p.risks));
  section("Files changed", p.files.map((f) => `- \`${f}\``).join("\n"));
  section("Latest receipt", p.latestReceipt ? `${RECEIPT_WORD[p.latestReceipt.verdict]}: ${p.latestReceipt.label}` : "");
  section("How to resume", p.howToResume);
  return out.join("\n");
}

/** The brief a fresh agent starts from: the packet, framed as a takeover. */
export function takeoverBrief(markdown: string): string {
  return [
    "You are taking over a coding task that someone else started. Their handoff packet is below.",
    "Before changing anything, check the current state of the checkout (git status, the files listed) against what the packet says — it may be out of date. Then continue with the next steps, and ask if an open question blocks you.",
    "",
    markdown,
  ].join("\n");
}

// ------------------------------------------------------------ the call

export type HandoffResult =
  | { ok: true; packet: HandoffPacket; markdown: string; entry?: LedgerEntry<HandoffPacket> }
  | { ok: false; reason: string; message: string };

/** Generate the packet (main tier — a person asked and is waiting), then file
 *  it in the ledger. A ledger failure does not lose the packet: the person
 *  still has it to copy or send. */
export async function generateHandoff(
  doc: SessionDocument,
  opts: {
    cwd: string;
    narrative?: SessionNarrative | null;
    branch?: string;
    resumeCommand?: string | null;
    signal?: AbortSignal;
    ask?: typeof askBrain;
    append?: typeof appendLedger;
  },
): Promise<HandoffResult> {
  const ask = opts.ask ?? askBrain;
  const answer: BrainAnswer<BrainPacket> = await askInSession<BrainPacket>(ask, {
    feature: "handoff",
    tier: "main",
    json: true,
    cwd: opts.cwd,
    prompt: handoffPrompt(doc, opts.narrative),
    validate: validateBrainPacket,
    signal: opts.signal,
    timeoutMs: 240_000,
  });
  if (!answer.ok || !answer.value) {
    return { ok: false, reason: answer.ok ? "invalid-output" : answer.reason, message: answer.ok ? "" : answer.message };
  }
  const packet = buildPacket(doc, answer.value, { branch: opts.branch, resumeCommand: opts.resumeCommand });
  const markdown = packetMarkdown(packet);
  const append = opts.append ?? appendLedger;
  const entry = await append<HandoffPacket>(opts.cwd || doc.cwd, {
    kind: "handoff",
    author: { kind: "brain", name: "handoff", sessionId: doc.sessionId, cli: doc.agent },
    // Private until the person sends it somewhere: a packet is drafted from
    // their own half-formed prompts.
    scope: "personal",
    subject: packet.title,
    ref: { kind: "session", id: doc.sessionId },
    data: packet,
  }).catch(() => undefined);
  return { ok: true, packet, markdown, entry };
}
