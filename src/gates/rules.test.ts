import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../ledger";

const appended: unknown[] = [];
let stored: LedgerEntry[] = [];
vi.mock("../ledger", () => ({
  appendLedger: vi.fn(async (_root: string, draft: Record<string, unknown>) => {
    appended.push(draft);
    return { id: `id-${appended.length}`, ts: appended.length, root: "/repo", ...draft };
  }),
  queryLedger: vi.fn(async () => stored),
  setLedgerStatus: vi.fn(async () => ({})),
}));
const gatesPolicyWrite = vi.fn(async () => "/home/.canopy/policy/x.json");
vi.mock("../ipc", () => ({ gatesPolicyWrite: (...a: unknown[]) => gatesPolicyWrite(...(a as [])) }));

import { blockCounts, buildPolicy, loadRules, publishPolicy, ruleState, saveRule, type Rule } from "./rules";

const rule = (id: string, data: Partial<Rule["data"]>, scope: "project" | "team" = "project"): Rule => ({
  id,
  kind: "rule",
  ts: 1,
  root: "/repo",
  author: { kind: "human", name: "you" },
  scope,
  data: { type: "rule", text: id, tag: "enforced", gate: null, approved: false, ...data },
});

beforeEach(() => {
  appended.length = 0;
  stored = [];
  gatesPolicyWrite.mockClear();
});

describe("rules in the ledger", () => {
  it("only approved, enforceable, enforced rules become gates; the rest is guidance", () => {
    const rules = [
      rule("Never touch migrations/", { gate: { type: "deny-path-write", globs: ["migrations/"] }, approved: true }, "team"),
      rule("Pending", { gate: { type: "deny-command", patterns: ["^x"] }, approved: false }),
      rule("Be kind", { gate: { type: "unenforceable", reason: "judgment" }, approved: true }),
      rule("Small PRs", { tag: "guidance" }),
    ];
    expect(rules.map(ruleState)).toEqual(["enforced", "needs-approval", "suggestion", "guidance"]);
    const p = buildPolicy({ rules, trifecta: "block" });
    expect(p.gates).toEqual([
      { id: "Never touch migrations/", rule: "Never touch migrations/", scope: "team", gate: { type: "deny-path-write", globs: ["migrations/"] } },
    ]);
    expect(p.guidance).toEqual(["Pending", "Be kind", "Small PRs"]);
    expect(p.trifecta).toBe("block");
  });

  it("drops the approval when the rule or its gate changes", async () => {
    const prev = rule("r1", { text: "Never touch migrations/", gate: { type: "deny-path-write", globs: ["migrations/"] }, approved: true });
    await saveRule("/repo", prev, { gate: { type: "deny-path-write", globs: ["db/"] } });
    expect(appended[0]).toMatchObject({ kind: "rule", supersedes: "r1", data: { approved: false } });
    await saveRule("/repo", prev, { scope: "team" });
    expect(appended[1]).toMatchObject({ scope: "team", data: { approved: true } });
  });

  it("loads rules, blocks and the trifecta choice; ignores unknown gates and deleted rules", async () => {
    stored = [
      { ...rule("t", {}), data: { type: "trifecta", mode: "block" } } as unknown as LedgerEntry,
      { ...rule("b", {}), data: { type: "block", status: "blocked", ruleId: "r", tool: "Edit", action: "write:x", key: "k", sessionId: "s" } } as unknown as LedgerEntry,
      rule("r", { gate: { type: "exec" } as never, approved: true }) as LedgerEntry,
      { ...rule("gone", {}), status: "deleted" } as LedgerEntry,
    ];
    const set = await loadRules("/repo");
    expect(set.trifecta).toBe("block");
    expect(set.rules.map((r) => r.id)).toEqual(["r"]);
    expect(set.rules[0].data.gate).toBeNull();
    expect(ruleState(set.rules[0])).toBe("needs-compile");
    expect(blockCounts(set).get("r")).toBe(1);
    await publishPolicy("/repo", set);
    expect(gatesPolicyWrite).toHaveBeenCalledWith("/repo", { trifecta: "block", gates: [], guidance: ["r"] });
  });
});
