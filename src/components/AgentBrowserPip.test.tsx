// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { mockCommands } from "../test/setup";
import { AgentBrowserPip, clampPip, pipOwnerVisible } from "./AgentBrowserPip";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** jsdom measures everything as zero, and this component positions itself from
 *  what it measures — so the two rectangles it reads are stated here. Mutable,
 *  because the point of the re-clamp is what happens when they CHANGE: the pip
 *  grows back out of its minimized height, a taller frame arrives, a panel takes
 *  half the pane. */
function stubRects(el: HTMLElement, box: Box, area: Box = { left: 0, top: 0, width: 1200, height: 800 }) {
  const rect = (r: Box) =>
    ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => "" }) as DOMRect;
  const state = { box, area };
  el.getBoundingClientRect = () => rect(state.box);
  document.body.getBoundingClientRect = () => rect(state.area);
  return {
    resizePip: (patch: Partial<Box>) => {
      state.box = { ...state.box, ...patch };
    },
    resizePane: (patch: Partial<Box>) => {
      state.area = { ...state.area, ...patch };
    },
  };
}

const at = (pip: HTMLElement) => ({ left: pip.style.left, top: pip.style.top });

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
      browser_here: { url: "http://localhost:5173/form", title: "Form" },
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
    // JPEG is what the pip asks for; the mock omits mimeType and the fallback
    // matches the request.
    expect(image).toHaveAttribute("src", "data:image/jpeg;base64,cG5n");
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

  it("does not accept a blank snapshot before the background page is ready", async () => {
    vi.useFakeTimers();
    let ready = false;
    let snapshots = 0;
    mockCommands({
      browser_here: () =>
        ready ? { url: "http://localhost:5173/form", title: "Form" } : null,
      browser_snapshot: () => {
        snapshots++;
        return { image: "cG5n", width: 1200, height: 800 };
      },
    });

    try {
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
      await act(async () => void (await Promise.resolve()));
      expect(snapshots).toBe(0);
      expect(screen.getByText("Connecting to browser...")).toBeInTheDocument();

      ready = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(snapshots).toBe(1);
      expect(screen.getByAltText("Live read-only view of localhost:5173")).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,cG5n",
      );
    } finally {
      vi.useRealTimers();
    }
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

describe("AgentBrowserPip staying inside the pane", () => {
  const pip = () => screen.getByLabelText("Fix the form browser picture in picture");

  function mount(props: Partial<React.ComponentProps<typeof AgentBrowserPip>> = {}) {
    return render(
      <AgentBrowserPip
        tabId="preview-1"
        url="http://localhost:5173/form"
        agentId="opencode"
        agentTitle="Fix the form"
        supported={false}
        onClose={() => {}}
        {...props}
      />,
    );
  }

  it("pulls a minimized pip back inside when it is restored", () => {
    mount();
    const rects = stubRects(pip(), { left: 0, top: 0, width: 400, height: 260 });

    act(() => void fireEvent.click(screen.getByLabelText("Minimize browser picture in picture")));
    rects.resizePip({ height: 34 });

    // Dragged to the very bottom while it is only a title bar tall.
    act(() => {
      pointer(pip().querySelector(".agent-browser-pip-head") as HTMLElement, "Down", 0, 0);
      pointer(window, "Move", 0, 766);
      pointer(window, "Up", 0, 766);
    });
    expect(pip().style.top).toBe("766px");

    // Restoring makes it 260 tall again: at y=766 all but its header would be
    // below the pane, and the header is the only way to drag it back.
    rects.resizePip({ height: 260 });
    act(() => void fireEvent.click(screen.getByLabelText("Restore browser picture in picture")));
    expect(pip().style.top).toBe("540px");
  });

  it("pulls a pip back in when the pane gets smaller", () => {
    mount();
    const rects = stubRects(pip(), { left: 0, top: 0, width: 400, height: 260 });
    act(() => {
      pointer(pip().querySelector(".agent-browser-pip-head") as HTMLElement, "Down", 0, 0);
      pointer(window, "Move", 800, 540);
      pointer(window, "Up", 800, 540);
    });
    expect(at(pip())).toEqual({ left: "800px", top: "540px" });

    // A panel opens and the pane loses a third of its width and some height.
    rects.resizePane({ width: 900, height: 600 });
    act(() => void fireEvent(window, new Event("resize")));
    expect(at(pip())).toEqual({ left: "500px", top: "340px" });
  });

  it("pulls a pip back in when a taller frame arrives", async () => {
    mockCommands({
      browser_here: { url: "http://localhost:5173/form", title: "Form" },
      browser_snapshot: { image: "cG5n", width: 400, height: 1200 },
    });
    mount({ supported: true });
    const rects = stubRects(pip(), { left: 0, top: 0, width: 400, height: 260 });
    act(() => {
      pointer(pip().querySelector(".agent-browser-pip-head") as HTMLElement, "Down", 0, 0);
      pointer(window, "Move", 0, 540);
      pointer(window, "Up", 0, 540);
    });
    expect(pip().style.top).toBe("540px");

    // The first frame is 1:3, so the pip becomes three times as tall as it is
    // wide — 1200 in a pane only 800 high.
    rects.resizePip({ height: 1200 });
    await screen.findByAltText("Live read-only view of localhost:5173");
    expect(pip().style.top).toBe("0px");
  });

  it("keeps where it was put when its own tab comes to the front and goes away again", () => {
    const { rerender } = mount();
    const rects = stubRects(pip(), { left: 0, top: 0, width: 400, height: 260 });
    act(() => {
      pointer(pip().querySelector(".agent-browser-pip-head") as HTMLElement, "Down", 0, 0);
      pointer(window, "Move", 120, 90);
      pointer(window, "Up", 120, 90);
    });
    act(() => {
      pointer(pip().querySelector(".agent-browser-pip-resize") as HTMLElement, "Down", 0, 0);
      pointer(window, "Move", -160, 0);
      pointer(window, "Up", -160, 0);
    });
    act(() => void fireEvent.click(screen.getByLabelText("Minimize browser picture in picture")));
    const placed = { ...at(pip()), width: pip().style.width };
    expect(placed.width).toBe("560px");

    const props = {
      tabId: "preview-1",
      url: "http://localhost:5173/form",
      agentId: "opencode",
      agentTitle: "Fix the form",
      supported: false,
      onClose: () => {},
    };
    // The user opens the full preview: the pip is suppressed, not thrown away.
    rerender(<AgentBrowserPip {...props} hidden />);
    expect(pip().style.display).toBe("none");
    rects.resizePip({ height: 34 });
    rerender(<AgentBrowserPip {...props} />);

    expect({ ...at(pip()), width: pip().style.width }).toEqual(placed);
    expect(screen.getByLabelText("Restore browser picture in picture")).toBeInTheDocument();
  });

  it("does not stream while hidden", async () => {
    let shots = 0;
    mockCommands({
      browser_here: { url: "http://localhost:5173/form", title: "Form" },
      browser_snapshot: () => {
        shots++;
        return { image: "cG5n", width: 1200, height: 800 };
      },
    });
    const { rerender } = mount({ supported: true, hidden: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(shots).toBe(0);

    // The counter has to be able to move, or this proves nothing: showing it
    // again starts the frames.
    rerender(
      <AgentBrowserPip
        tabId="preview-1"
        url="http://localhost:5173/form"
        agentId="opencode"
        agentTitle="Fix the form"
        supported
        onClose={() => {}}
      />,
    );
    await screen.findByAltText("Live read-only view of localhost:5173");
    expect(shots).toBeGreaterThan(0);
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

describe("pipOwnerVisible", () => {
  const terminals = [
    { id: "agent-a", ptyId: 10, paneGroup: "group-1" },
    { id: "agent-b", ptyId: 11, paneGroup: "group-1" },
    { id: "agent-c", ptyId: 12 },
  ];

  it("shows a pip only in its owning terminal or multiplex", () => {
    expect(pipOwnerVisible(10, terminals, "agent-a")).toBe(true);
    expect(pipOwnerVisible(10, terminals, "agent-b")).toBe(true);
    expect(pipOwnerVisible(10, terminals, "agent-c")).toBe(false);
    expect(pipOwnerVisible(10, terminals, "preview-tab")).toBe(false);
  });

  it("hides a pip after its owner is gone", () => {
    expect(pipOwnerVisible(99, terminals, "agent-a")).toBe(false);
  });
});
