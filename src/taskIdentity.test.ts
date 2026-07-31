import { describe, expect, it } from "vitest";
import {
  askedLine,
  hasIdentity,
  identityPatch,
  MAX_TAGS,
  taskGlyph,
  taskIdentity,
  taskTags,
  taskTitle,
} from "./taskIdentity";

describe("taskTitle", () => {
  it("flattens a title an agent wrapped across lines", () => {
    expect(taskTitle("Task identity,\n  in the harness")).toBe(
      "Task identity, in the harness",
    );
  });

  it("clamps a title that is a paragraph, cutting on a word", () => {
    const long =
      "Add icon title and tags to the micro task harness and also record the transcript";
    const cut = taskTitle(long) as string;
    expect(cut.length).toBeLessThanOrEqual(49);
    expect(cut.endsWith("…")).toBe(true);
    // Cut on a word, not mid-word: no trailing fragment before the ellipsis.
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut).not.toMatch(/ …$/);
  });

  it("is nothing at all for a non-string or an empty one", () => {
    expect(taskTitle(undefined)).toBeUndefined();
    expect(taskTitle(42)).toBeUndefined();
    expect(taskTitle("   ")).toBeUndefined();
  });
});

describe("taskGlyph", () => {
  it("takes a single Unicode symbol", () => {
    expect(taskGlyph("◎")).toBe("◎");
    expect(taskGlyph(" ⚒ ")).toBe("⚒");
  });

  it("keeps only the first glyph when an agent sends several", () => {
    expect(taskGlyph("◎⚒⇈")).toBe("◎");
  });

  /** An emoji is several code points; slicing anywhere but the cluster
   *  boundary renders as a mojibake box. */
  it("keeps a multi-code-point emoji whole", () => {
    expect(taskGlyph("👍🏽 done")).toBe("👍🏽");
  });

  it("refuses the things an agent reaches for when it has no glyph", () => {
    expect(taskGlyph("PR")).toBeUndefined();
    expect(taskGlyph("7")).toBeUndefined();
    expect(taskGlyph("*")).toBeUndefined();
    expect(taskGlyph("#review")).toBeUndefined();
    expect(taskGlyph(":rocket:")).toBeUndefined();
    expect(taskGlyph("")).toBeUndefined();
    expect(taskGlyph(["◎"])).toBeUndefined();
  });
});

describe("taskTags", () => {
  it("trims, drops the hash, and dedupes case-insensitively", () => {
    expect(taskTags(["#Review", " review ", "rust"])).toEqual([
      "Review",
      "rust",
    ]);
  });

  it("caps the count so a row can never wrap", () => {
    expect(taskTags(["a", "b", "c", "d", "e", "f"])).toHaveLength(MAX_TAGS);
  });

  it("clamps a tag that is a sentence", () => {
    const [tag] = taskTags([
      "this tag is an entire sentence about the work",
    ]) as string[];
    expect(tag.length).toBeLessThanOrEqual(21);
  });

  it("is nothing for a non-array, or an array with nothing usable in it", () => {
    expect(taskTags("review")).toBeUndefined();
    expect(taskTags([])).toBeUndefined();
    expect(taskTags([" ", 3, null])).toBeUndefined();
  });
});

describe("taskIdentity", () => {
  it("keeps only the fields the agent actually said something about", () => {
    expect(taskIdentity({ title: "Fix the flaky PTY test" })).toEqual({
      title: "Fix the flaky PTY test",
    });
    // A rejected icon must not leave an `icon: undefined` in the patch: the
    // history merges patches with a spread, and that would blank a good glyph
    // recorded by an earlier canopy_name_task call.
    expect(Object.keys(taskIdentity({ title: "x", icon: "PR" }))).toEqual([
      "title",
    ]);
  });

  it("survives an agent sending junk in every field", () => {
    expect(taskIdentity({ title: 1, icon: {}, tags: "review" })).toEqual({});
  });
});

describe("hasIdentity", () => {
  it("is false for a naming call that said nothing usable", () => {
    expect(hasIdentity({})).toBe(false);
    expect(hasIdentity({ tags: [] })).toBe(false);
    expect(hasIdentity({ icon: "◎" })).toBe(true);
  });
});

describe("askedLine", () => {
  it("flattens the restatement to one line", () => {
    expect(askedLine("Add icon and title\nto tasks")).toBe(
      "Add icon and title to tasks",
    );
  });

  it("clamps a restatement that turned into an essay", () => {
    const line = askedLine("word ".repeat(200)) as string;
    expect(line.length).toBeLessThanOrEqual(241);
  });

  it("is nothing when the agent sent nothing", () => {
    expect(askedLine(undefined)).toBeUndefined();
    expect(askedLine("  ")).toBeUndefined();
  });
});

describe("identityPatch", () => {
  /** The history merges a patch with a spread, so a field that is present and
   *  undefined blanks what is there. A second naming that says less than the
   *  first must not erase the first. */
  it("carries only what the agent said, so a later call can't blank an earlier one", () => {
    expect(identityPatch({ icon: "◈" })).toEqual({ agentIcon: "◈" });
    expect("title" in identityPatch({ icon: "◈" })).toBe(false);
    expect(identityPatch({ title: "Naming runs", tags: ["tasks"] })).toEqual({
      title: "Naming runs",
      tags: ["tasks"],
    });
    expect(identityPatch({})).toEqual({});
  });

  it("puts the agent's glyph somewhere the task's own icon isn't", () => {
    // `icon` on a run is what the task was launched with; the agent's pick is
    // recorded beside it so both survive.
    expect(identityPatch({ icon: "◈" }).agentIcon).toBe("◈");
  });
});
