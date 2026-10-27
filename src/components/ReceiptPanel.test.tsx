// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ReceiptPanel } from "./ReceiptPanel";
import { sampleReceipt } from "../receipts/fixtures";
import type { PreviewShot } from "../receipts/types";

const shot = (at: number): PreviewShot => ({
  image: "data:image/jpeg;base64,AAAA",
  width: 720,
  height: 450,
  url: "http://localhost:5173/cart",
  title: "Cart",
  at,
});

describe("ReceiptPanel preview", () => {
  it("shows before and after pictures with what changed, and enlarges one in place", async () => {
    const user = userEvent.setup();
    const record = sampleReceipt({
      preview: {
        url: "http://localhost:5173/cart",
        before: shot(1),
        after: shot(2),
        changes: ['New text on the page: "Free shipping".'],
        summary: "Preview of http://localhost:5173/cart before and after the turn: one visible change in the page's text and controls.",
      },
    });
    render(<ReceiptPanel state={{ state: "done", record }} onReverify={() => {}} />);
    expect(screen.getByText(/one visible change/)).toBeTruthy();
    expect(screen.getByText('New text on the page: "Free shipping".')).toBeTruthy();
    const imgs = screen.getAllByRole("img");
    expect(imgs.map((i) => i.getAttribute("alt"))).toEqual([
      expect.stringMatching(/^Before the turn: the preview of “Cart” at http:\/\/localhost:5173\/cart/),
      expect.stringMatching(/^After the turn:/),
    ]);
    await user.click(screen.getByRole("button", { name: "Enlarge the picture after the turn" }));
    const smaller = screen.getByRole("button", { name: "Show the picture after the turn smaller" });
    expect(document.activeElement).toBe(smaller);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    await user.click(smaller);
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("has no preview section when no preview was open", () => {
    render(<ReceiptPanel state={{ state: "done", record: sampleReceipt() }} onReverify={() => {}} />);
    expect(screen.queryByRole("region", { name: "Preview before and after" })).toBeNull();
  });
});

describe("ReceiptPanel plan checks and isolation", () => {
  it("lists the plan's checks for done with what the verdict found, and where the checks ran", () => {
    const base = sampleReceipt();
    const record = sampleReceipt({
      ranIn: { kind: "copy", tree: "abc1234" },
      plan: { planId: "pl-a-b", goal: "Sum adds", acceptance: ["npm test passes", "Total shows on the page"] },
      verdict: {
        ...(base.verdict ?? { verdict: "partial", asked: "", did: "d", evidence: [], gaps: [] }),
        acceptance: [
          { item: "npm test passes", met: true, evidence: "4 passed" },
          { item: "Total shows on the page", met: false, evidence: "nothing on the page changed" },
        ],
      },
    });
    render(<ReceiptPanel state={{ state: "done", record }} onReverify={() => {}} />);
    const list = screen.getByRole("region", { name: "What the plan said counts as done" });
    expect(list.textContent).toContain("Met: npm test passes — 4 passed");
    expect(list.textContent).toContain("Not met: Total shows on the page");
    expect(screen.getByText(/separate copy of this turn's files/)).toBeTruthy();
  });

  it("says when the checks had to run in the live folder", () => {
    render(<ReceiptPanel state={{ state: "done", record: sampleReceipt({ ranIn: { kind: "live", why: "disk full" } }) }} onReverify={() => {}} />);
    expect(screen.getByText(/ran in the live folder.*disk full/)).toBeTruthy();
  });
});
