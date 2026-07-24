import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Confirm, Modal, PromptDialog } from "./Modal";

describe("Modal", () => {
  it("renders its children", () => {
    render(<Modal>hello inside</Modal>);
    expect(screen.getByText("hello inside")).toBeInTheDocument();
  });

  it("dismisses on a backdrop mousedown", async () => {
    const onDismiss = vi.fn();
    const { container } = render(<Modal onDismiss={onDismiss}>body</Modal>);
    const backdrop = container.querySelector(".cn-backdrop")!;
    await userEvent.pointer({ keys: "[MouseLeft>]", target: backdrop });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does NOT dismiss on a mousedown that starts inside the panel", async () => {
    // The documented drag-select-then-release case: the panel stops propagation
    // so a mousedown inside it never reaches the backdrop handler.
    const onDismiss = vi.fn();
    render(<Modal onDismiss={onDismiss}>body</Modal>);
    await userEvent.pointer({ keys: "[MouseLeft>]", target: screen.getByText("body") });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses on Escape", async () => {
    const onDismiss = vi.fn();
    render(<Modal onDismiss={onDismiss}>body</Modal>);
    await userEvent.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("Confirm", () => {
  it("dismisses on Escape", async () => {
    const onDismiss = vi.fn();
    render(<Confirm onDismiss={onDismiss}>sure?</Confirm>);
    await userEvent.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("PromptDialog", () => {
  it("submits natively on Enter in a field (not via onKeyDown hacks)", async () => {
    const onSubmit = vi.fn();
    render(
      <PromptDialog onSubmit={onSubmit} onDismiss={() => {}}>
        <input aria-label="name" />
      </PromptDialog>,
    );
    const input = screen.getByLabelText("name");
    await userEvent.type(input, "hi{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("Escape still dismisses without submitting", async () => {
    const onSubmit = vi.fn();
    const onDismiss = vi.fn();
    render(
      <PromptDialog onSubmit={onSubmit} onDismiss={onDismiss}>
        <input aria-label="name" />
      </PromptDialog>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
