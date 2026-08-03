import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { CommentComposer, sameJson, sameMap, workspaceLifeDigest } from "./AgentWorkspaceView";
import { agentLife } from "../../shared/agentLife";
import { resolve } from "../shortcuts";

// The submit chord as this platform actually spells it: ⌘⏎ on a Mac, Ctrl+⏎
// under the test runner. Spelling it by hand passed everywhere only because
// the handler used to accept either modifier, which is the bug the registry
// exists to prevent.
const submit = resolve("submit")!;
const submitKey = {
  key: "Enter",
  code: "Enter",
  metaKey: submit.meta,
  ctrlKey: submit.ctrl,
};

// The composer lives inside a DiffView that rebuilds whenever the agent under
// review touches a file — which, while you are writing a comment about that
// agent's work, is constantly. These cover the two halves of not losing the
// comment: the parent owns the draft, and a poll that changed nothing doesn't
// hand the diff a new identity in the first place.

// A stand-in for the workspace's own draft bookkeeping: the harness holds the
// text, the composer only renders it.
function Harness({ mounted, onAdd }: { mounted: boolean; onAdd?: (body: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const key = "diff:new:12";
  return (
    <div>
      <span data-testid="draft">{drafts[key] ?? ""}</span>
      {mounted && (
        <CommentComposer
          text={drafts[key] ?? ""}
          onText={(v) => setDrafts((p) => ({ ...p, [key]: v }))}
          onAdd={(body) => onAdd?.(body)}
          onCancel={() => setDrafts((p) => ({ ...p, [key]: "" }))}
        />
      )}
    </div>
  );
}

describe("comment composer drafts", () => {
  it("survives the diff underneath it rebuilding mid-sentence", () => {
    const { rerender } = render(<Harness mounted />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "this leaks the token" },
    });

    // The agent writes a file, the pane re-renders, the widget goes away.
    rerender(<Harness mounted={false} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("draft").textContent).toBe("this leaks the token");

    // Reopening the composer on that line finds the sentence still there.
    rerender(<Harness mounted />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "this leaks the token",
    );
  });

  it("adds on the submit chord and treats an empty body as a cancel", () => {
    const onAdd = vi.fn();
    render(<Harness mounted onAdd={onAdd} />);
    const box = screen.getByRole("textbox");

    fireEvent.keyDown(box, submitKey);
    expect(onAdd).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: "  needs a test  " } });
    fireEvent.keyDown(box, submitKey);
    expect(onAdd).toHaveBeenCalledWith("needs a test");
  });
});

describe("the digest handed to the lifecycle ladder", () => {
  // The view rebuilds a digest out of the workspace join and the one the tab
  // opened with. The ladder decides `digestUsable` off `store` and `foreign`
  // as well as the state fields, so dropping them in transit turned "no
  // lifecycle was ever recorded" into a confident verdict.
  const now = Math.floor(Date.now() / 1000);

  it("keeps the store flag, so a store-only digest reads unknown — not a real state", () => {
    const life = agentLife({
      digest: workspaceLifeDigest(null, {
        session_id: "s-1",
        agent: "claude",
        state: "idle",
        state_via: "turn-boundary",
        updated: now - 10,
        store: true,
      }) as never,
      now,
    });
    expect(life.state).toBe("unknown");
    expect(life.reason).toBe("store-only");
  });

  it("keeps the foreign flag, so another launch's digest is not trusted", () => {
    const life = agentLife({
      digest: workspaceLifeDigest(null, {
        session_id: "s-1",
        agent: "claude",
        state: "working",
        state_via: "tool-activity",
        updated: now - 10,
        foreign: true,
      }) as never,
      now,
    });
    expect(life.state).toBe("unknown");
    expect(life.reason).toBe("foreign-instance");
  });

  it("still believes an honest hook digest, workspace fields first", () => {
    const life = agentLife({
      digest: workspaceLifeDigest(
        { state: "working", state_via: "tool-activity", updated: now - 10 },
        { session_id: "s-1", agent: "claude", state: "idle", updated: now - 900 },
      ) as never,
      now,
    });
    expect(life.state).toBe("working");
  });
});

describe("poll comparisons", () => {
  it("recognizes an unchanged journal, so the diff keeps its identity", () => {
    const prev = [{ path: "a.rs", present: true }];
    expect(sameJson(prev, [{ path: "a.rs", present: true }])).toBe(true);
    expect(sameJson(prev, [{ path: "a.rs", present: false }])).toBe(false);
    expect(sameJson(prev, [...prev, { path: "b.rs", present: true }])).toBe(false);
  });

  it("compares file contents by value, not by map identity", () => {
    const prev = new Map([["a.rs", "fn main() {}"]]);
    expect(sameMap(prev, new Map([["a.rs", "fn main() {}"]]))).toBe(true);
    expect(sameMap(prev, new Map([["a.rs", "fn main() { todo!() }"]]))).toBe(false);
    expect(sameMap(prev, new Map())).toBe(false);
    expect(
      sameMap(prev, new Map([["a.rs", "fn main() {}"], ["b.rs", ""]])),
    ).toBe(false);
  });
});
