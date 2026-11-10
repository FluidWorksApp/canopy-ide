import { describe, expect, it, vi } from "vitest";
import type { Host, HostChannel, HostEvent } from "../host/contract";
import { parsePtyKey, ptyIpcFor, ptyKey, scopedPtyId } from "./ptyFor";
import { EnvironmentRegistry } from "./registry";

function fakeHost(readOnly = false) {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const channels: HostChannel<never>[] = [];
  const listeners = new Map<string, (e: HostEvent<unknown>) => void>();
  const host: Host = {
    kind: "socket",
    readOnly,
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "pty_spawn" || command === "pty_spawn_argv") return { id: 3, cols: 80, rows: 24, session_generation: 1, pid: 9, generation: 1, sessions: [] } as never;
      if (command === "pty_renderer_sessions") return [{ id: 3 }] as never;
      if (command === "pty_resize") return { cols: 100, rows: 30 } as never;
      if (command === "pty_kill") throw new Error("no pty session 3");
      return undefined as never;
    },
    async listen(event, handler) {
      listeners.set(event, handler as never);
      return () => listeners.delete(event);
    },
    channel<T>() {
      const c = { onmessage: () => {} } as HostChannel<T>;
      channels.push(c as HostChannel<never>);
      return c;
    },
  };
  return { host, calls, channels, listeners };
}

const env = (id: string, host: Host, readOnly = false) => ({ id, host, readOnly });

describe("scoped terminal ids", () => {
  it("round-trips through a key and tells the same number on two machines apart", () => {
    const a = scopedPtyId("local", 3);
    const b = scopedPtyId("remote:ws", 3);
    expect(ptyKey(a)).not.toBe(ptyKey(b));
    expect(parsePtyKey(ptyKey(b))).toEqual({ env: "remote:ws", id: 3 });
    expect(parsePtyKey("remote:ws|x")).toBeNull();
    expect(parsePtyKey("3")).toBeNull();
  });
});

describe("ptyIpcFor", () => {
  it("spawns through that environment's host and scopes the id it gets back", async () => {
    const f = fakeHost();
    const pty = ptyIpcFor(env("remote:ws", f.host), { rendererGeneration: () => 7 });
    const onData = vi.fn();
    const spawned = await pty.spawn({ cols: 80, rows: 24, cwd: "/work" }, onData);
    expect(spawned.id).toEqual({ env: "remote:ws", id: 3 });
    expect(f.calls[0]).toMatchObject({ command: "pty_spawn", args: { cwd: "/work", rendererGeneration: 7 } });
    // The data channel handed to the host delivers decoded chunks to the caller.
    f.channels[0]!.onmessage([1, 2, 3] as never);
    expect(onData).toHaveBeenCalledWith(expect.objectContaining({ gap: true }));
  });

  it("writes, resizes and kills with the host's own numeric id", async () => {
    const f = fakeHost();
    const pty = ptyIpcFor(env("remote:ws", f.host));
    const id = scopedPtyId("remote:ws", 3);
    await pty.write(id, "ls\n");
    await expect(pty.resize(id, 100, 30)).resolves.toEqual({ cols: 100, rows: 30 });
    await expect(pty.kill(id)).resolves.toBeUndefined(); // racing the exit is not an error
    expect(f.calls.map((c) => [c.command, c.args?.id])).toEqual([["pty_write", 3], ["pty_resize", 3], ["pty_kill", 3]]);
  });

  it("refuses a terminal that belongs to another machine instead of writing there", async () => {
    const f = fakeHost();
    const pty = ptyIpcFor(env("remote:ws", f.host));
    await expect(pty.write(scopedPtyId("local", 3), "rm -rf x")).rejects.toThrow(/belongs to local/);
    expect(f.calls).toHaveLength(0);
  });

  it("does not let a view-only connection spawn, write or kill", async () => {
    const f = fakeHost(true);
    const pty = ptyIpcFor(env("remote:ws", f.host, true));
    await expect(pty.spawn({ cols: 1, rows: 1 }, () => {})).rejects.toThrow(/view-only/);
    await expect(pty.write(scopedPtyId("remote:ws", 1), "x")).rejects.toThrow(/view-only/);
    await expect(pty.kill(scopedPtyId("remote:ws", 1))).rejects.toThrow(/view-only/);
    expect(f.calls).toHaveLength(0);
  });

  it("reports exits with scoped ids, only from its own host", async () => {
    const a = fakeHost();
    const b = fakeHost();
    const seen: unknown[] = [];
    const unlisten = await ptyIpcFor(env("remote:a", a.host)).onExit((e) => seen.push(e.id));
    await ptyIpcFor(env("remote:b", b.host)).onExit(() => seen.push("wrong host"));
    a.listeners.get("pty:exit")!({ event: "pty:exit", id: 1, payload: { id: 3, session_generation: 1, exit_code: 0, requested: false } });
    expect(seen).toEqual([{ env: "remote:a", id: 3 }]);
    unlisten();
    expect(a.listeners.has("pty:exit")).toBe(false);
  });

  it("works from an environment taken out of the registry", async () => {
    const f = fakeHost();
    const registry = new EnvironmentRegistry();
    registry.register({ id: "remote:ws", name: "WS", host: f.host, status: "connected", readOnly: false });
    const pty = ptyIpcFor(registry.get("remote:ws")!);
    await pty.write(scopedPtyId("remote:ws", 3), "x");
    expect(f.calls).toHaveLength(1);
  });
});

describe("the rest of the terminal commands", () => {
  it("spawns from an argv, acks, attaches and titles through the host with scoped ids", async () => {
    const f = fakeHost();
    const pty = ptyIpcFor(env("remote:ws", f.host), { rendererGeneration: () => 2 });
    pty.adoptRendererGeneration(9);
    const spawned = await pty.spawnArgv({ argv: ["ls"], cwd: "/work" }, () => {});
    expect(spawned.id).toEqual({ env: "remote:ws", id: 3 });
    expect(f.calls[0]).toMatchObject({ command: "pty_spawn_argv", args: { argv: ["ls"], rendererGeneration: 9 } });
    await pty.ack(spawned.id, 4, 100);
    await pty.attach(spawned.id, null);
    await pty.setTitle(spawned.id, "t");
    expect(f.calls.slice(1).map((c) => c.command)).toEqual(["pty_ack", "pty_attach_desktop", "pty_set_title"]);
    expect(f.calls[1]!.args).toMatchObject({ id: 3, rendererGeneration: 9, generation: 4, bytes: 100 });
    await expect(pty.ack(scopedPtyId("local", 3), 1, 1)).rejects.toThrow(/belongs to local/);
  });

  it("scopes the spawn event and the session list to its own host, and never registers a renderer", async () => {
    const f = fakeHost();
    const pty = ptyIpcFor(env("remote:ws", f.host));
    const seen: unknown[] = [];
    await pty.onSpawned((e) => seen.push(e.id));
    f.listeners.get("pty:spawned")!({ payload: { id: 5 } } as never);
    expect(seen).toEqual([{ env: "remote:ws", id: 5 }]);
    await pty.sessions();
    expect(f.calls.map((c) => c.command)).not.toContain("pty_renderer_register");
  });
});
