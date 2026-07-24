import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useTabDrag } from "./tabDrag";

// Each tab is 100px wide, laid out left to right — so tab i spans [i*100,
// i*100+100) and its midpoint is at i*100+50. jsdom has no layout, so both the
// rects and the hit-testing are stood up by hand.
const WIDTH = 100;

function Strip({ ids, onReorder }: { ids: string[]; onReorder: (ids: string[]) => void }) {
  const drag = useTabDrag(ids, onReorder);
  return (
    <div>
      {ids.map((id) => (
        <div
          key={id}
          data-testid={id}
          className={drag.dragId === id ? "tab-dragging" : ""}
          {...drag.itemProps(id)}
        >
          {id}
          <span className="tab-close">x</span>
        </div>
      ))}
    </div>
  );
}

/** Lay the rendered tabs out and hit-test by x, honouring the pointer-events:
 *  none the dragged tab carries (the real CSS does this; jsdom won't). */
function layOut(ids: string[]) {
  const els = ids.map((id) => screen.getByTestId(id));
  els.forEach((el, i) => {
    el.getBoundingClientRect = () =>
      ({ left: i * WIDTH, right: (i + 1) * WIDTH, width: WIDTH, top: 0, bottom: 30, height: 30 }) as DOMRect;
  });
  document.elementFromPoint = (x: number) => {
    const el = els[Math.floor(x / WIDTH)];
    return !el || el.classList.contains("tab-dragging") ? document.body : el;
  };
  return els;
}

const drag = (from: HTMLElement, startX: number, toX: number) => {
  fireEvent.pointerDown(from, { button: 0, clientX: startX });
  fireEvent.pointerMove(window, { clientX: toX });
};

afterEach(() => {
  fireEvent.pointerUp(window);
});

describe("useTabDrag", () => {
  it("moves a tab right once it passes its neighbour's midpoint", () => {
    const onReorder = vi.fn();
    render(<Strip ids={["a", "b", "c"]} onReorder={onReorder} />);
    layOut(["a", "b", "c"]);
    drag(screen.getByTestId("a"), 50, 160);
    expect(onReorder).toHaveBeenCalledWith(["b", "a", "c"]);
  });

  it("moves a tab left the same way", () => {
    const onReorder = vi.fn();
    render(<Strip ids={["a", "b", "c"]} onReorder={onReorder} />);
    layOut(["a", "b", "c"]);
    drag(screen.getByTestId("c"), 250, 130);
    expect(onReorder).toHaveBeenCalledWith(["a", "c", "b"]);
  });

  it("holds off until the neighbour's midpoint is crossed", () => {
    const onReorder = vi.fn();
    render(<Strip ids={["a", "b", "c"]} onReorder={onReorder} />);
    layOut(["a", "b", "c"]);
    // 140 is inside b but still left of its midpoint: b hasn't been passed.
    drag(screen.getByTestId("a"), 50, 140);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("treats a few pixels of wobble as a click, not a drag", () => {
    const onReorder = vi.fn();
    render(<Strip ids={["a", "b", "c"]} onReorder={onReorder} />);
    layOut(["a", "b", "c"]);
    drag(screen.getByTestId("a"), 50, 52);
    expect(onReorder).not.toHaveBeenCalled();
    expect(screen.getByTestId("a").className).not.toContain("tab-dragging");
  });

  it("ignores a drag started on the close button", () => {
    const onReorder = vi.fn();
    render(<Strip ids={["a", "b", "c"]} onReorder={onReorder} />);
    const els = layOut(["a", "b", "c"]);
    fireEvent.pointerDown(els[0].querySelector(".tab-close")!, { button: 0, clientX: 50 });
    fireEvent.pointerMove(window, { clientX: 160 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("ignores tabs belonging to another strip", () => {
    // Two strips side by side, as the agent and doc groups are: dragging a tab
    // of one over a tab of the other is not a reorder of either.
    const onReorder = vi.fn();
    const other = vi.fn();
    render(<Strip ids={["a", "b"]} onReorder={onReorder} />);
    render(<Strip ids={["c", "d"]} onReorder={other} />);
    layOut(["a", "b", "c", "d"]);
    drag(screen.getByTestId("b"), 150, 260);
    expect(onReorder).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });

  it("swallows the click a drag ends on so it doesn't also switch tabs", () => {
    const onReorder = vi.fn();
    const onClick = vi.fn();
    render(<Strip ids={["a", "b", "c"]} onReorder={onReorder} />);
    const els = layOut(["a", "b", "c"]);
    els[1].addEventListener("click", onClick);
    drag(els[0], 50, 160);
    fireEvent.pointerUp(window);
    fireEvent.click(els[1]);
    expect(onClick).not.toHaveBeenCalled();
  });
});
