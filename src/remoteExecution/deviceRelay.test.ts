import { describe, expect, it, vi } from "vitest";
import { ANSWER_CHUNK, answerDeviceOp, runDeviceOp, startDeviceRelay, type DeviceRelayIo } from "./deviceRelay";

describe("device relay", () => {
  it("runs an op with the desktop's device route, dropping a VM project directory", async () => {
    const desktop = vi.fn(async () => ({ tapped: [1, 2] })) as unknown as DeviceRelayIo["desktop"];
    const native = vi.fn() as unknown as DeviceRelayIo["native"];
    const answer = await runDeviceOp({ native, desktop }, { op: "tap", x: 1, y: 2, projectDir: "/workspace/app" });
    expect(answer).toEqual({ status: 200, body: JSON.stringify({ tapped: [1, 2] }) });
    expect(desktop).toHaveBeenCalledWith("context_device_op", { op: { op: "tap", x: 1, y: 2 } });
  });

  it("stages a workspace APK here before running it, and reports a desktop error as one", async () => {
    const calls: string[] = [];
    const native = vi.fn(async (command: string, args: Record<string, unknown>) => {
      calls.push(command);
      if (command === "fs_stat") return { size: 3, is_dir: false };
      if (command === "fs_read_range") return { b64: args.offset === 0 ? btoa("APK") : "", size: 3 };
      return null;
    }) as unknown as DeviceRelayIo["native"];
    const desktop = vi.fn(async (command: string, args: Record<string, unknown>) => {
      if (command === "android_stage_file") return "/tmp/canopy-apk/app.apk";
      if (command === "context_device_op") {
        expect((args.op as Record<string, unknown>).apk).toBe("/tmp/canopy-apk/app.apk");
        throw Error("Error: no device attached");
      }
      return null;
    }) as unknown as DeviceRelayIo["desktop"];
    const answer = await runDeviceOp({ native, desktop }, { op: "run", apk: "/workspace/app/build/app.apk", projectDir: "/workspace/app" });
    expect(answer).toEqual({ status: 400, body: "no device attached" });
  });

  it("answers in pieces under one harness action, with byte offsets", async () => {
    const sent: Record<string, unknown>[] = [];
    const action = vi.fn(async (_kind: string, args: Record<string, unknown>) => {
      sent.push(args);
      return {};
    }) as unknown as DeviceRelayIo["action"];
    const body = `é${"x".repeat(ANSWER_CHUNK + 10)}`;
    await answerDeviceOp({ action }, "dev-1", { status: 200, body });
    expect(sent.map((s) => [s.offset, s.done])).toEqual([[0, false], [ANSWER_CHUNK + 1, true]]);
    expect(sent.map((s) => s.chunk).join("")).toBe(body);
  });

  it("polls, serves each op and stops", async () => {
    let polls = 0;
    const io: DeviceRelayIo = {
      query: vi.fn(async () => (++polls === 1 ? { items: [{ id: "dev-1", op: { op: "list" }, ptyId: 3 }] } : new Promise(() => {}))) as never,
      action: vi.fn(async () => ({})) as never,
      native: vi.fn() as never,
      desktop: vi.fn(async () => ({ devices: [] })) as never,
    };
    const stop = startDeviceRelay(io, async () => {});
    await vi.waitFor(() => expect(io.action).toHaveBeenCalledWith("device_answer", { id: "dev-1", status: 200, chunk: '{"devices":[]}', offset: 0, done: true }));
    expect(io.query).toHaveBeenCalledWith("device", "pending", { wait: 5000 });
    stop();
  });
});
