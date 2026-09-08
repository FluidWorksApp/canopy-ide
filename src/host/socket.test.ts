import { describe, expect, it, vi } from "vitest";
import { SocketHost } from "./socket";
import { fakeWire } from "../test/fakeHostWire";
import { installHost } from "./index";
import { fsReadFile, onPtyExit, ptyRendererRegister } from "../ipc";

const hello = (environmentId = "host-a") => ({ t: "hello", host: {
  protocol: 1, environmentId, commands: ["fs_read_file"], events: ["pty:exit"], streams: ["pty"],
} });

describe("socket host", () => {
  it("runs the existing typed IDE functions over the socket", async () => {
    const f = fakeWire(), host = new SocketHost(f.wire);
    const restore = installHost(host);
    try {
      f.receive(hello());
      const read = fsReadFile("/workspace/a.ts");
      await Promise.resolve(); await Promise.resolve();
      const request = f.send.mock.calls.map(([m]) => m).find(m => m.t === "act")!;
      expect(request.action).toBe("fs_read_file");
      expect(request.args).toEqual({ path: "/workspace/a.ts" });
      f.receive({ t: "act-ack", id: request.id, ok: true, result: [104, 101, 108, 108, 111] });
      await expect(read).resolves.toEqual(new Uint8Array([104, 101, 108, 108, 111]));
      const exited = vi.fn();
      const off = await onPtyExit(exited);
      f.receive({ t: "event", name: "pty:exit", payload: { id: 4, exit_code: 0 } });
      expect(exited).toHaveBeenCalledWith({ id: 4, exit_code: 0 });
      off();
      f.receive({ t: "event", name: "pty:exit", payload: { id: 5 } });
      expect(exited).toHaveBeenCalledTimes(1);
    } finally { restore(); host.dispose(); }
  });

  it("never routes desktop takeover or an ungranted operation through native IPC", async () => {
    const f = fakeWire(), host = new SocketHost(f.wire);
    const restore = installHost(host);
    try {
      f.receive(hello());
      await expect(ptyRendererRegister()).rejects.toThrow("does not expose pty_renderer_register");
      await expect(host.invoke("vault_read")).rejects.toThrow("does not expose");
      expect(f.send.mock.calls.some(([m]) => m.t === "act")).toBe(false);
      expect(() => host.channel()).toThrow("does not support native channel");
    } finally { restore(); host.dispose(); }
  });

  it("requires a new handshake after reconnect and refuses a different host", async () => {
    const f = fakeWire(), host = new SocketHost(f.wire);
    f.receive(hello()); await host.ready();
    f.status(false);
    await expect(host.ready()).rejects.toThrow("unavailable");
    f.status(true);
    const ready = host.ready();
    f.receive(hello("host-b"));
    await expect(ready).rejects.toThrow("host changed");
    await expect(host.invoke("fs_read_file")).rejects.toThrow("host changed");
    host.dispose();
  });

  it("fails explicitly when connected to an older host without a handshake", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeWire(), host = new SocketHost(f.wire);
      const ready = expect(host.ready()).rejects.toThrow("handshake");
      await vi.advanceTimersByTimeAsync(10_000);
      await ready;
      host.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
