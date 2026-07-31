import { describe, expect, it } from "vitest";
import { resolveWikilink, type WikilinkCandidates } from "./wikilinks";

const note = (id: string, title: string) =>
  ({ id, title }) as WikilinkCandidates["notes"][number];
const research = (id: string, title: string) =>
  ({ id, title }) as WikilinkCandidates["research"][number];

const candidates = (over: Partial<WikilinkCandidates> = {}): WikilinkCandidates => ({
  notes: [note("0007-tier-donations", "Tier donations by amount")],
  research: [research("0012-index-staleness", "Index staleness")],
  files: ["/repo/src/PrView.tsx", "/repo/src/components/helpers.ts"],
  ...over,
});

describe("resolveWikilink", () => {
  it("resolves an id, which is what survives a rename", () => {
    expect(resolveWikilink("0007-tier-donations", candidates())).toEqual({
      kind: "note",
      id: "0007-tier-donations",
      title: "Tier donations by amount",
    });
    expect(resolveWikilink("0012-index-staleness", candidates())).toMatchObject({
      kind: "research",
    });
  });

  it("resolves a title, which is what people actually type", () => {
    expect(resolveWikilink("tier donations BY AMOUNT", candidates())).toMatchObject({
      kind: "note",
      id: "0007-tier-donations",
    });
  });

  it("prefers a note over research and a file of the same name", () => {
    // A link in a scratchpad is overwhelmingly about another thought.
    const c = candidates({
      notes: [note("0001-helpers", "helpers")],
      research: [research("0002-helpers", "helpers")],
    });
    expect(resolveWikilink("helpers", c)).toMatchObject({ kind: "note" });
  });

  it("resolves a file by name, path suffix or stem", () => {
    expect(resolveWikilink("PrView.tsx", candidates())).toEqual({
      kind: "file",
      path: "/repo/src/PrView.tsx",
    });
    expect(resolveWikilink("src/components/helpers.ts", candidates())).toMatchObject({
      kind: "file",
      path: "/repo/src/components/helpers.ts",
    });
    expect(resolveWikilink("PrView", candidates())).toMatchObject({ kind: "file" });
  });

  it("refuses to guess when a filename is ambiguous", () => {
    // Nine `helpers.ts` in a repo is normal. Picking the first is worse than
    // not resolving, because it looks like it worked.
    const c = candidates({
      files: ["/repo/a/helpers.ts", "/repo/b/helpers.ts"],
    });
    expect(resolveWikilink("helpers.ts", c)).toEqual({
      kind: "new",
      title: "helpers.ts",
    });
    // …but a path that names one of them is not ambiguous.
    expect(resolveWikilink("a/helpers.ts", c)).toMatchObject({
      kind: "file",
      path: "/repo/a/helpers.ts",
    });
  });

  it("treats an unknown target as a note not written yet", () => {
    // Obsidian's behaviour, and the reason wikilinks are worth having: linking
    // to a thought is how you record it before you have written it.
    expect(resolveWikilink("something new", candidates())).toEqual({
      kind: "new",
      title: "something new",
    });
  });

  it("does not mistake an id-shaped string for one that exists", () => {
    expect(resolveWikilink("9999-nope", candidates())).toMatchObject({
      kind: "new",
    });
  });
});
