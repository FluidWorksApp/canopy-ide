import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("terminal idle-compaction wiring", () => {
  const source = readFileSync("src/components/Term.tsx", "utf8");

  it("uses a parser barrier and full-state serializer before clearing cells", () => {
    const start = source.indexOf("new TerminalCompactionController");
    const end = source.indexOf("// No WebGL renderer", start);
    const setup = source.slice(start, end);
    expect(setup).toContain('drain: (done) => term.write("", done)');
    expect(setup).toContain("serializer.serialize({ scrollback: settings.scrollback })");
    expect(setup.indexOf("serialize:")).toBeLessThan(setup.indexOf("term.reset()"));
    expect(setup.indexOf("term.reset()")).toBeLessThan(setup.indexOf("term.clear()"));
    expect(setup).toContain("term.scrollToLine(");
  });

  it("finishes VT restoration before attaching native replay", () => {
    const start = source.indexOf("streamVisibilityRef.current =");
    const end = source.indexOf("const start = async", start);
    const visibility = source.slice(start, end);
    expect(visibility).toContain("await compaction.show()");
    expect(visibility.indexOf("await compaction.show()")).toBeLessThan(
      visibility.indexOf("await attachViewer()"),
    );
    expect(visibility.indexOf("detachViewer()")).toBeLessThan(
      visibility.indexOf("compaction.hide()"),
    );
  });
});
