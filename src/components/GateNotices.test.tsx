// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ gatesAllowOnce: vi.fn(async () => {}), ptyWrite: vi.fn(async () => {}) }));
vi.mock("../ipc", () => ({ gatesAllowOnce: m.gatesAllowOnce, ptyWrite: m.ptyWrite }));
vi.mock("../attention", () => ({ postAttention: vi.fn(() => "a"), resolveAttention: vi.fn() }));
vi.mock("../ledger", () => ({ queryLedger: vi.fn(async () => [{}]), appendLedger: vi.fn() }));

import { observeGateEvents, resetGateNoticesForTests } from "../gates/events";
import { GateNotices } from "./GateNotices";
import type { AgentEventData } from "../../shared/notifications";

const event = (status: string, pty: number, kind: "rule" | "irreversible"): AgentEventData => ({
  sessionId: "s",
  cwd: "/repo",
  pty,
  event: "PreToolUse",
  tool: "Edit",
  agent: "",
  gate: {
    id: `${status}-${pty}`,
    status,
    key: "b".repeat(32),
    root: "/repo",
    tool: "Edit",
    action: "write:/repo/migrations/1.sql",
    reason: "",
    findings:
      kind === "rule"
        ? [{ kind: "rule", ruleId: "r1", ruleText: "Never touch migrations/", class: "deny-path-write", label: "changes a protected file (migrations/1.sql)" }]
        : [{ kind: "irreversible", class: "database", label: "deletes database data that can't be brought back" }],
  },
});

beforeEach(() => resetGateNoticesForTests());

describe("GateNotices", () => {
  it("shows a rule block over that agent's terminal only, with Allow once and Edit rule", async () => {
    observeGateEvents([event("blocked", 3, "rule")]);
    const onEditRule = vi.fn();
    const { rerender } = render(<GateNotices ptyId={4} onEditRule={onEditRule} />);
    expect(screen.queryByText(/Canopy blocked/)).toBeNull();
    rerender(<GateNotices ptyId={3} onEditRule={onEditRule} />);
    expect(screen.getByText(/Canopy blocked: this changes a protected file/)).toBeTruthy();
    expect(screen.getByText("/repo/migrations/1.sql")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit rule" }));
    expect(onEditRule).toHaveBeenCalledWith("r1");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(m.gatesAllowOnce).toHaveBeenCalledWith("b".repeat(32)));
    await waitFor(() => expect(screen.queryByText(/Canopy blocked/)).toBeNull());
  });

  it("asks Approve once / Deny for an irreversible action", () => {
    observeGateEvents([event("needs-approval", 5, "irreversible")]);
    render(<GateNotices ptyId={5} />);
    expect(screen.getByText(/Needs your OK: this deletes database data/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
  });
});
