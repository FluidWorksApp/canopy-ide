import { describe, expect, it } from "vitest";
import { kindName, sortRows, symbolRows } from "./symbols";

describe("kindName", () => {
  it("names the wire numbers an agent can't read", () => {
    expect(kindName(12)).toBe("function");
    expect(kindName(5)).toBe("class");
    expect(kindName(23)).toBe("struct");
  });

  it("falls back rather than printing undefined", () => {
    expect(kindName(undefined)).toBe("symbol");
    expect(kindName(999)).toBe("symbol");
  });
});

describe("symbolRows", () => {
  it("reads workspace/symbol's flat SymbolInformation list", () => {
    const rows = symbolRows([
      {
        name: "handleFoo",
        kind: 12,
        containerName: "Widget",
        location: {
          uri: "file:///w/a.ts",
          range: { start: { line: 4, character: 2 }, end: { line: 4, character: 11 } },
        },
      },
    ]);
    expect(rows).toEqual([
      { path: "/w/a.ts", line: 5, name: "handleFoo", kind: "function", container: "Widget" },
    ]);
  });

  it("decodes a percent-escaped uri back to a path", () => {
    const rows = symbolRows([
      {
        name: "x",
        location: {
          uri: "file:///w/my%20dir/a.ts",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      },
    ]);
    expect(rows[0].path).toBe("/w/my dir/a.ts");
  });

  it("walks a DocumentSymbol tree so a class's methods survive it", () => {
    const range = (line: number) => ({
      start: { line, character: 0 },
      end: { line, character: 5 },
    });
    const rows = symbolRows(
      [
        {
          name: "Widget",
          kind: 5,
          range: range(0),
          selectionRange: range(0),
          children: [{ name: "render", kind: 6, range: range(3), selectionRange: range(3) }],
        },
      ],
      "/w/a.ts",
    );
    expect(rows).toEqual([
      { path: "/w/a.ts", line: 1, name: "Widget", kind: "class" },
      { path: "/w/a.ts", line: 4, name: "render", kind: "method", container: "Widget" },
    ]);
  });

  it("prefers the selection range — the name, not the whole body", () => {
    const rows = symbolRows(
      [
        {
          name: "f",
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
          selectionRange: { start: { line: 7, character: 9 }, end: { line: 7, character: 10 } },
        },
      ],
      "/w/a.ts",
    );
    expect(rows[0].line).toBe(8);
  });

  it("survives a server that answered nothing", () => {
    expect(symbolRows(null)).toEqual([]);
    expect(symbolRows([])).toEqual([]);
    expect(symbolRows([{ name: "broken" }])).toEqual([]);
  });
});

describe("sortRows", () => {
  it("groups by file then position, so a repeated query looks the same", () => {
    const row = (path: string, line: number) => ({ path, line, name: "x", kind: "function" });
    expect(sortRows([row("/b.ts", 2), row("/a.ts", 9), row("/a.ts", 1)])).toEqual([
      row("/a.ts", 1),
      row("/a.ts", 9),
      row("/b.ts", 2),
    ]);
  });
});
