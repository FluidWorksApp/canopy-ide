import { describe, expect, it, vi } from "vitest";
import { AcpRpc, AcpRpcError } from "./rpc";

function make(onRequest: (m: string, p: unknown) => Promise<unknown> = async () => null) {
  const written: Record<string, unknown>[] = [];
  const notes: [string, unknown][] = [];
  const rpc = new AcpRpc({
    write: async (line) => {
      written.push(JSON.parse(line));
    },
    onRequest,
    onNotification: (m, p) => notes.push([m, p]),
    timeoutMs: 50,
  });
  return { rpc, written, notes };
}

describe("AcpRpc", () => {
  it("correlates responses to requests by id", async () => {
    const { rpc, written } = make();
    const a = rpc.request("a");
    const b = rpc.request("b");
    expect(written.map((w) => w.id)).toEqual([1, 2]);
    rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "B" }));
    rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "A" }));
    await expect(a).resolves.toBe("A");
    await expect(b).resolves.toBe("B");
  });

  it("holds a partial line until its newline and ignores non-JSON", async () => {
    const { rpc } = make();
    const p = rpc.request("a");
    const full = JSON.stringify({ jsonrpc: "2.0", id: 1, result: 7 });
    rpc.handleChunk("banner text\n" + full.slice(0, 10));
    rpc.handleChunk(full.slice(10) + "\n");
    await expect(p).resolves.toBe(7);
  });

  it("rejects with the agent's error", async () => {
    const { rpc } = make();
    const p = rpc.request("a");
    rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "auth" } }));
    await expect(p).rejects.toMatchObject({ code: -32000, message: "auth" });
  });

  it("answers agent requests and reports errors", async () => {
    const { rpc, written } = make(async (m) => {
      if (m === "ok") return { fine: true };
      throw new AcpRpcError(-32601, "nope");
    });
    rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "x", method: "ok" }));
    rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "bad" }));
    await vi.waitFor(() => expect(written).toHaveLength(2));
    expect(written).toContainEqual({ jsonrpc: "2.0", id: "x", result: { fine: true } });
    expect(written).toContainEqual({ jsonrpc: "2.0", id: 9, error: { code: -32601, message: "nope" } });
  });

  it("routes notifications", () => {
    const { rpc, notes } = make();
    rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { a: 1 } }));
    expect(notes).toEqual([["session/update", { a: 1 }]]);
  });

  it("rejects every pending request on close, and later ones", async () => {
    const { rpc } = make();
    const a = rpc.request("a", undefined, null);
    const b = rpc.request("b", undefined, null);
    rpc.close("gone");
    await expect(a).rejects.toThrow("gone");
    await expect(b).rejects.toThrow("gone");
    await expect(rpc.request("c")).rejects.toThrow("gone");
    expect(rpc.pendingCount).toBe(0);
  });

  it("times out a request", async () => {
    const { rpc } = make();
    await expect(rpc.request("slow")).rejects.toThrow(/timed out/);
  });
});
