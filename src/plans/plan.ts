// A plan: the unit of work, before it is code.
//
// When work is dispatched to an agent through Canopy, the brain first reads the
// request against the repo and writes a one-screen plan — the goal, the
// consequential decisions the agent would otherwise guess, what it expects to
// touch, how we will know it worked, and what it will not do. The person
// answers the decisions and approves; the agent starts with the plan folded
// into its brief.
//
// Plans scale with blast radius. A tiny, low-risk change gets its plan shown
// inline and the agent starts at once; anything medium or high risk, large, or
// touching auth, data, money or shared plumbing waits for a yes. That is the
// countermeasure to spec-mode overkill: the plan is only friction where a wrong
// guess is expensive.
//
// This file is pure: the prompt, the validator, the gate and the brief. The
// ledger round trip lives in planStore.ts, the orchestration in planGate.ts.

import { hotspotReason } from "./hotspots";

export type PlanRisk = "low" | "medium" | "high";
export type PlanSize = "tiny" | "small" | "large";
/** The autonomy ledger's buckets (#4): the brain files every plan under one. */
export const TASK_CLASSES = [
  "dependency-bump",
  "copy-change",
  "test-addition",
  "bugfix",
  "feature",
  "refactor",
  "infra",
] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

export interface PlanDecision {
  question: string;
  options: string[];
  recommended: string;
  why: string;
  /** What was settled: an option, the person's own words, or (inline plans)
   *  the recommendation taken as-is. Absent = still open. */
  answer?: string;
  /** "plan" — asked up front; "mid-run" — the agent hit it while working and
   *  asked through canopy_ask_user. */
  source?: "plan" | "mid-run";
}

/** What the brain returns. */
export interface PlanDraft {
  goal: string;
  decisions: PlanDecision[];
  touches: string[];
  acceptance: string[];
  wontDo: string[];
  risk: PlanRisk;
  size: PlanSize;
  taskClass: TaskClass;
}

export type PlanStatus = "proposed" | "approved" | "in-progress" | "done" | "dropped";
export type PlanSource = "task" | "ticket" | "agent" | "build";
/** one-shot: a task that ends with its run. interactive: a session the person
 *  keeps talking to — done when they mark the ticket done, the session ends,
 *  or a receipt proves every acceptance check. */
export type PlanRunMode = "one-shot" | "interactive";

/** How to launch a waiting plan after a restart: the surface's launch kind
 *  and what it needs, as JSON. `request` holds the whole request when the
 *  record's copy was clipped. */
export interface PlanLaunchSpec {
  kind: string;
  payload: Record<string, unknown>;
  request?: string;
}

/** The `data` of a `plan` ledger entry. `acceptance` is the field the proof
 *  receipts feature checks a run against — keep the name. */
export interface PlanData extends PlanDraft {
  /** Stable across status changes (ledger ids change on every successor). */
  planId: string;
  /** The person's request, as dispatched (clipped). */
  request: string;
  label?: string;
  /** Where the agent runs. */
  dir: string;
  source: PlanSource;
  gate: "inline" | "approval";
  /** Plain-language reasons the gate asked for approval. */
  gateWhy: string[];
  approvedBy?: string;
  approvedAt?: number;
  /** Linked when the agent's first turn is observed. */
  sessionId?: string;
  ptyId?: number | null;
  startedAt?: number;
  endedAt?: number;
  /** HEAD when the agent started, so its commits can be told apart later. */
  baseHead?: string;
  /** Commits the run made — the autonomy ledger's revert check reads these. */
  commits?: { sha: string; subject: string }[];
  sharedAt?: number;
  /** Team-chat user ids the author named when sharing: only they can approve
   *  the plan from chat. Everyone else in the conversation can comment. */
  approvers?: string[];
  mode?: PlanRunMode;
  /** The ticket this plan is for (ticket dispatches). */
  ticketId?: string;
  /** Set on a plan that waits for approval, so a restart can still launch it. */
  launch?: PlanLaunchSpec;
  /** When the approved plan's agent was launched — a restart never launches
   *  the same approval twice. */
  launchedAt?: number;
  /** Why the plan was marked done, in plain words. */
  doneBecause?: string;
}

