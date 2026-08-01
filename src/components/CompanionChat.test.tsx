// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { CompanionChat } from "./CompanionChat";
import type { CompanionState, CompanionTool } from "../companionSession";

// The answer's markdown is not what these tests are about, and the real one
// drags a parser and a sanitizer in with it.
vi.mock("./Markdown", () => ({
  Markdown: ({ text }: { text: string }) => <p>{text}</p>,
}));

const noop = () => {};

function state(tools: CompanionTool[], status: CompanionState["status"] = "working"): CompanionState {
  return {
    status,
    messages: [
      { id: "u1", who: "you", text: "explain this change to me" },
      { id: "a1", who: "ash", text: "", tools },
    ],
    error: null,
    cliName: "Claude Code",
    generation: 1,
  };
}

function mount(s: CompanionState, over: Partial<Parameters<typeof CompanionChat>[0]> = {}) {
  return render(
    <CompanionChat
      state={s}
      name="Ash"
      at={{ left: 0, top: 0, side: "right" }}
      width={352}
      height={380}
      expanded={false}
      onToggleExpand={noop}
      proposal={null}
      onAnswer={noop}
      onInstall={noop}
      onRetry={noop}
      onSend={noop}
      onClose={noop}
      {...over}
    />,
  );
}

const calls = (n: number): CompanionTool[] =>
  Array.from({ length: n }, (_, i) => ({
    name: i % 2 ? "Read" : "mcp__canopy__canopy_show_diff",
    detail: `/Users/shoaib/Documents/GitHub/canopy/src/file${i}.ts`,
  }));

describe("the tool trail", () => {
  it("is one row however many tools the turn ran", () => {
    // The bug it replaces: one chip per call, wrapped. A dozen calls — an
    // ordinary question — filled the whole 380px panel with
    // `mcp__canopy__canopy_…` and pushed the answer off the bottom.
    mount(state(calls(12)));
    expect(document.querySelectorAll(".companion-trail-row")).toHaveLength(1);
    expect(document.querySelectorAll(".companion-tool")).toHaveLength(0);
  });

  it("shows the call happening now, with a count of the ones before it", () => {
    mount(state(calls(12)));
    const row = document.querySelector(".companion-trail-row") as HTMLElement;
    // The last one is the live one — the trail updates in place rather than
    // growing downward.
    expect(row.querySelector(".companion-trail-name")?.textContent).toBe("Read");
    expect(row.querySelector(".companion-trail-count")?.textContent).toBe("+11");
  });

  it("says nothing about a count when there is only the one call", () => {
    mount(state(calls(1)));
    expect(document.querySelector(".companion-trail-count")).toBeNull();
  });

  it("keeps the whole list one click away", () => {
    // Collapsing is about the standing cost, not about hiding it: "which files
    // did it read" is a fair question, it is just not worth ten lines of panel
    // every turn.
    mount(state(calls(12)));
    const row = document.querySelector(".companion-trail-row") as HTMLElement;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll(".companion-trail-all .companion-tool")).toHaveLength(12);
    fireEvent.click(row);
    expect(document.querySelector(".companion-trail-all")).toBeNull();
  });

  it("marks the trail live only while the turn is still running", () => {
    const live = mount(state(calls(3), "working"));
    expect(document.querySelector(".companion-trail-mark-live")).toBeTruthy();
    live.unmount();
    mount(state(calls(3), "ready"));
    expect(document.querySelector(".companion-trail-mark-live")).toBeNull();
    expect(document.querySelector(".companion-trail-mark")).toBeTruthy();
  });

  it("shortens the names and paths that made the row unreadable", () => {
    mount(state([{ name: "mcp__canopy__canopy_show_diff", detail: "/Users/shoaib/Documents/GitHub/canopy/src/agentSessions.ts" }]));
    const row = document.querySelector(".companion-trail-row") as HTMLElement;
    expect(row.querySelector(".companion-trail-name")?.textContent).toBe("canopy_show_diff");
    const detail = row.querySelector(".companion-trail-detail")?.textContent ?? "";
    expect(detail).toContain("agentSessions.ts");
    expect(detail).not.toContain("/Users/shoaib");
  });
});

describe("the expand control", () => {
  it("sits beside esc and asks the host to grow the panel", () => {
    const onToggleExpand = vi.fn();
    mount(state(calls(2)), { onToggleExpand });
    const grow = document.querySelector(".companion-grow") as HTMLElement;
    expect(grow.getAttribute("aria-label")).toBe("Expand the panel");
    fireEvent.click(grow);
    expect(onToggleExpand).toHaveBeenCalled();
  });

  it("offers the way back once it is expanded", () => {
    mount(state(calls(2)), { expanded: true, width: 620, height: 660 });
    const grow = document.querySelector(".companion-grow") as HTMLElement;
    expect(grow.getAttribute("aria-label")).toBe("Shrink the panel");
    expect(grow.getAttribute("aria-pressed")).toBe("true");
    // Still a panel: the host's size is what it draws at, and the dialog is
    // still the dialog.
    const panel = document.querySelector(".companion-panel") as HTMLElement;
    expect(panel.style.width).toBe("620px");
    expect(panel.getAttribute("role")).toBe("dialog");
  });
});
