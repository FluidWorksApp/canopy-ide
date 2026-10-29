// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  gatesAllowOnce: vi.fn(async (..._a: unknown[]) => {}),
  ptyWrite: vi.fn(async (..._a: unknown[]) => {}),
  postAttention: vi.fn((..._a: unknown[]) => "att-1"),
  resolveAttention: vi.fn(),
  queryLedger: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  appendLedger: vi.fn(async (..._a: unknown[]) => ({})),
}));
vi.mock("../ipc", () => ({ gatesAllowOnce: m.gatesAllowOnce, ptyWrite: m.ptyWrite }));
vi.mock("../attention", () => ({ postAttention: m.postAttention, resolveAttention: m.resolveAttention }));
vi.mock("../ledger", () => ({ queryLedger: m.queryLedger, appendLedger: m.appendLedger }));

import { parseAgentEvent } from "../../shared/notifications";
import { allowOnce, denyNotice, gateNotices, noticeTitle, observeGateEvents, resetGateNoticesForTests } from "./events";
import { visibleNotices } from "./useGateNotices";

const raw = (status: string, findings: unknown[], id = "e1") =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd: "/repo",
    tool_name: "Bash",
    canopy_pty: 7,
    canopy_gate: { id, status, key: "a".repeat(32), root: "/repo", tool: "Bash", action: "terraform destroy", findings, reason: "…" },
  });

const IRREVERSIBLE = [{ kind: "irreversible", class: "infra-destroy", label: "tears down live infrastructure" }];
const RULE = [{ kind: "rule", ruleId: "r1", ruleText: "Never touch migrations/", class: "deny-path-write", label: "changes a protected file (migrations/1.sql)" }];

beforeEach(() => {
  resetGateNoticesForTests();
  Object.values(m).forEach((f) => f.mockClear());
  vi.useFakeTimers();
});

describe("gate events", () => {
  it("parses the hook's stamp off the bus event", () => {
    const e = parseAgentEvent(raw("blocked", RULE))!;
    expect(e.gate).toMatchObject({ id: "e1", status: "blocked", key: "a".repeat(32), action: "terraform destroy" });
    expect(parseAgentEvent(JSON.stringify({ hook_event_name: "PreToolUse", canopy_gate: { status: 1 } }))!.gate).toBeUndefined();
  });

  it("asks the person about an irreversible action and approve-once mints the token and tells the agent", async () => {
    observeGateEvents([parseAgentEvent(raw("needs-approval", IRREVERSIBLE))]);
    // The same event twice (a re-delivered batch) is one notice.
    observeGateEvents([parseAgentEvent(raw("needs-approval", IRREVERSIBLE))]);
    expect(gateNotices()).toHaveLength(1);
    expect(m.postAttention).toHaveBeenCalledTimes(1);
    expect(m.postAttention.mock.calls[0][0]).toMatchObject({
      kind: "question",
      where: { kind: "terminal", ptyId: 7 },
      title: "Needs your OK: this tears down live infrastructure, which can't be undone",
    });
    await allowOnce(gateNotices()[0]);
    expect(m.gatesAllowOnce).toHaveBeenCalledWith("a".repeat(32));
    expect(m.resolveAttention).toHaveBeenCalledWith("att-1", "answered");
    expect(m.ptyWrite.mock.calls[0]).toEqual([7, expect.stringContaining("approved this once")]);
    vi.advanceTimersByTime(400);
    expect(m.ptyWrite).toHaveBeenLastCalledWith(7, "\r");
    expect(gateNotices()[0].resolved).toBe("approved");
  });

  it("keeps warnings off the terminal; blocks still show", () => {
    const TRIFECTA = [{ kind: "trifecta", class: "outbound-write", label: "sends data out of this computer after this session read untrusted content (WebSearch)" }];
    observeGateEvents([parseAgentEvent(raw("warned", TRIFECTA, "w1")), parseAgentEvent(raw("blocked", RULE, "b1"))]);
    expect(gateNotices()).toHaveLength(2);
    expect(visibleNotices(gateNotices(), 7).map((n) => n.id)).toEqual(["b1"]);
    expect(m.postAttention).not.toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("Heads up") }));
  });

  it("records a block in this window's ledger only when the hook's write didn't land here", async () => {
    vi.useRealTimers();
    observeGateEvents([parseAgentEvent(raw("blocked", RULE, "e2"))]);
    await vi.waitFor(() => expect(m.appendLedger).toHaveBeenCalledTimes(1));
    expect(m.appendLedger.mock.calls[0][1]).toMatchObject({
      kind: "rule",
      ref: { kind: "gate-event", id: "e2" },
      status: "blocked",
      data: { type: "block", ruleId: "r1", ruleText: "Never touch migrations/" },
    });
    m.queryLedger.mockResolvedValueOnce([{ id: "x" }]);
    observeGateEvents([parseAgentEvent(raw("blocked", RULE, "e3"))]);
    await vi.waitFor(() => expect(m.queryLedger).toHaveBeenCalledTimes(2));
    expect(m.appendLedger).toHaveBeenCalledTimes(1);
  });

  it("titles a rule block with the rule's own words, and deny tells the agent to stand down", () => {
    observeGateEvents([parseAgentEvent(raw("blocked", RULE, "e4"))]);
    expect(noticeTitle(gateNotices()[0].stamp)).toBe(
      "Canopy blocked: this changes a protected file (migrations/1.sql) — team rule 'Never touch migrations/'",
    );
    observeGateEvents([parseAgentEvent(raw("needs-approval", IRREVERSIBLE, "e5"))]);
    denyNotice(gateNotices()[0]);
    expect(m.ptyWrite.mock.calls[0][1]).toMatch(/declined/);
  });
});
