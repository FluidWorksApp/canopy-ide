import { describe, expect, it, vi } from "vitest";
import { changedIdentifiers, referenceFiles, type LspAccess } from "./symbols";

describe("changedIdentifiers", () => {
  it("lists renamed-away exports first, then the rest, across languages", () => {
    const out = changedIdentifiers([
      { path: "src/pricing.ts", old: "export function priceFor(x) {}", new: "export function quote(x) {}" },
      { path: "src/lib.rs", old: "pub fn total() {}", new: "pub fn total() -> u32 { 0 }" },
      { path: "app.py", old: null, new: "def handler():\n    pass" },
      { path: "same.ts", old: "export const a = 1", new: "export const a = 1" },
    ]);
    expect(out.map((s) => s.symbol)).toEqual(["priceFor", "quote", "total", "handler"]);
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
    const out = await referenceFiles("/repo", ["quote"], lsp({ lspRequest: request }));
    expect(out).toEqual([{ symbol: "quote", files: ["/repo/src/cart.ts"] }]);
    expect(request).toHaveBeenCalledWith("/repo/src/pricing.ts", "/repo", "textDocument/references", {
      textDocument: { uri: "file:///repo/src/pricing.ts" },
      position: { line: 3, character: 16 },
      context: { includeDeclaration: false },
    });
  });

  it("skips silently when no server is running or the server errors", async () => {
    const ws = vi.fn();
    expect(await referenceFiles("/repo", ["quote"], lsp({ runningServersUnder: () => [], workspaceRequest: ws }))).toEqual([]);
    expect(ws).not.toHaveBeenCalled();
    expect(
      await referenceFiles("/repo", ["quote"], lsp({ workspaceRequest: () => Promise.reject(new Error("boom")) })),
    ).toEqual([]);
  });
});
