// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory ledger with the real one's fold: appends that supersede hide
// their predecessor, and status updates append a successor.
const store = vi.hoisted(() => {
  let entries: Record<string, unknown>[] = [];
  let seq = 0;
  const heads = () => {
    const gone = new Set(entries.map((e) => e.supersedes).filter(Boolean));
    return entries.filter((e) => !gone.has(e.id)).slice().reverse();
  };
  return {
    reset: (seed: Record<string, unknown>[] = []) => {
      entries = seed.map((e) => ({ ts: ++seq, root: "/repo", author: { kind: "human", name: "you" }, scope: "project", kind: "rule", ...e }));
    },
    append: async (_root: string, d: Record<string, unknown>) => {
      const e = { id: `n${++seq}`, ts: seq, root: "/repo", ...d };
      entries.push(e);
      return e;
    },
    query: async () => heads(),
    status: async (_root: string, id: string, status: string) => {
      const prev = entries.find((e) => e.id === id)!;
      return store.append("/repo", { ...prev, id: undefined, supersedes: id, status });
    },
  };
});
vi.mock("../ledger", () => ({
  appendLedger: store.append,
  queryLedger: store.query,
  setLedgerStatus: store.status,
  subscribeLedger: () => () => {},
}));
const brain = vi.hoisted(() => ({ askBrain: vi.fn() }));
vi.mock("../brainCall", () => ({ askBrain: (r: unknown) => brain.askBrain(r) }));
const ipcMock = vi.hoisted(() => ({
  gatesPolicyWrite: vi.fn(async () => "/p.json"),
  instructionsRead: vi.fn(async () => "# Rules\n- Never run npm publish\n- Be nice\n"),
  instructionsWrite: vi.fn(async () => {}),
}));
vi.mock("../ipc", () => ipcMock);

import { RulesPanel } from "./RulesPanel";

const migrations = {
  id: "r1",
  data: { type: "rule", text: "Never touch migrations/", tag: "enforced", gate: { type: "deny-path-write", globs: ["migrations/"] }, approved: true },
};
const naming = {
  id: "r2",
  data: { type: "rule", text: "Use clear names", tag: "enforced", gate: { type: "unenforceable", reason: "naming needs judgment" }, approved: false },
};
const block = {
  id: "b1",
  data: { type: "block", status: "blocked", ruleId: "r1", ruleText: "Never touch migrations/", tool: "Edit", action: "write:x", key: "k", sessionId: "s" },
};

beforeEach(() => {
  brain.askBrain.mockReset();
  Object.values(ipcMock).forEach((f) => f.mockClear());
});

const renderPanel = () =>
  render(
    <RulesPanel
      roots={["/repo"]}
      files={[
        { path: "/repo/CLAUDE.md", kind: "instructions", scope: "project", agents: [], label: "CLAUDE.md", root: "/repo", exists: true, bytes: 1, modified: null, title: null, description: null },
      ]}
      onNotice={vi.fn()}
    />,
  );

describe("RulesPanel", () => {
  it("shows each compiled rule in plain language with its enforced or suggestion-only label and block count", async () => {
    store.reset([migrations, naming, block]);
    renderPanel();
    const rule = (await screen.findByText("Never touch migrations/")).closest("li")!;
    expect(within(rule).getByText("Enforced")).toBeTruthy();
    expect(within(rule).getByText("Agents can't create, change or delete files matching migrations/.")).toBeTruthy();
    expect(within(rule).getByText("Blocked 1×")).toBeTruthy();
    const soft = screen.getByText("Use clear names").closest("li")!;
    expect(within(soft).getByText("Suggestion only")).toBeTruthy();
    expect(within(soft).getByText(/Suggestion only — naming needs judgment/)).toBeTruthy();
    // The hook's file holds the enforced gate; the suggestion travels as guidance.
    await waitFor(() =>
      expect(ipcMock.gatesPolicyWrite).toHaveBeenCalledWith("/repo", {
        trifecta: "warn",
        gates: [{ id: "r1", rule: "Never touch migrations/", scope: "project", gate: { type: "deny-path-write", globs: ["migrations/"] } }],
        guidance: ["Use clear names"],
      }),
    );
  });

  it("compiles a new rule with the brain, shows the gate for approval, and enforces it once approved", async () => {
    store.reset([]);
    brain.askBrain.mockImplementation(async (req: { feature: string; tier: string; validate: (v: unknown) => unknown }) => ({
      ok: true,
      text: "",
      value: req.validate({ gate: { type: "package-denylist", names: ["moment"] }, explanation: "Blocks installing moment." }),
    }));
    renderPanel();
    fireEvent.change(await screen.findByLabelText("New rule"), { target: { value: "Don't install moment" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and compile" }));
    const row = (await screen.findByText("Agents can't install moment.")).closest("li")!;
    expect(brain.askBrain.mock.calls[0][0]).toMatchObject({ feature: "gates", tier: "main", json: true });
    expect(within(row).getByText("Needs your approval")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Approve gate" }));
    await waitFor(() => expect(within(screen.getByText("Don't install moment").closest("li")!).getByText("Enforced")).toBeTruthy());
    await waitFor(() =>
      expect(ipcMock.gatesPolicyWrite).toHaveBeenLastCalledWith(
        "/repo",
        expect.objectContaining({ gates: [expect.objectContaining({ rule: "Don't install moment", gate: { type: "package-denylist", names: ["moment"] } })] }),
      ),
    );
  });

  it("says plainly when there is no brain to compile with", async () => {
    store.reset([]);
    brain.askBrain.mockResolvedValue({ ok: false, reason: "no-brain", message: "" });
    renderPanel();
    fireEvent.change(await screen.findByLabelText("New rule"), { target: { value: "Never touch migrations/" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and compile" }));
    expect(await screen.findByText(/No brain connected/)).toBeTruthy();
    expect(within(screen.getByText("Never touch migrations/").closest("li")!).getByText("Not compiled")).toBeTruthy();
  });

  it("suggests gates from an instruction file and lifts the accepted line out of it", async () => {
    store.reset([]);
    brain.askBrain.mockImplementation(async (req: { validate: (v: unknown) => unknown }) => ({
      ok: true,
      text: "",
      value: req.validate({
        suggestions: [{ line: "- Never run npm publish", rule: "No publishing to npm", why: "Instructions get skipped.", gate: { type: "deny-command", patterns: ["^npm\\s+publish\\b"] } }],
      }),
    }));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Suggest which lines should become enforced gates" }));
    expect(await screen.findByText("No publishing to npm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add as rule" }));
    await waitFor(() => expect(ipcMock.instructionsWrite).toHaveBeenCalledWith("/repo/CLAUDE.md", ["/repo"], "# Rules\n- Be nice\n"));
    const added = (await screen.findAllByText("No publishing to npm")).map((n) => n.closest("li")!).find((li) => li.classList.contains("gates-rule"))!;
    expect(within(added).getByText("Needs your approval")).toBeTruthy();
    expect(within(added).getByText("From CLAUDE.md")).toBeTruthy();
  });
});
