// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { WindowedList } from "./WindowedList";

// The list computes which rows exist from its own viewport position. A scroll
// event is only one way that position changes: a sibling section expanding
// above it shifts it down without scrolling anything and without resizing the
// list itself. Those shifts always arrive with a React commit, so a re-render
// alone must be enough to re-window — the panel showed blank space until the
// user happened to toggle something when it wasn't.

const ROW = 26;
const items = Array.from({ length: 1000 }, (_, i) => i);

function List() {
  return (
    <WindowedList
      items={items}
      rowHeight={ROW}
      renderRow={(n) => <div key={n} data-testid={`row-${n}`} />}
    />
  );
}

function placeAt(container: HTMLElement, top: number) {
  const el = container.firstElementChild as HTMLElement;
  el.getBoundingClientRect = () =>
    ({ top, left: 0, width: 300, height: items.length * ROW }) as DOMRect;
}

describe("WindowedList", () => {
  it("re-windows on a bare re-render after the list has moved", () => {
    const { container, rerender, queryByTestId } = render(<List />);
    placeAt(container, 0);
    rerender(<List />);
    expect(queryByTestId("row-0")).toBeTruthy();
    expect(queryByTestId("row-500")).toBeNull();

    // The list slides far up — as if sections above collapsed or the panel
    // was scrolled while it couldn't listen — and nothing fires an event.
    placeAt(container, -2600);
    rerender(<List />);
    expect(queryByTestId("row-100")).toBeTruthy();
    expect(queryByTestId("row-0")).toBeNull();
  });

  it("never grows past its own height when scrolled far beyond it", () => {
    // Scrolled a full panel-length past the end of this list. Unclamped, the
    // top spacer kept growing with the scroll — the list inflated underneath
    // the user exactly as fast as they scrolled, so the content below never
    // arrived and the scroll read as stuck on blank space.
    const { container, rerender } = render(<List />);
    placeAt(container, -(items.length * ROW + 5000));
    rerender(<List />);
    const el = container.firstElementChild as HTMLElement;
    const pad =
      parseInt(el.style.paddingTop, 10) + parseInt(el.style.paddingBottom, 10);
    expect(el.children.length).toBe(0);
    expect(pad).toBe(items.length * ROW);
  });
});
