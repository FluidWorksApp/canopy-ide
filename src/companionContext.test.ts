import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  companionSpotlight,
  setCompanionSpotlight,
  spotlightEnvelope,
  spotlightHint,
  subscribeSpotlight,
  type CompanionSpotlight,
} from "./companionContext";

const file = (over: Partial<CompanionSpotlight> = {}): CompanionSpotlight => ({
  project: "banana",
  tab: { kind: "file", path: "/GitHub/banana/src/App.tsx" },
  caret: { path: "/GitHub/banana/src/App.tsx", line: 120 },
  ...over,
});

beforeEach(() => {
  // Module state survives between tests; any publish overwrites, and the
  // publisher may then clear its own.
  setCompanionSpotlight("reset", file());
  setCompanionSpotlight("reset", null);
});

describe("who may publish and who may clear", () => {
  it("a background view's clear cannot blank what the visible one published", () => {
    // The failure this guards: every mounted ProjectView publishes on every
    // render, and the invisible ones publish null. Without the ownership rule
    // the last renderer wins, and the companion is told the user is looking
    // at nothing while a file sits plainly in front of them.
    setCompanionSpotlight("front", file());
    setCompanionSpotlight("other", null);
    expect(companionSpotlight()?.project).toBe("banana");
  });

  it("the owner's own clear does blank it", () => {
    setCompanionSpotlight("front", file());
    setCompanionSpotlight("front", null);
    expect(companionSpotlight()).toBeNull();
  });

  it("a new visible view takes over without the old one's consent", () => {
    // Switching project tabs: the newly visible view publishes before the old
    // one re-renders. Publishes are not ownership-guarded — only clears are.
    setCompanionSpotlight("front", file());
    setCompanionSpotlight("next", file({ project: "canopy" }));
    expect(companionSpotlight()?.project).toBe("canopy");
  });

  it("does not notify for a publish that changes nothing", () => {
    // Publishers run on every render; a subscriber re-rendering the chat
    // panel per render of an unrelated component would be its own perf bug.
    setCompanionSpotlight("front", file());
    const saw = vi.fn();
    const unsub = subscribeSpotlight(saw);
    setCompanionSpotlight("front", file());
    expect(saw).not.toHaveBeenCalled();
    setCompanionSpotlight("front", file({ caret: { path: "/GitHub/banana/src/App.tsx", line: 121 } }));
    expect(saw).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe("the envelope line", () => {
  it("names the project, the file and the caret line", () => {
    const line = spotlightEnvelope(file());
    expect(line).toContain('project "banana"');
    expect(line).toContain("/GitHub/banana/src/App.tsx");
    expect(line).toContain("caret at line 120");
  });

  it("says it is Canopy's, not the user's", () => {
    // The model has to be able to tell the envelope from the user's words in
    // a cold resumed transcript, where the brief may be turns away.
    expect(spotlightEnvelope(file())).toContain("not the user's words");
  });

  it("drops the caret when it sits in a file other than the front one", () => {
    const line = spotlightEnvelope(
      file({ caret: { path: "/GitHub/banana/src/other.ts", line: 3 } }),
    );
    expect(line).not.toContain("caret");
  });

  it("still names the project when the front tab has nothing nameable", () => {
    const line = spotlightEnvelope(file({ tab: { kind: "task-history" }, caret: null }));
    expect(line).toContain('project "banana"');
    expect(line).not.toContain("looking at");
  });

  it("describes a preview by its url and a terminal by its label", () => {
    expect(
      spotlightEnvelope(file({ tab: { kind: "preview", url: "http://localhost:3000" }, caret: null })),
    ).toContain("a browser preview of http://localhost:3000");
    expect(
      spotlightEnvelope(file({ tab: { kind: "run", label: "dev" }, caret: null })),
    ).toContain('the run "dev"');
  });
});

describe("the hint chip", () => {
  it("is the basename and line, not the whole path — it lives in a 350px panel", () => {
    expect(spotlightHint(file())).toBe("banana · App.tsx:120");
  });

  it("falls back to the project alone", () => {
    expect(spotlightHint(file({ tab: null, caret: null }))).toBe("banana");
  });

  it("shortens a long preview url", () => {
    const hint = spotlightHint(
      file({
        tab: { kind: "preview", url: "http://localhost:3000/some/very/long/path/that/overflows" },
        caret: null,
      }),
    );
    expect(hint.startsWith("banana · localhost:3000")).toBe(true);
    expect(hint.length).toBeLessThanOrEqual("banana · ".length + 28);
  });
});
