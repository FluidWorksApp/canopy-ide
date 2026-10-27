// The team's rules, kept in the ledger as `rule` entries, and the policy file
// compiled from them.
//
// Three shapes share the `rule` kind, told apart by `data.type`:
//   rule      — what a person wrote, its tag, and its compiled gate (if any)
//   block     — one tool call a gate stopped (written by canopy-hook)
//   trifecta  — the project's choice for sessions that read web content
// One kind rather than three because they are one feature's records, and the
// ledger's kind set is closed on purpose.
//
// Editing a rule appends a successor that `supersedes` the old entry; deleting
// one sets its status to "deleted". Queries see chain heads only, so the list
// here is always the current set.

import * as ipc from "../ipc";
import { appendLedger, queryLedger, setLedgerStatus, type LedgerEntry } from "../ledger";
import { isEnforceable, normalizeGate, type Gate } from "./dsl";

export type RuleTag = "enforced" | "guidance";
export type RuleScope = "project" | "team";

export interface RuleData {
  type: "rule";
  text: string;
  tag: RuleTag;
  /** The compiled gate, once the brain has compiled it. */
  gate: Gate | null;
  /** The brain's one-line reading of the gate, shown beside ours. */
  explanation?: string;
  /** The person approved this exact gate. Only approved gates are enforced. */
  approved: boolean;
  /** Where it came from, when it was lifted out of an instruction file. */
  origin?: string;
}

export interface BlockData {
  type: "block";
  status: string;
  ruleId?: string | null;
  ruleText?: string | null;
  class?: string | null;
  findingKind?: string | null;
  label?: string | null;
  tool: string;
  action: string;
  key: string;
  sessionId: string;
}

export interface TrifectaData {
  type: "trifecta";
  mode: "warn" | "block";
}

export type Rule = LedgerEntry<RuleData>;
export type Block = LedgerEntry<BlockData>;

export interface RuleSet {
  rules: Rule[];
  blocks: Block[];
  trifecta: "warn" | "block";
}

/** A rule is enforced only when it is tagged enforced, compiled to a gate the
 *  workspace can check, and that gate was approved by a person. */
export function isActiveGate(r: Rule): boolean {
  return r.data.tag === "enforced" && r.data.approved && isEnforceable(r.data.gate);
}

/** Why a rule is or is not enforced, as the badge says it. */
export function ruleState(
  r: Rule,
): "enforced" | "needs-approval" | "needs-compile" | "suggestion" | "guidance" {
  if (r.data.tag === "guidance") return "guidance";
  if (!r.data.gate) return "needs-compile";
  if (!isEnforceable(r.data.gate)) return "suggestion";
  return r.data.approved ? "enforced" : "needs-approval";
}

export async function loadRules(cwd: string): Promise<RuleSet> {
  // The three shapes share a kind, so read loosely and tell them apart by type.
  type AnyData = Partial<Omit<RuleData, "type">> & { type?: string; mode?: string };
  const entries = await queryLedger<AnyData>(cwd, {
    kinds: ["rule"],
    limit: 5000,
  });
  const rules: Rule[] = [];
  const blocks: Block[] = [];
  let trifecta: "warn" | "block" | null = null;
  for (const e of entries) {
    const d = e.data ?? {};
    if (d.type === "rule" && e.status !== "deleted" && typeof d.text === "string") {
      // A hand-edited or older entry with a gate this build does not know is
      // shown as needing a fresh compile, never enforced on a guess.
      const gate = d.gate ? normalizeGate(d.gate) : null;
      rules.push({ ...(e as unknown as Rule), data: { ...(d as RuleData), gate } });
    } else if (d.type === "block") {
      blocks.push(e as unknown as Block);
    } else if (d.type === "trifecta" && trifecta === null) {
      // Newest first: the first one seen is the current choice.
      trifecta = d.mode === "block" ? "block" : "warn";
    }
  }
  rules.sort((a, b) => a.ts - b.ts);
  return { rules, blocks, trifecta: trifecta ?? "warn" };
}

/** Save a new rule or a new version of one. A changed text or gate drops the
 *  approval: the person approved a gate, not whatever it later became. */
export async function saveRule(
  cwd: string,
  prev: Rule | null,
  patch: Partial<RuleData> & { scope?: RuleScope },
): Promise<Rule> {
  const base: RuleData = prev?.data ?? {
    type: "rule",
    text: "",
    tag: "enforced",
    gate: null,
    approved: false,
  };
  const { scope: nextScope, ...fields } = patch;
  const data: RuleData = { ...base, ...fields, type: "rule" };
  const changed =
    prev &&
    (data.text !== prev.data.text ||
      JSON.stringify(data.gate) !== JSON.stringify(prev.data.gate));
  if (changed && patch.approved === undefined) data.approved = false;
  const scope = nextScope ?? (prev?.scope === "team" ? "team" : "project");
  return appendLedger<RuleData>(cwd, {
    kind: "rule",
    author: { kind: "human", name: "you" },
    scope,
    subject: data.text.slice(0, 200),
    data,
    status: "active",
    ...(prev ? { supersedes: prev.id } : {}),
  });
}

export const deleteRule = (cwd: string, rule: Rule) =>
  setLedgerStatus(cwd, rule.id, "deleted");

export const setTrifecta = (cwd: string, mode: "warn" | "block") =>
  appendLedger<TrifectaData>(cwd, {
    kind: "rule",
    author: { kind: "human", name: "you" },
    scope: "project",
    subject: `Untrusted content: ${mode}`,
    data: { type: "trifecta", mode },
  });

/** What the hook reads: approved enforceable gates, and every other rule as a
 *  line of guidance. A rule waiting for approval is still the team's rule, so
 *  it is told to agents meanwhile — just not enforced. */
export function buildPolicy(set: Pick<RuleSet, "rules" | "trifecta">): ipc.GatePolicyWire {
  const gates: ipc.GatePolicyWire["gates"] = [];
  const guidance: string[] = [];
  for (const r of set.rules) {
    if (isActiveGate(r)) {
      gates.push({ id: r.id, rule: r.data.text, scope: r.scope === "team" ? "team" : "project", gate: r.data.gate });
    } else if (r.data.text.trim()) {
      guidance.push(r.data.text.trim());
    }
  }
  return { trifecta: set.trifecta, gates, guidance };
}

/** Write the policy where this project's hook reads it. On a Linux workspace
 *  the host routes this into the VM, where that hook runs. */
export async function publishPolicy(cwd: string, set: Pick<RuleSet, "rules" | "trifecta">): Promise<void> {
  await ipc.gatesPolicyWrite(cwd, buildPolicy(set));
}

const STOPPED = new Set(["blocked", "needs-approval", "refused"]);

/** Times each rule stopped something. Keyed by rule id, falling back to the
 *  rule's words: an edit gives the rule a new id, and its history should not
 *  vanish with the old one. */
export function blockCounts(set: Pick<RuleSet, "rules" | "blocks">): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of set.rules) {
    const n = set.blocks.filter(
      (b) =>
        STOPPED.has(b.data.status) &&
        (b.data.ruleId === r.id || (!!b.data.ruleText && b.data.ruleText === r.data.text)),
    ).length;
    counts.set(r.id, n);
  }
  return counts;
}

/** Built-in stops (irreversible actions, the untrusted-content rule) that
 *  belong to no written rule. */
export function builtInStops(blocks: Block[]): number {
  return blocks.filter((b) => STOPPED.has(b.data.status) && !b.data.ruleId).length;
}
