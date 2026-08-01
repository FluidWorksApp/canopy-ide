// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Skeleton, SkeletonBox, SkeletonText } from "./Skeleton";

// These exist to stop a view rearranging itself as it loads, so what's worth
// testing isn't how they look — it's that they hold a size, that they say what
// they're standing in for, and that a re-render doesn't reshuffle them. A
// placeholder that flickers is worse than the bare "Loading…" it replaced.

describe("the loading placeholder", () => {
  it("takes the width and height it was given", () => {
    const { container } = render(<Skeleton w={120} h={14} />);
    const bar = container.querySelector(".cnp-skel") as HTMLElement;
    expect(bar.style.width).toBe("120px");
    expect(bar.style.height).toBe("14px");
  });

  it("passes a string width through, so a bar can track its column", () => {
    const { container } = render(<Skeleton w="62%" />);
    expect((container.firstChild as HTMLElement).style.width).toBe("62%");
  });

  it("rounds off when asked, for dots and pills", () => {
    const { container } = render(<Skeleton w={8} h={8} round />);
    const bar = container.firstChild as HTMLElement;
    expect(bar.className).toContain("is-round");
    expect(bar.style.borderRadius).toBe("999px");
  });
});

describe("a paragraph of placeholders", () => {
  it("draws one bar per line", () => {
    const { container } = render(<SkeletonText lines={4} />);
    expect(container.querySelectorAll(".cnp-skel")).toHaveLength(4);
  });

  it("stops the last line short, the way a paragraph does", () => {
    const { container } = render(<SkeletonText lines={3} />);
    const bars = [...container.querySelectorAll<HTMLElement>(".cnp-skel")];
    expect(bars.at(-1)!.style.width).toBe("58%");
    // …and the ones above it run long, so the block reads as prose rather
    // than as a table of even rows.
    expect(bars[0].style.width).not.toBe(bars.at(-1)!.style.width);
  });

  it("keeps the same widths across renders", () => {
    // The widths were nearly picked at random, which re-rolls them on every
    // render — a placeholder whose job is to stop things moving, jittering.
    const widths = () =>
      [...document.querySelectorAll<HTMLElement>(".cnp-skel")].map(
        (b) => b.style.width,
      );
    const { rerender } = render(<SkeletonText lines={5} />);
    const first = widths();
    rerender(<SkeletonText lines={5} />);
    expect(widths()).toEqual(first);
    expect(first).toHaveLength(5);
  });

  it("handles a single line without collapsing", () => {
    const { container } = render(<SkeletonText lines={1} />);
    expect(container.querySelectorAll(".cnp-skel")).toHaveLength(1);
  });
});

describe("naming what is loading", () => {
  it("announces the wait, since empty bars announce as nothing", () => {
    render(
      <SkeletonBox label="Loading the conversation">
        <SkeletonText lines={2} />
      </SkeletonBox>,
    );
    const box = screen.getByRole("status", { name: "Loading the conversation" });
    expect(box).toHaveAttribute("aria-busy", "true");
    expect(box.querySelectorAll(".cnp-skel")).toHaveLength(2);
  });

  it("still carries a caller's own class, so it can wear the real card", () => {
    // The description placeholder renders *as* .pr-description: the frame that
    // arrives is the frame that was already there.
    render(
      <SkeletonBox label="Loading the description" className="pr-description">
        <SkeletonText lines={2} />
      </SkeletonBox>,
    );
    expect(screen.getByRole("status")).toHaveClass("pr-description");
  });
});
