// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { NotificationCenter } from "./NotificationCenter";
import { attentionItems, postAttention, type AttentionItem } from "../attention";

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "i1",
  kind: "fyi",
  tone: "info",
  title: "Something happened",
  source: "app",
  ts: Date.now(),
  readAt: 1,
  ...over,
});

const show = (items: AttentionItem[], onFollow = () => {}) =>
  render(
    <NotificationCenter items={items} onFollow={onFollow} onClose={() => {}} />,
  );

beforeEach(() => {
  localStorage.clear();
});

describe("NotificationCenter", () => {
  it("separates work still waiting from history", () => {
    // Merging them by timestamp would bury a stalled project under an
    // afternoon of successful builds — the exact failure this exists to fix.
    const { container } = show([
      item({ id: "a", title: "Build finished", ts: 900 }),
      item({ id: "b", kind: "question", title: "Switch branch?", ts: 100 }),
    ]);
    const sections = [...container.querySelectorAll(".notif-section")].map(
      (s) => s.textContent,
    );
    expect(sections).toEqual(["Waiting on you", "Earlier"]);
    const first = container.querySelector(".notif-row");
    expect(first?.textContent).toContain("Switch branch?");
  });

  it("orders waiting questions oldest first", () => {
    const { container } = show([
      item({ id: "a", kind: "question", title: "newer", ts: 900 }),
      item({ id: "b", kind: "question", title: "older", ts: 100 }),
    ]);
    const titles = [...container.querySelectorAll(".notif-title")].map(
      (t) => t.textContent,
    );
    expect(titles).toEqual(["older", "newer"]);
  });

  it("names the project an item came from", () => {
    const { container } = show([item({ projectName: "api" })]);
    expect(container.querySelector(".notif-project")?.textContent).toBe("api");
  });

  it("follows a row's deep link on click", () => {
    const onFollow = vi.fn();
    const target = item({ where: { kind: "panel", panel: "tasks" } });
    const { container } = show([target], onFollow);
    fireEvent.click(container.querySelector(".notif-row")!);
    expect(onFollow).toHaveBeenCalledWith(target);
  });

  it("offers no click for an item with nowhere to go", () => {
    // A click that lands nowhere is worse than one that isn't offered.
    const onFollow = vi.fn();
    const { container } = show([item()], onFollow);
    const row = container.querySelector(".notif-row")!;
    expect(row.getAttribute("role")).toBeNull();
    fireEvent.click(row);
    expect(onFollow).not.toHaveBeenCalled();
  });

  it("marks everything read on open, without resolving a question", () => {
    postAttention({
      kind: "question",
      tone: "info",
      title: "Waiting",
      source: "agent",
    });
    postAttention({ kind: "fyi", tone: "info", title: "FYI", source: "app" });
    expect(attentionItems().every((x) => x.readAt == null)).toBe(true);
    show(attentionItems());
    const after = attentionItems();
    expect(after.every((x) => x.readAt != null)).toBe(true);
    // Looking at a question is not answering it.
    expect(after.find((x) => x.kind === "question")?.resolvedAt).toBeUndefined();
  });

  it("says so when a question stopped being needed", () => {
    const { container } = show([
      item({ kind: "question", resolvedAt: 5, resolution: "withdrawn" }),
    ]);
    expect(container.querySelector(".notif-resolved")?.textContent).toBe(
      "No longer needed",
    );
  });

  it("has something to say when nothing has happened", () => {
    const { container } = show([]);
    expect(container.querySelector(".notif-empty")).not.toBeNull();
  });
});
