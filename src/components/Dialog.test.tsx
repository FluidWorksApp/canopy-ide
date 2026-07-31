// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Dialog } from "./Dialog";

// The keyboard contract every pop-up in the app inherits by going through this
// component: Enter commits, Escape dismisses, from wherever focus happens to be.
// A dialog you can only answer with the mouse is the bug these cover.

const dialog = (over: Partial<React.ComponentProps<typeof Dialog>> = {}) => {
  const props = {
    title: "Discard changes to app.ts?",
    dismissLabel: "Cancel",
    onDismiss: vi.fn(),
    actions: [{ label: "Discard", primary: true, onClick: vi.fn() }],
    ...over,
  };
  render(<Dialog {...props} />);
  return props;
};

const press = (key: string, target: Element = document.body) =>
  fireEvent.keyDown(target, { key });

describe("the shared dialog's keys", () => {
  it("hands focus to the action Enter fires, danger included", () => {
    dialog({ variant: "danger" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Discard" }),
    );
  });

  it("dismisses on Escape without running the action", () => {
    const props = dialog();
    press("Escape");
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
    expect(props.actions[0].onClick).not.toHaveBeenCalled();
  });

  it("commits on Enter typed in a field the dialog owns", () => {
    const props = dialog({
      title: "New file",
      actions: [{ label: "Create", primary: true, onClick: vi.fn() }],
      children: <input aria-label="name" />,
    });
    const input = screen.getByLabelText("name");
    input.focus();
    press("Enter", input);
    expect(props.actions[0].onClick).toHaveBeenCalledTimes(1);
  });

  it("leaves Enter alone while the action is disabled", () => {
    const props = dialog({
      actions: [
        { label: "Discard", primary: true, disabled: true, onClick: vi.fn() },
      ],
    });
    press("Enter");
    expect(props.actions[0].onClick).not.toHaveBeenCalled();
  });

  it("fires the action once when its own button has focus", () => {
    // The focused button gets Enter natively; the dialog must not fire a second
    // time on top of the click the browser is about to send.
    const props = dialog({ variant: "accent" });
    const btn = screen.getByRole("button", { name: "Discard" });
    btn.focus();
    press("Enter", btn);
    fireEvent.click(btn);
    expect(props.actions[0].onClick).toHaveBeenCalledTimes(1);
  });

  it("names the buttons without their shortcut hints", () => {
    dialog();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
