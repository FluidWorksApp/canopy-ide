import { describe, expect, it, vi } from "vitest";
import { changedIdentifiers, referenceFiles, type LspAccess, type TextSearch } from "./symbols";

describe("changedIdentifiers", () => {
  it("lists renamed-away exports first, then the rest, across languages", () => {
    const out = changedIdentifiers([
      { path: "src/pricing.ts", old: "export function priceFor(x) {}", new: "export function quote(x) {}" },
      { path: "src/lib.rs", old: "pub fn total() {}", new: "pub fn total() -> u32 { 0 }" },
      { path: "app.py", old: null, new: "def handler():\n    pass" },
      { path: "same.ts", old: "export const a = 1", new: "export const a = 1" },
    ]);
    expect(out.map((s) => s.symbol)).toEqual(["priceFor", "quote", "total", "handler"]);
    expect(out[0]).toEqual({ symbol: "priceFor", path: "src/pricing.ts", removed: true });
  });

  it("catches a renamed method or helper that wasn't exported", () => {
    const out = changedIdentifiers([
      {
        path: "src/cart.ts",
        old: "class Cart {\n  computeTotal(items) {\n    return 1;\n  }\n}\nfunction roundUp(x) { return x; }",
        new: "class Cart {\n  total(items) {\n    return 1;\n  }\n}\nfunction roundUp(x) { return x; }",
      },
    ]);
    expect(out).toContainEqual({ symbol: "computeTotal", path: "src/cart.ts", removed: true });
    // Still there: not a rename.
    expect(out.find((s) => s.symbol === "roundUp")).toBeUndefined();
  });
});

describe("referenceFiles", () => {
  const lsp = (over: Partial<LspAccess> = {}): LspAccess => ({
    runningServersUnder: () => [{ id: "ts", serverRoot: "/repo" }],
    workspaceRequest: async () => [
      {
        id: "ts",
        result: [
          { name: "quote", location: { uri: "file:///repo/src/pricing.ts", range: { start: { line: 3, character: 16 } } } },
        ],
      },
    ],
    lspRequest: async () => [
      { uri: "file:///repo/src/cart.ts", range: { start: { line: 1, character: 0 } } },
      { uri: "file:///repo/src/pricing.ts", range: { start: { line: 9, character: 0 } } },
    ],
    ...over,
  });

  it("asks a running server for references of each symbol, excluding the declaring file", async () => {
    const request = vi.fn(lsp().lspRequest);
    const out = await referenceFiles("/repo", ["quote"], { lsp: lsp({ lspRequest: request }), search: async () => [] });
    expect(out).toEqual([{ symbol: "quote", files: ["/repo/src/cart.ts"] }]);
    expect(request).toHaveBeenCalledWith("/repo/src/pricing.ts", "/repo", "textDocument/references", {
      textDocument: { uri: "file:///repo/src/pricing.ts" },
      position: { line: 3, character: 16 },
      context: { includeDeclaration: false },
    });
  });

  it("falls back to a whole-word text search when no server can start, and never throws", async () => {
    const ws = vi.fn();
    const search: TextSearch = async () => [
      { path: "/repo/src/cart.ts", line: 3, text: "const t = quote(items);" },
      { path: "/repo/src/notes.md", line: 1, text: "quoted price" },
      { path: "/repo/src/pricing.ts", line: 1, text: "export function quote() {}" },
    ];
    const out = await referenceFiles(
      "/repo",
      [{ symbol: "quote", path: "src/pricing.ts", removed: false }],
      { lsp: lsp({ runningServersUnder: () => [], workspaceRequest: ws }), search, canStart: false },
    );
    expect(out).toEqual([{ symbol: "quote", files: ["/repo/src/cart.ts"] }]);
    expect(ws).not.toHaveBeenCalled();
    expect(
      await referenceFiles("/repo", ["quote"], { lsp: lsp({ workspaceRequest: () => Promise.reject(new Error("boom")) }), search: async () => [] }),
    ).toEqual([]);
  });

  it("starts a language server on demand, within the budget", async () => {
    let running = false;
    const ensure = vi.fn(async () => {
      running = true;
    });
    const out = await referenceFiles(
      "/repo",
      [{ symbol: "quote", path: "src/pricing.ts", removed: false }],
      {
        lsp: lsp({ runningServersUnder: () => (running ? [{ id: "ts", serverRoot: "/repo" }] : []), ensureLanguageServer: ensure }),
        search: async () => [],
      },
    );
    expect(ensure).toHaveBeenCalledWith("/repo/src/pricing.ts", "/repo");
    expect(out).toEqual([{ symbol: "quote", files: ["/repo/src/cart.ts"] }]);
  });

  it("gives up on a slow server start and searches instead", async () => {
    const out = await referenceFiles(
      "/repo",
      [{ symbol: "quote", path: "src/pricing.ts", removed: false }],
      {
        lsp: lsp({ runningServersUnder: () => [], ensureLanguageServer: () => new Promise(() => {}) }),
        search: async () => [{ path: "/repo/src/cart.ts", line: 1, text: "quote()" }],
        startBudgetMs: 10,
      },
    );
    expect(out).toEqual([{ symbol: "quote", files: ["/repo/src/cart.ts"] }]);
  });

  it("finds callers of a renamed-away name by text, without asking the server", async () => {
    const ws = vi.fn();
    const out = await referenceFiles(
      "/repo",
      [{ symbol: "priceFor", path: "src/pricing.ts", removed: true }],
      {
        lsp: lsp({ workspaceRequest: ws }),
        search: async () => [
          { path: "/repo/src/cart.ts", line: 9, text: "  return priceFor(item) * qty;" },
          { path: "/repo/src/cart.ts", line: 12, text: "priceFor(x)" },
          { path: "/repo/src/other.ts", line: 2, text: "priceForAll()" },
        ],
      },
    );
    expect(out).toEqual([{ symbol: "priceFor", files: ["/repo/src/cart.ts"] }]);
    expect(ws).not.toHaveBeenCalled();
  });
});
