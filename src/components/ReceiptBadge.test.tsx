// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(async () => {}),
  ptyWrite: vi.fn(async () => {}),
  ledgerQuery: vi.fn(async () => []),
  ledgerRoot: vi.fn(async (p: string) => p),
  onLedgerAppended: vi.fn(async () => () => {}),
  receiptRunCheck: vi.fn(),
}));
vi.mock("../ipc", () => ipcMock);

import { ReceiptBadge } from "./ReceiptBadge";
import { resetReceiptsForTests, setReceipt, setVerifying } from "../receipts/store";
import { sampleReceipt } from "../receipts/fixtures";
import { updateSettings } from "../settings";

beforeEach(() => {
  resetReceiptsForTests();
  updateSettings({ receiptMode: "auto", receiptCommands: {} });
  vi.clearAllMocks();
});

describe("ReceiptBadge", () => {
  it("reads Unverified, then Verifying, then the workspace's status", () => {
    render(<ReceiptBadge sessionId="s1" ptyId={7} cwd="/repo" />);
    expect(screen.getByRole("button", { name: "Receipt: Unverified" })).toBeTruthy();
    act(() => setVerifying("s1", 7));
    expect(screen.getByRole("button", { name: "Receipt: Verifying" })).toBeTruthy();
    act(() => setReceipt(sampleReceipt({ status: "proven", verdict: null, tamper: [], packages: [] })));
    expect(screen.getByRole("button", { name: "Receipt: Proven" }).textContent).toContain("✓");
  });

  it("finds a receipt by terminal when the surface has no session id", () => {
    setReceipt(sampleReceipt({ status: "tests-changed" }));
    render(<ReceiptBadge ptyId={7} />);
    expect(screen.getByRole("button", { name: "Receipt: Tests changed" }).textContent).toContain("⚠");
  });

  it("stays out of the way when receipts are off, or quiet and unverified", () => {
    const { container, rerender } = render(<ReceiptBadge sessionId="s1" quietWhenUnverified />);
    expect(container.textContent).toBe("");
    act(() => {
      updateSettings({ receiptMode: "off" });
    });
    setReceipt(sampleReceipt());
    rerender(<ReceiptBadge sessionId="s1" />);
    expect(container.textContent).toBe("");
  });

  it("opens the receipt: the brain's asked vs did beside the raw evidence, the claim kept apart", async () => {
    const user = userEvent.setup();
    setReceipt(sampleReceipt());
    render(<ReceiptBadge sessionId="s1" ptyId={7} cwd="/repo" />);
    await user.click(screen.getByRole("button", { name: "Receipt: Contradicted" }));
    const dialog = await screen.findByRole("dialog");
    const panel = within(dialog);
    // The brain's judgment, visibly.
    expect(panel.getByText("Make sum add its two numbers.")).toBeTruthy();
    expect(panel.getByText("Changed subtraction to addition, but one test still fails.")).toBeTruthy();
    expect(panel.getByText("The failing test was the one the agent edited.")).toBeTruthy();
    // The agent's claim is labelled as such, separate from what was verified.
    expect(panel.getByText("Agent says")).toBeTruthy();
    expect(panel.getByText("Fixed it — all tests pass.")).toBeTruthy();
    expect(panel.getByText("Workspace verified")).toBeTruthy();
    // Raw evidence, expandable.
    expect(panel.getByText(/`npm run test` failed — 11 passed, 1 failed/)).toBeTruthy();
    expect(panel.getByLabelText("Raw output of npm run test").textContent).toContain("1 failed | 11 passed (12)");
    // Tamper and package flags.
    expect(panel.getByText(/Test changed by the agent — needs a human look/)).toBeTruthy();
    expect(panel.getByText(/unknown package: not on the registry/)).toBeTruthy();
  });

  it("copies the receipt and tells the agent the facts", async () => {
    const user = userEvent.setup();
    setReceipt(sampleReceipt());
    render(<ReceiptBadge sessionId="s1" ptyId={7} cwd="/repo" />);
    await user.click(screen.getByRole("button", { name: "Receipt: Contradicted" }));
    await user.click(await screen.findByRole("button", { name: "Copy receipt" }));
    expect(ipcMock.clipboardWriteText).toHaveBeenCalledWith(expect.stringContaining("Workspace verification receipt: ✗ Contradicted"));
    await user.click(screen.getByRole("button", { name: "Tell the agent" }));
    await waitFor(() => expect(ipcMock.ptyWrite).toHaveBeenCalledWith(7, expect.stringContaining("Workspace verification (re-run by Canopy, not by you)")));
    await waitFor(() => expect(ipcMock.ptyWrite).toHaveBeenCalledWith(7, "\r"));
  });

  it("saves per-project check commands from the receipt", async () => {
    const user = userEvent.setup();
    setReceipt(sampleReceipt());
    render(<ReceiptBadge sessionId="s1" />);
    await user.click(screen.getByRole("button", { name: "Receipt: Contradicted" }));
    await user.click(await screen.findByRole("button", { name: "Set check commands…" }));
    await user.type(screen.getByLabelText(/Check commands for this project/), "make check");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const { getSettings } = await import("../settings");
    expect(getSettings().receiptCommands["/repo"]).toEqual(["make check"]);
  });
});
