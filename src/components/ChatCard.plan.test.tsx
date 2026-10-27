import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const applyChatApproval = vi.fn(async () => null);
vi.mock("../plans/planStore", () => ({ applyChatApproval: (...a: unknown[]) => applyChatApproval(...(a as [])) }));

import { ChatCard, type ChatCardDeps } from "./ChatCard";
import type { ChatMessage } from "../teamMessaging/client";
import {
  cardDraft,
  cardText,
  foldPlanOutcomes,
  parseCard,
  type PlanCard,
  type PlanOutcomeCard,
} from "../teamMessaging/cardSchema";
import { buildPlanCard } from "../plans/planShare";

const REQ = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const R3 = "33333333-3333-4333-8333-333333333333";
const card: PlanCard = {
  type: "plan",
  v: 1,
  plan: "pl-abc-def123",
  goal: "Paginate the orders list",
  decisions: [{ q: "Pages or scroll?", a: "Pages" }],
  acceptance: ["npm test passes"],
  wontDo: ["Change the API"],
  risk: "medium",
  size: "small",
};
const deps = {} as ChatCardDeps;
const msg = (c: PlanCard | PlanOutcomeCard, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: REQ,
  sender: "alice",
  recipient: null,
  text: cardText(c),
  created: 1,
  card: c,
  ...over,
});
const outcome = (id: string, sender: string, o: PlanOutcomeCard["outcome"], created: number): ChatMessage =>
  msg({ type: "plan-outcome", v: 1, request: REQ, plan: card.plan, outcome: o }, { id, sender, created, thread: { root: REQ } });

afterEach(cleanup);

describe("plan cards on the wire", () => {
  it("round-trip through parseCard with a readable fallback", () => {
    expect(parseCard(card)).toEqual(card);
    const text = cardText(card);
    expect(text).toContain("Plan for review (medium risk, small): Paginate the orders list");
    expect(text).toContain("- Pages or scroll? → Pages");
    expect(text).toContain("Done when:");
  });

  it("drops malformed plan cards and outcomes", () => {
    expect(parseCard({ ...card, plan: "../../etc" })).toBeUndefined();
    expect(parseCard({ ...card, risk: "extreme" })).toBeUndefined();
    expect(parseCard({ ...card, extra: 1 })).toBeUndefined();
    expect(parseCard({ ...card, decisions: [{ q: "x" }] })).toBeUndefined();
    expect(parseCard({ ...card, goal: "bad‮goal" })).toBeUndefined();
    expect(parseCard({ type: "plan-outcome", v: 1, request: "nope", plan: card.plan, outcome: "approved" })).toBeUndefined();
  });

  it("builds a valid card from a plan", () => {
    const built = buildPlanCard({
      planId: "pl-abc-def123",
      goal: "G",
      decisions: [{ question: "Q?", options: [], recommended: "R", why: "" }],
      touches: [],
      acceptance: ["A"],
      wontDo: [],
      risk: "low",
      size: "tiny",
      taskClass: "bugfix",
      request: "r",
      dir: "/repo",
      source: "task",
      gate: "inline",
      gateWhy: [],
    });
    expect(parseCard(built)).toEqual(built);
    expect(built.decisions).toEqual([{ q: "Q?", a: "R" }]);
    expect(() => cardDraft(built)).not.toThrow();
  });

  it("folds the latest answer per teammate, ignoring the author and other threads", () => {
    const req = msg(card);
    const folded = foldPlanOutcomes(req, [
      req,
      outcome(R2, "bob", "changes-requested", 2),
      outcome(R3, "bob", "approved", 3),
      outcome("44444444-4444-4444-8444-444444444444", "alice", "approved", 4),
      { ...outcome("55555555-5555-4555-8555-555555555555", "carol", "approved", 5), thread: { root: R2 } },
    ]);
    expect(folded.map((f) => [f.by, f.outcome])).toEqual([["bob", "approved"]]);
  });
});

describe("plan card in chat", () => {
  it("lets a teammate approve, posting a plan-outcome in the thread", async () => {
    const onReply = vi.fn(async () => {});
    const m = msg(card);
    render(<ChatCard message={m} userId="bob" messages={[m]} name={(id) => id.toUpperCase()} onReply={onReply} deps={deps} />);
    expect(screen.getByText("Paginate the orders list")).toBeInTheDocument();
    expect(screen.getByText("Change the API")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve plan…" }));
    fireEvent.change(screen.getByLabelText("Comment (optional)"), { target: { value: "Looks right" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onReply).toHaveBeenCalled());
    const [text, ext] = onReply.mock.calls[0] as unknown as [string, { card: PlanOutcomeCard; thread: { root: string } }];
    expect(ext.card).toEqual({ type: "plan-outcome", v: 1, request: REQ, plan: card.plan, outcome: "approved" });
    expect(ext.thread).toEqual({ root: REQ });
    expect(text).toContain("Looks right");
    expect(await screen.findByText("You approved this plan.")).toBeInTheDocument();
  });

  it("carries a teammate's approval into the author's plan", async () => {
    const m = msg(card);
    render(
      <ChatCard
        message={m}
        userId="alice"
        messages={[m, outcome(R2, "bob", "approved", 2)]}
        name={(id) => id.toUpperCase()}
        deps={deps}
      />,
    );
    expect(screen.getByText("BOB")).toBeInTheDocument();
    await waitFor(() => expect(applyChatApproval).toHaveBeenCalledWith(card.plan, "BOB"));
    // The author never gets the approve buttons on their own plan.
    expect(screen.queryByRole("button", { name: "Approve plan…" })).toBeNull();
  });
});
