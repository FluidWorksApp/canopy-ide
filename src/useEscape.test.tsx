import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render } from "@testing-library/react";
import { useEscape, useEscapeBackstop, useEscapeLayer } from "./useEscape";

// The overlay side panel answers Escape, and it is the one surface in the app
// that everything else is in front of: the dialogs, menus and palettes it opens
// are all layered over it. Without a stack, one press would take the popup AND
// the panel it came from — so the panel uses a backstop that stands down while
// anything else is listening.

function Backstop({ onEscape, enabled = true }: { onEscape: () => void; enabled?: boolean }) {
  useEscapeBackstop(onEscape, enabled);
  return null;
}

function Layer({ open = true }: { open?: boolean }) {
  useEscapeLayer(open);
  return null;
}

function Popup({ onEscape }: { onEscape: () => void }) {
  useEscape(onEscape);
  return null;
}

const escape = (target: Element | Document = document.body) =>
  fireEvent.keyDown(target, { key: "Escape" });

describe("the Escape backstop", () => {
  it("fires when nothing else is listening", () => {
    const onEscape = vi.fn();
    render(<Backstop onEscape={onEscape} />);
    escape();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("ignores every other key", () => {
    const onEscape = vi.fn();
    render(<Backstop onEscape={onEscape} />);
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("does nothing while disabled — a closed panel takes no keys", () => {
    const onEscape = vi.fn();
    render(<Backstop onEscape={onEscape} enabled={false} />);
    escape();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("stands down while a layer is open, and takes over again when it closes", () => {
    const onEscape = vi.fn();
    const view = render(
      <>
        <Backstop onEscape={onEscape} />
        <Layer />
      </>,
    );
    escape();
    expect(onEscape).not.toHaveBeenCalled();
    view.rerender(
      <>
        <Backstop onEscape={onEscape} />
        <Layer open={false} />
      </>,
    );
    escape();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("stands down for a popup using useEscape — that popup closes, alone", () => {
    const onEscape = vi.fn();
    const onPopupEscape = vi.fn();
    render(
      <>
        <Backstop onEscape={onEscape} />
        <Popup onEscape={onPopupEscape} />
      </>,
    );
    escape();
    expect(onPopupEscape).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("counts layers, so closing one popup of two leaves the panel alone", () => {
    const onEscape = vi.fn();
    const view = render(
      <>
        <Backstop onEscape={onEscape} />
        <Layer />
        <Layer />
      </>,
    );
    view.rerender(
      <>
        <Backstop onEscape={onEscape} />
        <Layer />
        <Layer open={false} />
      </>,
    );
    escape();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("leaves Escape to a field being edited — it means cancel this edit", () => {
    const onEscape = vi.fn();
    render(
      <>
        <Backstop onEscape={onEscape} />
        <input aria-label="rename" />
      </>,
    );
    escape(document.querySelector("input")!);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("takes Escape from the terminal, whose hidden textarea edits nothing", () => {
    const onEscape = vi.fn();
    render(
      <>
        <Backstop onEscape={onEscape} />
        <div className="xterm">
          <textarea className="xterm-helper-textarea" aria-label="terminal" />
        </div>
      </>,
    );
    escape(document.querySelector("textarea")!);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe("the side panel's Escape", () => {
  it("is gated on overlay mode — docked, the key stays the terminal's", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "components", "ProjectView", "index.tsx"),
      "utf8",
    );
    expect(src).toMatch(/useEscapeBackstop\(\s*escapeSidePanel,\s*sidePrefs\.overlay && sideOpen,?\s*\)/);
  });
});
