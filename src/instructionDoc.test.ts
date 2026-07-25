import { describe, expect, it } from "vitest";
import {
  parseDoc,
  parseFrontmatter,
  serializeDoc,
  setFrontmatterField,
} from "./instructionDoc";

/** Real shapes these files come in — the round-trip has to hold for all of them. */
const FIXTURES: Record<string, string> = {
  empty: "",
  noHeadings: "Just a paragraph with no structure at all.\n",
  titleOnly: "# My Project\n\nSome intro prose.\n",
  typical:
    "# Canopy\n\nAn IDE for agents.\n\n## Commands\n\n- `npm test` runs the suite\n- `npm run lint` checks style\n\n## Conventions\n\nPrefer small functions.\n",
  frontmatter:
    "---\nname: security-review\ndescription: Review a diff for security problems\n---\n\n## When to use\n\nOn any diff touching auth.\n",
  codeFence:
    "## Setup\n\n```sh\n## not a heading\ncd app && npm i\n```\n\n## Notes\n\nDone.\n",
  crlf: "# Title\r\n\r\n## One\r\n\r\n- a\r\n- b\r\n",
  noTrailingNewline: "## Rules\n\n- always test",
  deepHeadings: "## A\n\n### A.1\n\ntext\n\n#### A.1.1\n\nmore\n\n## B\n\nend\n",
  hrNotFrontmatter: "---\n\nThis file opens with a horizontal rule, unclosed.\n",
  duplicateHeadings: "## Notes\n\nfirst\n\n## Notes\n\nsecond\n",
  blankHeadingBody: "## Empty\n\n## Next\n\ncontent\n",
};

describe("round trip", () => {
  // The invariant the whole structured editor rests on: if you change nothing,
  // nothing changes. Without this, opening a file would rewrite it.
  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`re-emits ${name} byte for byte`, () => {
      expect(serializeDoc(parseDoc(text))).toBe(text);
    });
  }

  it("holds for a document that is only frontmatter", () => {
    const t = "---\nname: x\n---\n";
    expect(serializeDoc(parseDoc(t))).toBe(t);
  });
});

describe("parseDoc", () => {
  it("splits on ## and keeps the title in the preamble", () => {
    const doc = parseDoc(FIXTURES.typical);
    expect(doc.preamble).toBe("# Canopy\n\nAn IDE for agents.\n\n");
    expect(doc.sections.map((s) => s.heading)).toEqual(["Commands", "Conventions"]);
    expect(doc.sections[0].level).toBe(2);
  });

  it("pulls out frontmatter with its fences", () => {
    const doc = parseDoc(FIXTURES.frontmatter);
    expect(doc.frontmatter).toBe(
      "---\nname: security-review\ndescription: Review a diff for security problems\n---\n",
    );
    expect(doc.sections).toHaveLength(1);
  });

  // A shell snippet full of `## comments` is content. Treating it as structure
  // would cut the code block in half and the round trip would be the only thing
  // saving the file.
  it("ignores headings inside a fenced code block", () => {
    const doc = parseDoc(FIXTURES.codeFence);
    expect(doc.sections.map((s) => s.heading)).toEqual(["Setup", "Notes"]);
    expect(doc.sections[0].raw).toContain("## not a heading");
  });

  it("treats an unclosed --- as a horizontal rule, not frontmatter", () => {
    expect(parseDoc(FIXTURES.hrNotFrontmatter).frontmatter).toBeNull();
  });

  it("nests deeper headings under their own sections", () => {
    const doc = parseDoc(FIXTURES.deepHeadings);
    expect(doc.sections.map((s) => `${s.level}:${s.heading}`)).toEqual([
      "2:A",
      "3:A.1",
      "4:A.1.1",
      "2:B",
    ]);
  });

  it("gives sections distinct ids even when headings repeat", () => {
    const doc = parseDoc(FIXTURES.duplicateHeadings);
    expect(new Set(doc.sections.map((s) => s.id)).size).toBe(2);
  });

  it("trims blank lines off the body but leaves the interior", () => {
    const doc = parseDoc("## X\n\nfirst\n\nsecond\n\n");
    expect(doc.sections[0].body).toBe("first\n\nsecond");
  });
});

