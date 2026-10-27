import { describe, expect, it, vi } from "vitest";
import { workspaceReceiptCheck } from "./receiptCheck";

const sleep = async () => {};

describe("workspaceReceiptCheck", () => {
  it("starts a host job and polls until it finishes", async () => {
    const answers = [{ state: "running" }, { state: "running" }, { state: "done", result: { code: 0 } }];
    const native = vi.fn(async (command: string) => (command === "receipt_check_start" ? { id: "j1" } : answers.shift())) as never;
    await expect(workspaceReceiptCheck(native, { cwd: "/workspace", argv: ["npm", "test"] }, () => false, sleep)).resolves.toEqual({ code: 0 });
    expect((native as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([c]) => c === "receipt_check_status")).toHaveLength(3);
  });

  it("falls back to one long request on an older host", async () => {
    const native = vi.fn(async (command: string) => {
      if (command === "receipt_check_start") throw Error("The workspace host does not support receipt_check_start yet");
      return { code: 1 };
    }) as never;
    await expect(workspaceReceiptCheck(native, {}, () => false, sleep)).resolves.toEqual({ code: 1 });
  });

  it("rides out a reconnect, but reports a failed check and a lost job", async () => {
    let calls = 0;
    const flaky = vi.fn(async (command: string) => {
      if (command === "receipt_check_start") return { id: "j" };
      calls++;
      if (calls < 3) throw Error("network");
      return { state: "failed", error: "Invalid check command" };
    }) as never;
    await expect(workspaceReceiptCheck(flaky, {}, () => false, sleep)).rejects.toThrow("Invalid check command");
    const lost = vi.fn(async (command: string) => {
      if (command === "receipt_check_start") return { id: "j" };
      throw Error("No such check (it finished long ago, or the workspace restarted)");
    }) as never;
    await expect(workspaceReceiptCheck(lost, {}, () => false, sleep)).rejects.toThrow("No such check");
  });
});
