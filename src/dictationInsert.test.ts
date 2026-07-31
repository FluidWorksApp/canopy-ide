import { describe, expect, it } from "vitest";
import {
  commonPrefixLen,
  liveInsertTarget,
  planFinalEdit,
  planLiveEdit,
} from "./dictationInsert";

/** Apply a planned edit to a plain string, so a test can follow a whole
 *  streaming session the way the field would see it. */
function apply(value: string, edit: { start: number; end: number; text: string }) {
  return value.slice(0, edit.start) + edit.text + value.slice(edit.end);
}

describe("commonPrefixLen", () => {
  it("counts shared leading characters", () => {
    expect(commonPrefixLen("recognise speech", "recognise beaches")).toBe(10);
    expect(commonPrefixLen("abc", "abc")).toBe(3);
    expect(commonPrefixLen("abc", "xyz")).toBe(0);
    expect(commonPrefixLen("", "abc")).toBe(0);
  });
});

describe("planLiveEdit", () => {
  it("appends when the hypothesis only grew", () => {
    const edit = planLiveEdit("hello there", 11, "there", "there friend")!;
    expect(edit).toEqual({ start: 11, end: 11, text: " friend" });
    expect(apply("hello there", edit)).toBe("hello there friend");
  });

  // The case the whole module exists for.
  it("rewrites only the revised tail when the decoder changes its mind", () => {
    const before = "I said recognise speech";
    const edit = planLiveEdit(before, before.length, "recognise speech", "recognise beaches")!;
    // "recognise " is kept; only the last word is retyped.
    expect(edit.start).toBe(before.length - "speech".length);
    expect(edit.end).toBe(before.length);
    expect(apply(before, edit)).toBe("I said recognise beaches");
  });

  it("deletes with no insertion when the hypothesis shrank", () => {
    const before = "one two three";
    const edit = planLiveEdit(before, before.length, "one two three", "one two")!;
    expect(edit.text).toBe("");
    expect(apply(before, edit)).toBe("one two");
  });

  it("preserves text the user had already typed before dictating", () => {
    const before = "note: hello wor";
    const edit = planLiveEdit(before, before.length, "hello wor", "hello world")!;
    expect(apply(before, edit)).toBe("note: hello world");
  });

  it("does nothing when the hypothesis is unchanged", () => {
    expect(planLiveEdit("abc def", 7, "def", "def")).toBeNull();
  });

  // Safety: never edit a field that no longer looks the way we left it.
  it("detaches when the user typed into our region", () => {
    expect(planLiveEdit("hello therX", 11, "there", "there friend")).toBeNull();
  });

  it("detaches when the caret moved away from our text", () => {
    expect(planLiveEdit("hello there", 5, "there", "there friend")).toBeNull();
  });

  it("detaches rather than running off the start of the field", () => {
    expect(planLiveEdit("hi", 2, "much longer than the field", "x")).toBeNull();
  });

  it("survives a full session of appends and revisions", () => {
    let value = "";
    let written = "";
    for (const next of ["so", "so the", "so the point", "so the pointy", "so the point is"]) {
      const edit = planLiveEdit(value, value.length, written, next);
      if (edit) {
        value = apply(value, edit);
        written = next;
      }
    }
    expect(value).toBe("so the point is");
  });
});

describe("planFinalEdit", () => {
  it("swaps the streamed region for the authoritative text", () => {
    const before = "note: so the point is";
    const edit = planFinalEdit(before, before.length, "so the point is", "So the point is.")!;
    expect(apply(before, edit)).toBe("note: So the point is.");
  });

  it("detaches when the region no longer matches, so nothing is clobbered", () => {
    expect(planFinalEdit("note: edited by hand", 20, "so the point is", "x")).toBeNull();
  });

  it("can replace an empty streamed region", () => {
    const edit = planFinalEdit("abc", 3, "", "hello")!;
    expect(apply("abc", edit)).toBe("abchello");
  });
});

describe("liveInsertTarget", () => {
  const el = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild;
  };

  it("accepts a plain textarea and text input", () => {
    expect(liveInsertTarget(el("<textarea></textarea>"))).toBeTruthy();
    expect(liveInsertTarget(el('<input type="text" />'))).toBeTruthy();
    expect(liveInsertTarget(el("<input />"))).toBeTruthy();
  });

  it("refuses the terminal's helper textarea", () => {
    expect(liveInsertTarget(el('<textarea class="xterm-helper-textarea"></textarea>'))).toBeNull();
  });

  it("refuses Monaco's hidden textarea", () => {
    const host = document.createElement("div");
    host.className = "monaco-editor";
    const ta = document.createElement("textarea");
    host.appendChild(ta);
    expect(liveInsertTarget(ta)).toBeNull();
  });

  it("refuses read-only, disabled and non-text controls", () => {
    expect(liveInsertTarget(el("<textarea readonly></textarea>"))).toBeNull();
    expect(liveInsertTarget(el("<textarea disabled></textarea>"))).toBeNull();
    expect(liveInsertTarget(el('<input type="checkbox" />'))).toBeNull();
    expect(liveInsertTarget(el('<input type="number" />'))).toBeNull();
  });

  it("refuses contenteditable and anything else", () => {
    expect(liveInsertTarget(el('<div contenteditable="true"></div>'))).toBeNull();
    expect(liveInsertTarget(null)).toBeNull();
  });
});
