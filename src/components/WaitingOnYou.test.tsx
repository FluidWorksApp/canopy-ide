import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WaitingOnYou } from "./WaitingOnYou";
import { asksFor, clearAsks, handleReply, openAsksFor, setWaitingDepsForTests } from "../waitingOnYou";

const S = "session-1";

/** Put questions on the list the way they arrive: from a reply. */
async function seed(asks: unknown[]) {
  setWaitingDepsForTests({
    enabled: () => true,
    decide: (async () => ({ ok: true, answers: { asks: { type: "noul", noul: 0.9 } }, latencyMs: 1 })) as never,
    askBrain: (async (req: { validate: (v: unknown) => unknown }) => ({ ok: true, value: req.validate({ asks, settled: [] }) })) as never,
    trace: () => {},
  });
  await act(async () => {
    await handleReply(S, "questions");
  });
}

const FOUR = [
  { question: "Delete the old migration files?", type: "yes_no" },
  { question: "Which database should the service use?", type: "single", options: ["Postgres", "SQLite"], free_text: true },
  { question: "Which platforms should the build target?", type: "multiple", options: ["macOS", "Linux", "Windows"] },
  { question: "What should the variable be called?", type: "text" },
];

beforeEach(() => clearAsks());
afterEach(() => {
  cleanup();
  setWaitingDepsForTests(null);
});

describe("Waiting on you", () => {
  it("draws nothing while the agent is waiting on nothing", () => {
    const { container } = render(<WaitingOnYou sessionId={S} canAct onSend={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("draws each question by the kind of answer it takes", async () => {
    await seed(FOUR);
    render(<WaitingOnYou sessionId={S} canAct onSend={vi.fn()} />);
    expect(screen.getByLabelText("4 unanswered").textContent).toBe("4");
    // Yes/no and single choice are radios; multiple choice is checkboxes.
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Yes", "No", "Postgres", "SQLite"]);
    expect(screen.getAllByRole("checkbox").map((c) => c.textContent)).toEqual(["macOS", "Linux", "Windows"]);
    // Words: the free-text question, and the single choice that allows them.
    expect(screen.getByLabelText("Answer: What should the variable be called?")).toBeTruthy();
    expect(screen.getByLabelText("Note for: Which database should the service use?")).toBeTruthy();
    expect(screen.queryByLabelText("Note for: Delete the old migration files?")).toBeNull();
    expect(screen.queryByLabelText("Note for: Which platforms should the build target?")).toBeNull();
    expect(screen.getByText("Pick one, or say more")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends what was filled in as one message and keeps the rest waiting", async () => {
    await seed(FOUR);
    const onSend = vi.fn(async () => ({ delivered: true, note: "" }));
    render(<WaitingOnYou sessionId={S} canAct onSend={onSend} />);
    fireEvent.click(screen.getByRole("radio", { name: "No" }));
    fireEvent.click(screen.getByRole("radio", { name: "Postgres" }));
    fireEvent.click(screen.getByRole("radio", { name: "SQLite" })); // changes the pick
    expect(screen.getByRole("radio", { name: "Postgres" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.change(screen.getByLabelText("Note for: Which database should the service use?"), { target: { value: "in WAL mode" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Windows" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "macOS" }));
    expect(screen.getByText("3 of 4 answered")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send 3 answers" }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(
      "Answering your questions. (1) Delete the old migration files: No; (2) Which database should the service use: SQLite (in WAL mode); (3) Which platforms should the build target: macOS, Windows",
    );
    // The three answered are gone; the one left blank still waits.
    expect(openAsksFor(S).map((a) => a.question)).toEqual(["What should the variable be called?"]);
    expect(asksFor(S).filter((a) => a.status === "answered")).toHaveLength(3);
    expect(screen.getByLabelText("1 unanswered")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("Enter in the answer line sends it", async () => {
    await seed([FOUR[3]]);
    const onSend = vi.fn(async () => ({ delivered: true, note: "" }));
    render(<WaitingOnYou sessionId={S} canAct onSend={onSend} />);
    const input = screen.getByLabelText("Answer: What should the variable be called?");
    fireEvent.change(input, { target: { value: "DATABASE_URL" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onSend).toHaveBeenCalledWith('Answering your question "What should the variable be called": DATABASE_URL');
    expect(openAsksFor(S)).toEqual([]);
  });

  it("keeps the answers when the agent did not receive them, and says why", async () => {
    await seed([FOUR[0]]);
    const onNotice = vi.fn();
    render(<WaitingOnYou sessionId={S} canAct onSend={async () => ({ delivered: false, note: "The terminal is closed." })} onNotice={onNotice} />);
    fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    });
    expect(onNotice).toHaveBeenCalledWith("The terminal is closed.");
    expect(openAsksFor(S)).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "Yes" }).getAttribute("aria-checked")).toBe("true");
  });

  it("does not type into an agent that is waiting on a menu", async () => {
    await seed([FOUR[0]]);
    const onSend = vi.fn();
    render(<WaitingOnYou sessionId={S} canAct={false} actHint="The agent is waiting for your answer. Answer it first." onSend={onSend} />);
    fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
    const send = screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe("The agent is waiting for your answer. Answer it first.");
    fireEvent.click(send);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a question can be taken off the list without answering it", async () => {
    await seed([FOUR[0], FOUR[3]]);
    render(<WaitingOnYou sessionId={S} canAct onSend={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Delete the old migration files?" }));
    expect(asksFor(S).map((a) => a.status)).toEqual(["dropped", "open"]);
    expect(screen.queryByText("Delete the old migration files?")).toBeNull();
    // Collapsing keeps the count in view.
    fireEvent.click(screen.getByRole("button", { name: /Waiting on you/ }));
    expect(screen.queryByText("What should the variable be called?")).toBeNull();
    expect(screen.getByLabelText("1 unanswered")).toBeTruthy();
  });
});
