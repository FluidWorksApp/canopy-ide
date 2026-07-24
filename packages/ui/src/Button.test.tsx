import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./Button";

describe("Button", () => {
  it("defaults type to 'button' so it never accidentally submits a form", () => {
    // The whole reason this default exists — a bare <button> is type=submit,
    // which turns a Cancel button into a save.
    render(<Button>Cancel</Button>);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("type", "button");
  });

  it("respects an explicit type override", () => {
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "submit");
  });

  it("applies the base class plus variant and size modifiers", () => {
    render(
      <Button variant="danger-solid" size="mini">
        Delete
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn).toHaveClass("cn-btn", "cn-btn-danger-solid", "cn-btn-mini");
  });

  it("merges a caller-supplied className", () => {
    render(<Button className="extra">X</Button>);
    expect(screen.getByRole("button", { name: "X" })).toHaveClass("cn-btn", "extra");
  });

  it("forwards clicks to onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not fire onClick when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