// ------------------------------------------------------------------ prompt

export interface PlanContext {
  /** Top-level entries, directories with a trailing slash. */
  tree: string[];
  /** Files that mention the request's keywords. */
  relevant: string[];
  /** Recent project memory, one line each. */
  memory: string[];
}

const REQUEST_MAX = 6000;
/** microTasks.oneLine, restated so this pure module stays light to import. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function buildPlanPrompt(request: string, ctx: PlanContext): string {
  const lines = [
    "You are planning a coding task before an agent starts it. Do not do the task.",
    "Write a SHORT, one-screen plan that a busy teammate (possibly a non-engineer) can approve in under a minute.",
    "",
    "Hunt for gaps: list only the CONSEQUENTIAL decisions the agent would otherwise have to guess",
    "(e.g. pagination vs infinite scroll, which table owns a field, whether to keep backward compatibility).",
    "Skip trivia. Zero decisions is fine for a clear request. At most 4.",
    "",
    "Return ONE JSON object, nothing else:",
    "{",
    '  "goal": "one sentence: what done looks like, in plain language",',
    '  "decisions": [{"question": "...", "options": ["...", "..."], "recommended": "one of the options", "why": "one short sentence"}],',
    '  "touches": ["paths or areas you expect to change"],',
    '  "acceptance": ["concrete checks that prove it worked: a command to run, or an observable behaviour"],',
    '  "wontDo": ["things deliberately out of scope"],',
    '  "risk": "low" | "medium" | "high",',
    '  "size": "tiny" | "small" | "large",',
    `  "taskClass": ${TASK_CLASSES.map((c) => `"${c}"`).join(" | ")}`,
    "}",
    "",
    "risk: high if it touches auth, data/migrations, money, or anything shared by the team; medium if it changes behaviour users see; low otherwise.",
    "size: tiny = a few lines in one place; small = one feature area; large = many files or areas.",
    "acceptance: 1 to 6 items. Prefer the repo's own test/typecheck commands when you can see them.",
    "",
    "REQUEST:",
    clip(request.trim(), REQUEST_MAX),
  ];
  if (ctx.tree.length) lines.push("", "REPO TOP LEVEL:", ctx.tree.slice(0, 80).join("  "));
  if (ctx.relevant.length)
    lines.push("", "FILES THAT MENTION THE REQUEST'S KEYWORDS:", ...ctx.relevant.slice(0, 40).map((p) => `- ${p}`));
  if (ctx.memory.length)
    lines.push("", "WHAT THE TEAM HAS LEARNED ABOUT THIS REPO (recent memory):", ...ctx.memory.slice(0, 10).map((m) => `- ${m}`));
  return lines.join("\n");
}

// -------------------------------------------------------------- validation

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? clip(v.replace(/\s+/g, " ").trim(), max) : "";
const strList = (v: unknown, max: number, each: number): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => str(x, each))
        .filter(Boolean)
        .slice(0, max)
    : [];

/** The brain's reply as a PlanDraft, or null. Lenient about shape (missing
 *  lists become empty, an unknown risk is treated as medium so the gate errs
 *  towards asking), strict about the one thing a plan cannot lack: a goal. */
