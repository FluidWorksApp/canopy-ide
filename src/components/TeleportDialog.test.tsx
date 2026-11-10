import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeleportDialog } from "./TeleportDialog";
import { chosen, defaultSelection, ignoredItem, stepState, toggled, type TeleportItem } from "../teleport/selection";

const items: TeleportItem[] = [
  { id: "changes", kind: "changes", label: "3 changed files", detail: "+8 −1" },
  { id: "commits", kind: "commits", label: "2 unpushed commits" },
  ignoredItem(".env.local"),
  ignoredItem(".env.production"),
  { id: "conversation", kind: "conversation", label: "The conversation", required: true },
];

describe("selection", () => {
  it("ticks everything except secrets", () => {
    const sel = defaultSelection(items);
    expect(sel.has("changes")).toBe(true);
    expect(sel.has("ignored:.env.local")).toBe(false);
    expect(sel.has("ignored:.env.production")).toBe(false);
    expect(ignoredItem("config/dev.json").secret).toBe(false);
  });
  it("a required row cannot be turned off and is always sent", () => {
    const sel = defaultSelection(items);
    expect(toggled(items, sel, "conversation").has("conversation")).toBe(sel.has("conversation"));
    expect(chosen(items, new Set())).toEqual(["conversation"]);
    expect(toggled(items, sel, "changes").has("changes")).toBe(false);
  });
});

describe("stepState", () => {
  it("is done before the step, now at it, waiting after, failed when it failed", () => {
    const p = { step: "send" as const };
    expect(["prepare", "send", "apply", "resume"].map((s) => stepState(s as never, p))).toEqual(["done", "now", "wait", "wait"]);
    expect(stepState("send", { step: "send", failed: "x" })).toBe("failed");
    expect(stepState("send", null)).toBe("wait");
  });
});

describe("TeleportDialog", () => {
  const base = {
    destinationName: "Coraa Workstation",
    agentLabel: "claude · agent/x",
    items,
    selected: defaultSelection(items),
    onSelectedChange: () => {},
    reasons: [],
    progress: null,
    onTeleport: () => {},
    onCancel: () => {},
  };

  it("shows the checklist with the secret unticked and starts the move", () => {
    const go = vi.fn();
    render(<TeleportDialog {...base} onTeleport={go} />);
    expect((screen.getByLabelText(/3 changed files/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/\.env\.production/) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Teleport" }));
    expect(go).toHaveBeenCalled();
  });

  it("reports a toggle through onSelectedChange", () => {
    const change = vi.fn();
    render(<TeleportDialog {...base} onSelectedChange={change} />);
    fireEvent.click(screen.getByLabelText(/3 changed files/));
    expect((change.mock.calls[0][0] as Set<string>).has("changes")).toBe(false);
  });

  it("with reasons the move cannot start, and they are shown", () => {
    render(<TeleportDialog {...base} reasons={["The agent is mid-turn."]} />);
    expect(screen.getByRole("alert").textContent).toContain("mid-turn");
    expect((screen.getByRole("button", { name: "Teleport" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the current step and its percentage, and offers a retry after a failure", () => {
    const { rerender } = render(<TeleportDialog {...base} progress={{ step: "send", fraction: 0.62 }} />);
    expect(screen.getByText(/Send 62%/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel move" })).toBeTruthy();
    rerender(<TeleportDialog {...base} progress={{ step: "apply", failed: "disk full" }} />);
    expect(screen.getByText("disk full")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
