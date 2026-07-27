import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextMenu, type MenuItem } from "./ContextMenu";

const at = (items: MenuItem[], onClose = vi.fn()) => {
  render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
  return onClose;
};

describe("ContextMenu", () => {
  it("renders item labels as buttons", () => {
    at([{ label: "Rename" }, { label: "Delete" }]);
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("fires the item's onClick and then closes", async () => {
    const onClick = vi.fn();
    const onClose = at([{ label: "Rename", onClick }]);
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders a labelled separator as a section heading, not a button", () => {
    at([{ separator: true, label: "Running" }, { label: "Attach" }]);
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Running" })).not.toBeInTheDocument();
  });

  it("disables an item marked disabled", async () => {
    const onClick = vi.fn();
    at([{ label: "Paste", onClick, disabled: true }]);
    const btn = screen.getByRole("button", { name: "Paste" });
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const onClose = at([{ label: "Rename" }]);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on an outside mousedown but not on a click inside the menu", async () => {
    const onClose = at([{ label: "Rename" }]);
    // Inside: capture-phase handler hit-tests the target and ignores it.
    await userEvent.pointer({
      keys: "[MouseLeft>]",
      target: screen.getByRole("button", { name: "Rename" }),
    });
    expect(onClose).not.toHaveBeenCalled();
    // Outside: mousedown on the document body closes.
    await userEvent.pointer({ keys: "[MouseLeft>]", target: document.body });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens a submenu on click and runs a nested item", async () => {
    const nested = vi.fn();
    const onClose = at([
      { label: "New agent", submenu: [{ label: "Claude", onClick: nested }] },
    ]);
    await userEvent.click(screen.getByRole("button", { name: /New agent/ }));
    const claude = await screen.findByRole("button", { name: "Claude" });
    await userEvent.click(claude);
    expect(nested).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not open a submenu on hover alone", async () => {
    // Hover-to-open is what made a submenu impossible to shut: clicking the row
    // closed it and the pointer, still sitting on that row, opened it again.
    at([{ label: "New agent", submenu: [{ label: "Claude" }] }]);
    await userEvent.hover(screen.getByRole("button", { name: /New agent/ }));
    expect(screen.queryByRole("button", { name: "Claude" })).toBeNull();
  });

  it("closes an open submenu when its row is clicked again", async () => {
    at([{ label: "New agent", submenu: [{ label: "Claude" }] }]);
    const row = screen.getByRole("button", { name: /New agent/ });
    await userEvent.click(row);
    expect(await screen.findByRole("button", { name: "Claude" })).toBeTruthy();
    await userEvent.click(row);
    expect(screen.queryByRole("button", { name: "Claude" })).toBeNull();
  });

  it("switches between submenus on hover once one is already open", async () => {
    // The half of hover that was worth keeping: sliding down a list of nested
    // rows should follow the pointer, it just must not be what opens the first.
    at([
      { label: "New agent", submenu: [{ label: "Claude" }] },
      { label: "Request review", submenu: [{ label: "VijayMatt" }] },
    ]);
    await userEvent.click(screen.getByRole("button", { name: /New agent/ }));
    await userEvent.hover(screen.getByRole("button", { name: /Request review/ }));
    expect(await screen.findByRole("button", { name: "VijayMatt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Claude" })).toBeNull();
  });
});