export function validatePlan(v: unknown): PlanDraft | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const goal = str(o.goal, 400);
  if (!goal) return null;
  const decisions: PlanDecision[] = Array.isArray(o.decisions)
    ? o.decisions
        .map((d): PlanDecision | null => {
          if (!d || typeof d !== "object") return null;
          const r = d as Record<string, unknown>;
          const question = str(r.question, 300);
          if (!question) return null;
          const options = strList(r.options, 5, 160);
          let recommended = str(r.recommended, 160);
          if (!recommended && options.length) recommended = options[0];
          return { question, options, recommended, why: str(r.why, 300), source: "plan" };
        })
        .filter((d): d is PlanDecision => d !== null)
        .slice(0, 6)
    : [];
  const risk: PlanRisk = o.risk === "low" || o.risk === "high" ? o.risk : "medium";
  const size: PlanSize = o.size === "tiny" || o.size === "large" ? o.size : "small";
  const taskClass: TaskClass = (TASK_CLASSES as readonly string[]).includes(o.taskClass as string)
    ? (o.taskClass as TaskClass)
    : "feature";
  return {
    goal,
    decisions,
    touches: strList(o.touches, 20, 200),
    acceptance: strList(o.acceptance, 8, 300),
    wontDo: strList(o.wontDo, 8, 200),
    risk,
    size,
    taskClass,
  };
}

// -------------------------------------------------------------------- gate

/** Does this plan wait for a person, and why? Inline only when it is low risk,
 *  not large, and touches nothing the team shares. */
export function planGate(plan: Pick<PlanDraft, "risk" | "size" | "touches">): {
  gate: "inline" | "approval";
  why: string[];
} {
  const why: string[] = [];
  if (plan.risk !== "low") why.push(`${plan.risk} risk`);
  if (plan.size === "large") why.push("large change");
  const spots = [...new Set(plan.touches.map(hotspotReason).filter((r): r is string => !!r))];
  for (const s of spots) why.push(`touches ${s}`);
  return { gate: why.length ? "approval" : "inline", why };
}

/** Inline plans start with every open decision settled by its
 *  recommendation; the person can still read and change course mid-run. */
export function settleWithRecommendations(decisions: PlanDecision[]): PlanDecision[] {
  return decisions.map((d) => (d.answer ? d : { ...d, answer: d.recommended || undefined }));
}

// ------------------------------------------------------------------- brief

/** The plan folded into the agent's opening brief. One line: PTY-typed
 *  prompts must not carry newlines (see microTasks.oneLine). */
export function planBrief(plan: PlanData): string {
  const parts: string[] = [
    `[Canopy plan ${plan.planId}${plan.gate === "approval" ? ", approved by the user" : ""}]`,
    `Goal: ${plan.goal}`,
  ];
  const settled = plan.decisions.filter((d) => d.answer);
  if (settled.length)
    parts.push(`Decisions already made (follow them): ${settled.map((d) => `${d.question} → ${d.answer}`).join("; ")}.`);
  if (plan.acceptance.length)
    parts.push(
      `Acceptance checks (run or verify each, and report the result of every one): ${plan.acceptance
        .map((a, i) => `(${i + 1}) ${a}`)
        .join(" ")}`,
    );
  if (plan.wontDo.length) parts.push(`Out of scope, do not do: ${plan.wontDo.join("; ")}.`);
  if (plan.touches.length) parts.push(`Expected to touch: ${plan.touches.join(", ")}.`);
  parts.push(
    "If you hit a consequential choice this plan does not settle, call canopy_ask_user with the question and the options instead of guessing.",
    `Task: ${plan.request}`,
  );
  return oneLine(parts.join(" "));
}

export function newPlanId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `pl-${Date.now().toString(36)}-${rand}`;
}

/** A plan id as it may appear on the wire or in a brief. */
export const PLAN_ID = /^pl-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/;
const PLAN_MARK = /\[Canopy plan (pl-[a-z0-9]{1,16}-[a-z0-9]{1,16})/;
/** The plan a turn's prompt was seeded with, when the brief reached it. */
export function planIdInPrompt(prompt: string | undefined): string | null {
  return (prompt && PLAN_MARK.exec(prompt)?.[1]) || null;
}

/** A plan's status in plain words. */
export function statusLabel(status: string): string {
  switch (status) {
    case "proposed":
      return "Waiting for approval";
    case "approved":
      return "Approved";
    case "in-progress":
      return "In progress";
    case "done":
      return "Done";
    case "dropped":
      return "Not started";
    default:
      return status;
  }
}