describe("bullet sections", () => {
  it("reads a pure bullet list as items", () => {
    const doc = parseDoc(FIXTURES.typical);
    expect(doc.sections[0].items).toEqual([
      "`npm test` runs the suite",
      "`npm run lint` checks style",
    ]);
  });

  it("leaves prose as prose", () => {
    expect(parseDoc(FIXTURES.typical).sections[1].items).toBeUndefined();
  });

  // Indented bullets are nesting or continuations — flattening them to a list
  // would silently drop the structure on the next save.
  it("declines a list with nested bullets", () => {
    const doc = parseDoc("## X\n\n- top\n  - nested\n");
    expect(doc.sections[0].items).toBeUndefined();
  });

  it("declines a list with a paragraph mixed in", () => {
    const doc = parseDoc("## X\n\n- one\n\nSome prose.\n\n- two\n");
    expect(doc.sections[0].items).toBeUndefined();
  });
});

describe("editing", () => {
  it("rewrites only the section marked dirty", () => {
    const doc = parseDoc(FIXTURES.typical);
    doc.sections[0].items = ["`npm test` runs the suite", "`npm run build` compiles"];
    doc.sections[0].dirty = true;
    const out = serializeDoc(doc);
    // The edit landed…
    expect(out).toContain("- `npm run build` compiles\n");
    // …and the untouched half is character-for-character what it was.
    expect(out).toContain("## Conventions\n\nPrefer small functions.\n");
    expect(out.startsWith("# Canopy\n\nAn IDE for agents.\n\n")).toBe(true);
  });

  it("drops an item without touching its neighbours", () => {
    const doc = parseDoc(FIXTURES.typical);
    doc.sections[0].items = doc.sections[0].items?.slice(0, 1);
    doc.sections[0].dirty = true;
    const out = serializeDoc(doc);
    expect(out).not.toContain("npm run lint");
    expect(out).toContain("- `npm test` runs the suite\n");
  });

  it("renames a heading", () => {
    const doc = parseDoc(FIXTURES.typical);
    doc.sections[1].heading = "House style";
    doc.sections[1].dirty = true;
    expect(serializeDoc(doc)).toContain("## House style\n\nPrefer small functions.\n");
  });

  it("writes an added section as ordinary markdown", () => {
    const doc = parseDoc(FIXTURES.typical);
    doc.sections.push({
      id: "new",
      level: 2,
      heading: "Testing",
      raw: "",
      body: "Run the suite before pushing.",
      dirty: true,
    });
    expect(serializeDoc(doc)).toContain("## Testing\n\nRun the suite before pushing.\n");
  });

  it("emits a section with an empty body as just its heading", () => {
    const doc = parseDoc(FIXTURES.typical);
    doc.sections[1].body = "";
    doc.sections[1].dirty = true;
    expect(serializeDoc(doc).endsWith("## Conventions\n\n")).toBe(true);
  });

  it("skips blank items rather than writing empty bullets", () => {
    const doc = parseDoc(FIXTURES.typical);
    doc.sections[0].items = ["kept", "   ", ""];
    doc.sections[0].dirty = true;
    expect(serializeDoc(doc)).toContain("## Commands\n\n- kept\n\n");
  });
});

describe("frontmatter fields", () => {
  it("reads plain key: value pairs, unquoted", () => {
    const fm = '---\nname: caveman\ndescription: "Speak plainly"\n---\n';
    expect(parseFrontmatter(fm).map((f) => [f.key, f.value])).toEqual([
      ["name", "caveman"],
      ["description", "Speak plainly"],
    ]);
  });

  it("keeps anything that isn't a scalar field verbatim", () => {
    const fm = "---\nname: x\ntools:\n  - Read\n  - Edit\n---\n";
    const fields = parseFrontmatter(fm);
    expect(fields.filter((f) => f.key === "").map((f) => f.raw)).toEqual([
      "  - Read",
      "  - Edit",
    ]);
  });

  it("sets a field without disturbing its neighbours", () => {
    const fm = "---\nname: x\ntools:\n  - Read\n---\n";
    const out = setFrontmatterField(fm, "name", "y");
    expect(out).toBe("---\nname: y\ntools:\n  - Read\n---\n");
  });

  it("appends a key that wasn't there", () => {
    const out = setFrontmatterField("---\nname: x\n---\n", "description", "does a thing");
    expect(out).toBe("---\nname: x\ndescription: does a thing\n---\n");
  });

  it("creates the block for a file that had none", () => {
    expect(setFrontmatterField(null, "name", "fresh")).toBe("---\nname: fresh\n---\n");
  });

  it("leaves a simple value unquoted", () => {
    expect(setFrontmatterField(null, "name", "code-reviewer")).toBe(
      "---\nname: code-reviewer\n---\n",
    );
  });

  it("quotes a value that would change meaning as YAML", () => {
    expect(setFrontmatterField(null, "description", "a: b #c")).toBe(
      '---\ndescription: "a: b #c"\n---\n',
    );
  });
});
