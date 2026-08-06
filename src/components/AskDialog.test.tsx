import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AskDialog } from "./AskDialog";

// A long option, of the kind an agent actually writes: a whole clause with a
// worked number in it. This is the case that used to render the button outside
// the dialog's border, across whatever was behind it, with the end of the
// sentence unreadable.
const LONG =
  "Unresolved only (Open+Ack+In Progress): strip Total excludes " +
  "Resolved/Dismissed — QUASAR My scope shows 176, never 0";

describe("AskDialog", () => {
  it("keeps the question and its options in one scrolling body", () => {
    // jsdom has no layout, so the guarantee this can hold is structural: both
    // the prose and the options live inside the element the stylesheet bounds
    // and scrolls, and the answer box and Skip stay outside it — otherwise a
    // long question scrolls the way out of the dialog off the screen.
    const { container } = render(
      <AskDialog question="What should TOTAL represent?" options={[LONG]} onAnswer={vi.fn()} />,
    );
    const body = container.querySelector(".ask-body");
    expect(body).not.toBeNull();
    expect(body!.querySelector(".ask-question")).not.toBeNull();
    expect(body!.querySelector(".ask-option")).not.toBeNull();
    expect(body!.querySelector(".ask-form")).toBeNull();
    expect(body!.querySelector(".confirm-actions")).toBeNull();
  });

  it("answers with the option's full text, however long it is", () => {
    const onAnswer = vi.fn();
    render(<AskDialog question="Which?" options={[LONG, "Keep as-is"]} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: LONG }));
    expect(onAnswer).toHaveBeenCalledWith(LONG);
  });

  it("still lets the user answer in their own words, or skip", () => {
    const onAnswer = vi.fn();
    render(<AskDialog question="Which?" options={[LONG]} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByPlaceholderText(/your own words/i), {
      target: { value: "neither — use the unresolved count" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onAnswer).toHaveBeenCalledWith("neither — use the unresolved count");
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    // The agent is parked on this promise: skipping has to answer it too.
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer.mock.calls[1][0]).toMatch(/skipped/i);
  });
});
