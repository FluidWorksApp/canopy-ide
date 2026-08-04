// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { mockCommands } from "../test/setup";
import { AgentBrowserPip, clampPip } from "./AgentBrowserPip";

/** jsdom measures everything as zero, and this component positions itself from
 *  what it measures — so the two rectangles a drag reads are stated here. */
function stubRects(el: HTMLElement, box: { left: number; top: number; width: number; height: number }) {
  const rect = (r: { left: number; top: number; width: number; height: number }) =>
    ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => "" }) as DOMRect;
  el.getBoundingClientRect = () => rect(box);
  document.body.getBoundingClientRect = () => rect({ left: 0, top: 0, width: 1200, height: 800 });
}

function pointer(el: HTMLElement | Window, type: "Down" | "Move" | "Up", x: number, y: number) {
  fireEvent[`pointer${type}` as "pointerDown"](el as HTMLElement, {
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
    isPrimary: true,
  });
}

describe("AgentBrowserPip", () => {
  it("streams the linked browser as a passive image and can be minimized", async () => {
    mockCommands({
      browser_snapshot: { image: "cG5n", width: 1200, height: 800 },
    });
    render(
      <AgentBrowserPip
        tabId="preview-1"
        url="http://localhost:5173/form"
        agentId="opencode"
        agentTitle="Fix the form"
        supported
        onClose={() => {}}
      />,
    );

    const image = await screen.findByAltText("Live read-only view of localhost:5173");
    expect(image).toHaveAttribute("src", "data:image/png;base64,cG5n");
    expect(image.parentElement).toHaveStyle({ aspectRatio: "1.5" });

    fireEvent.click(screen.getByLabelText("Minimize browser picture in picture"));
    expect(screen.queryByAltText("Live read-only view of localhost:5173")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Restore browser picture in picture")).toBeInTheDocument();
  });

  it("closes without navigating to the browser", () => {
    let closed = false;
    render(
      <AgentBrowserPip
        tabId="preview-1"
        url="http://localhost:5173/form"
        agentId="opencode"
        agentTitle="Fix the form"
        supported={false}
        onClose={() => { closed = true; }}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close browser picture in picture"));
    expect(closed).toBe(true);
  });

  it("is dragged by its header and anchors where it is dropped", () => {
    render(
      <AgentBrowserPip
        tabId="preview-1"
        url="http://localhost:5173/form"
        agentId="opencode"
        agentTitle="Fix the form"
        supported={false}
        slot={0}
        onClose={() => {}}
      />,
    );
    const pip = screen.getByLabelText("Fix the form browser picture in picture");
    // Dealt to the corner until it is moved.
    expect(pip.style.right).toBe("18px");
    stubRects(pip, { left: 500, top: 400, width: 400, height: 260 });

    act(() => {
      pointer(pip.querySelector(".agent-browser-pip-head") as HTMLElement, "Down", 520, 410);
      pointer(window, "Move", 620, 500);
      pointer(window, "Up", 620, 500);
    });

    // Moved by the pointer's delta, not snapped to it: the grab offset holds.
    expect(pip.style.left).toBe("600px");
    expect(pip.style.top).toBe("490px");
    expect(pip.style.right).toBe("auto");

    // And it stays put — a pointer move after the drag ended is not a drag.
    act(() => void pointer(window, "Move", 100, 100));
    expect(pip.style.left).toBe("600px");
  });

  it("does not start a drag from the header's buttons", () => {
    let closed = false;
    render(
      <AgentBrowserPip
        tabId="preview-1"
        url="http://localhost:5173/form"
        agentId="opencode"
        agentTitle="Fix the form"
        supported={false}
        onClose={() => { closed = true; }}
      />,
    );
    const pip = screen.getByLabelText("Fix the form browser picture in picture");
    stubRects(pip, { left: 500, top: 400, width: 400, height: 260 });
    act(() => {
      pointer(screen.getByLabelText("Close browser picture in picture"), "Down", 520, 410);
      pointer(window, "Move", 900, 700);
    });
    expect(pip.style.left).toBe("");
    fireEvent.click(screen.getByLabelText("Close browser picture in picture"));
    expect(closed).toBe(true);
  });

  it("stacks a second agent's view off the first one's corner", () => {
    render(
      <AgentBrowserPip
        tabId="preview-2"
        url="http://localhost:5173/other"
        agentId="claude"
        agentTitle="Second agent"
        supported={false}
        slot={1}
        onClose={() => {}}
      />,
    );
    const pip = screen.getByLabelText("Second agent browser picture in picture");
    expect(pip.style.right).toBe("44px");
    expect(pip.style.bottom).toBe("44px");
  });
});

describe("clampPip", () => {
  it("keeps a pip inside its pane", () => {
    const size = { width: 400, height: 260 };
    const area = { width: 1200, height: 800 };
    expect(clampPip({ x: -80, y: -20 }, size, area)).toEqual({ x: 0, y: 0 });
    expect(clampPip({ x: 5000, y: 5000 }, size, area)).toEqual({ x: 800, y: 540 });
  });

  it("pins rather than jumps when the pip is bigger than the pane", () => {
    expect(clampPip({ x: 40, y: 40 }, { width: 900, height: 600 }, { width: 500, height: 300 })).toEqual({
      x: 0,
      y: 0,
    });
  });
});
