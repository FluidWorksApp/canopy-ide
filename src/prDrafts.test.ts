import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ignorePrFindings,
  ignoredPrFindings,
  loadPrDraft,
  savePrDraft,
} from "./prDrafts";

describe("PR review drafts", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps each PR's body and inline comments separate", () => {
    const comment = {
      id: "draft-1",
      path: "src/a.ts",
      line: 4,
      side: "RIGHT" as const,
      body: "Guard the empty case.",
      blocking: true,
    };
    savePrDraft("/repo", 1, { body: "Review body", comments: [comment] });

    expect(loadPrDraft("/repo", 1)).toEqual({
      body: "Review body",
      comments: [comment],
    });
    expect(loadPrDraft("/repo", 2)).toEqual({ body: "", comments: [] });
  });

  it("remembers rejected agent findings without retaining typed comments", () => {
    ignorePrFindings("/repo", 1, ["src/a.ts:4:wrong", "src/a.ts:4:wrong"]);
    savePrDraft("/repo", 1, { body: "", comments: [] });

    expect(ignoredPrFindings("/repo", 1)).toEqual(
      new Set(["src/a.ts:4:wrong"]),
    );
    expect(loadPrDraft("/repo", 1)).toEqual({ body: "", comments: [] });
  });

  it("treats corrupt storage and quota failures as an empty optional cache", () => {
    localStorage.setItem("canopy.prDraftReviews", "not json");
    expect(loadPrDraft("/repo", 1)).toEqual({ body: "", comments: [] });

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() =>
      savePrDraft("/repo", 1, { body: "still usable", comments: [] }),
    ).not.toThrow();
  });
});
