import { describe, expect, it } from "vitest";
import {
  COMPOSER_MAX_ROWS,
  PROMPT_CHARS,
  PROMPT_WORDS,
  attachmentLabel,
  briefWithAttachments,
  composerRows,
  isPrompt,
  pastedImages,
  type SpotAttachment,
} from "./spotCompose";

const shot = (n: number): SpotAttachment => ({
  path: `/repo/.canopy/spot/ctx-17852932${n}.png`,
  thumb: "data:image/png;base64,AAA",
});

describe("isPrompt", () => {
  it("leaves a real search alone", () => {
    // The searches people actually type. Every one of these must stay a search:
    // switching on them would hide the results they were aimed at.
    for (const q of ["prview", "max canon", "browser watchdog", "spotSaveContextImage"]) {
      expect(isPrompt(q)).toBe(false);
    }
  });

  it("switches on a sentence that is under the character threshold", () => {
    // 77 characters — short enough that a length check alone calls it a search,
    // and unmistakably an instruction. This is why words are counted too.
    const sentence = "the PR tab flickers when the diff is wide, look at PrView.tsx and fix it";
    expect(sentence.length).toBeLessThan(PROMPT_CHARS);
    expect(isPrompt(sentence)).toBe(true);
  });

  it("leaves a long path a search — it is one word however long", () => {
    expect(isPrompt("src/components/ProjectView/helpers.ts")).toBe(false);
  });

  it("switches on a line break, however short", () => {
    expect(isPrompt("fix this:\n- the thing")).toBe(true);
  });

  it("switches on a pasted image, whatever the text says", () => {
    expect(isPrompt("", 1)).toBe(true);
    expect(isPrompt("prview", 1)).toBe(true);
  });

  it("measures the trimmed text", () => {
    expect(isPrompt(`${" ".repeat(200)}prview${" ".repeat(200)}`)).toBe(false);
  });

  it("holds both boundaries", () => {
    expect(isPrompt("x".repeat(PROMPT_CHARS))).toBe(false);
    expect(isPrompt("x".repeat(PROMPT_CHARS + 1))).toBe(true);
    expect(isPrompt("w ".repeat(PROMPT_WORDS - 1))).toBe(false);
    expect(isPrompt("w ".repeat(PROMPT_WORDS))).toBe(true);
  });
});

describe("briefWithAttachments", () => {
  it("passes plain text straight through", () => {
    expect(briefWithAttachments("  fix the flicker  ", [])).toBe("fix the flicker");
  });

  it("names the file and says to open it", () => {
    const brief = briefWithAttachments("why does this look wrong?", [shot(1)]);
    expect(brief).toContain("why does this look wrong?");
    expect(brief).toContain("/repo/.canopy/spot/ctx-178529321.png");
    expect(brief).toContain("open them with your file tools");
  });

  it("names every one of them", () => {
    const brief = briefWithAttachments("compare these", [shot(1), shot(2)]);
    expect(brief).toContain("ctx-178529321.png");
    expect(brief).toContain("ctx-178529322.png");
    expect(brief).toContain("images at");
  });

  it("stands on its own when the image is the whole message", () => {
    // Paste and press Enter with nothing typed: the brief still has to be an
    // instruction, not a bare path.
    const brief = briefWithAttachments("", [shot(1)]);
    expect(brief).toContain("ctx-178529321.png");
    expect(brief).toMatch(/tell me what you see/);
  });
});

describe("attachmentLabel", () => {
  it("is the file name", () => {
    expect(attachmentLabel("/repo/.canopy/spot/ctx-1.png")).toBe("ctx-1.png");
  });
});

describe("pastedImages", () => {
  const data = (items: { kind: string; type: string; file?: File }[]) =>
    ({ items: items.map((i) => ({ ...i, getAsFile: () => i.file ?? null })) }) as unknown as DataTransfer;

  it("finds nothing on a plain text paste", () => {
    expect(pastedImages(data([{ kind: "string", type: "text/plain" }]))).toEqual([]);
  });

  it("takes the images and leaves the rest", () => {
    const png = new File([], "a.png", { type: "image/png" });
    expect(
      pastedImages(data([{ kind: "string", type: "text/plain" }, { kind: "file", type: "image/png", file: png }])),
    ).toEqual([png]);
  });

  it("ignores a non-image file", () => {
    const pdf = new File([], "a.pdf", { type: "application/pdf" });
    expect(pastedImages(data([{ kind: "file", type: "application/pdf", file: pdf }]))).toEqual([]);
  });

  it("survives an empty clipboard", () => {
    expect(pastedImages(null)).toEqual([]);
  });
});

describe("composerRows", () => {
  it("is one line for a search", () => {
    expect(composerRows("prview")).toBe(1);
  });

  it("counts hard line breaks", () => {
    expect(composerRows("a\nb\nc")).toBe(3);
  });

  it("counts wrapped lines, so a pasted paragraph is not hidden", () => {
    expect(composerRows("x".repeat(240), 60)).toBe(4);
  });

  it("stops growing before it eats the results", () => {
    expect(composerRows("x\n".repeat(100))).toBe(COMPOSER_MAX_ROWS);
  });
});
