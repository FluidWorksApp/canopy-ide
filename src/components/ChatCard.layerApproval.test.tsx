import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const applyLayerApprovalAnswer = vi.fn(async (..._a: unknown[]) => null);
vi.mock("../lensApprovals", () => ({ applyLayerApprovalAnswer: (...a: unknown[]) => applyLayerApprovalAnswer(...a) }));
vi.mock("../plans/planStore", () => ({ applyChatApproval: vi.fn(async () => null) }));

import { ChatCard, type ChatCardDeps } from "./ChatCard";
import type { ChatMessage } from "../teamMessaging/client";
import { cardText, type LayerApprovalCard, type LayerApprovalOutcomeCard } from "../teamMessaging/cardSchema";

const REQ = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const card: LayerApprovalCard = {
  type: "layer-approval",
  v: 1,
  approval: "la-abc123",
  layer: "data",
  owner: "sam",
  project: "Shop",
  files: ["prisma/schema.prisma"],
  summary: "What was asked for: add a phone number",
};
const deps = {} as ChatCardDeps;
const msg = (c: LayerApprovalCard | LayerApprovalOutcomeCard, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: REQ,
  sender: "alex",
  recipient: "sam",
  text: cardText(c),
  created: 1,
  card: c,
  ...over,
});

afterEach(cleanup);
configure({ asyncUtilTimeout: 8000 });

describe("layer approval card in chat", () => {
  it("lets the owner approve, posting the outcome in the request's thread", async () => {
    const onReply = vi.fn(async (..._a: unknown[]) => {});
    const m = msg(card);
    render(<ChatCard message={m} userId="sam" messages={[m]} name={(id) => id.toUpperCase()} onReply={onReply} deps={deps} />);
    expect(screen.getByText("prisma/schema.prisma")).toBeInTheDocument();
    expect(screen.getByText(/You own Data/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve…" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onReply).toHaveBeenCalled());
    const [, ext] = onReply.mock.calls[0] as [string, { card: LayerApprovalOutcomeCard; thread: { root: string } }];
    expect(ext.card).toEqual({ type: "layer-approval-outcome", v: 1, request: REQ, approval: "la-abc123", outcome: "approved" });
    expect(ext.thread).toEqual({ root: REQ });
  }, 30_000);

  it("needs a reason to reject", async () => {
    const onReply = vi.fn(async (..._a: unknown[]) => {});
    const m = msg(card);
    render(<ChatCard message={m} userId="sam" messages={[m]} name={(id) => id} onReply={onReply} deps={deps} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Why (required)"), { target: { value: "Use the existing column" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(onReply).toHaveBeenCalled());
    expect((onReply.mock.calls[0] as [string])[0]).toContain("Use the existing column");
  }, 30_000);

  it("shows anyone else no buttons, and carries the owner's answer back on the requester's machine", async () => {
    const m = msg(card);
    const answer = msg(
      { type: "layer-approval-outcome", v: 1, request: REQ, approval: "la-abc123", outcome: "approved" },
      { id: R2, sender: "sam", recipient: "alex", created: 2, thread: { root: REQ } },
    );
    render(<ChatCard message={m} userId="alex" messages={[m, answer]} name={(id) => id.toUpperCase()} deps={deps} />);
    expect(screen.queryByRole("button", { name: "Approve…" })).toBeNull();
    expect(screen.getByText(/Approved/)).toBeInTheDocument();
    await waitFor(() =>
      expect(applyLayerApprovalAnswer).toHaveBeenCalledWith({ approval: "la-abc123", outcome: "approved", by: "sam", byName: "SAM" }),
    );
  }, 30_000);
});
