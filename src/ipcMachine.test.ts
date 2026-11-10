// Terminals on another machine, through the same ipc.pty* functions the rest of
// the app uses (environments/ptyRoute.ts): an alias id goes to that machine's
// host with the machine's own id; every other id keeps going to the primary host.
import { beforeEach, expect, it, vi } from "vitest";
import { mockCommands } from "./test/setup";
import { resetPtyRoutes, routeOf } from "./environments/ptyRoute";
import {
  onAgentEvents,
  onPtyExit,
  ptyAck,
  ptyKill,
  ptyOutput,
  ptyRendererRegister,
  ptySpawnOnMachine,
  ptyWrite,
  renameAgentEventLines,
  type PtyExit,
} from "./ipc";
import type { Host, HostEvent } from "./host/contract";

type Call = { command: string; args: Record<string, unknown> };

function fakeMachine(nextId = 3) {
  const calls: Call[] = [];
  const listeners = new Map<string, Set<(e: HostEvent<unknown>) => void>>();
  const host: Host = {
    kind: "socket",
    invoke: (async (command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      if (command === "pty_spawn" || command === "pty_spawn_attached_argv")
        return { id: nextId, generation: 11, cols: 80, rows: 24 };
      if (command === "pty_output") return "tail";
      return undefined;
    }) as Host["invoke"],
    listen: (async (event: string, handler: (e: HostEvent<unknown>) => void) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(handler);
      return () => set.delete(handler);
    }) as Host["listen"],
    channel: () => ({ onmessage: () => {} }),
  };
  const emit = (event: string, payload: unknown) =>
    listeners.get(event)?.forEach((h) => h({ event, id: 0, payload }));
  return { host, calls, emit };
}

const machine = (host: Host, id = "remote:ws1") => ({ id, host, readOnly: false });

beforeEach(() => {
  resetPtyRoutes();
});

it("spawns on the machine and answers an alias id, never the machine's own", async () => {
  const { host, calls } = fakeMachine(3);
  mockCommands({ pty_renderer_register: () => ({ generation: 7, sessions: [] }) });
  await ptyRendererRegister();
  const result = await ptySpawnOnMachine(machine(host), { cols: 80, rows: 24, cwd: "/workspace/app" }, () => {});
  expect(result.id).toBeGreaterThanOrEqual(2 ** 40);
  expect(routeOf(result.id)).toMatchObject({ env: "remote:ws1", id: 3 });
  // The window's renderer generation is reused: no registration on the machine.
  const spawn = calls.find((c) => c.command === "pty_spawn");
  expect(spawn?.args).toMatchObject({ cwd: "/workspace/app", rendererGeneration: 7 });
  expect(calls.some((c) => c.command === "pty_renderer_register")).toBe(false);
});

it("uses the argv spawn when an argv is given", async () => {
  const { host, calls } = fakeMachine();
  mockCommands({ pty_renderer_register: () => ({ generation: 7, sessions: [] }) });
  await ptyRendererRegister();
  await ptySpawnOnMachine(machine(host), { cols: 80, rows: 24, argv: ["claude"] }, () => {});
  expect(calls.some((c) => c.command === "pty_spawn_attached_argv")).toBe(true);
});

it("refuses to start a terminal on a view-only machine", async () => {
  const { host, calls } = fakeMachine();
  await expect(ptySpawnOnMachine({ ...machine(host), readOnly: true }, { cols: 80, rows: 24 }, () => {})).rejects.toThrow(/view-only/);
  expect(calls).toEqual([]);
});

it("routes write, ack, kill and output to the machine with its own id, and others to the primary", async () => {
  const { host, calls } = fakeMachine(3);
  const primary: Call[] = [];
  mockCommands({
    pty_renderer_register: () => ({ generation: 7, sessions: [] }),
    pty_write: (args: Record<string, unknown>) => void primary.push({ command: "pty_write", args }),
    pty_kill: (args: Record<string, unknown>) => void primary.push({ command: "pty_kill", args }),
  });
  await ptyRendererRegister();
  const { id } = await ptySpawnOnMachine(machine(host), { cols: 80, rows: 24 }, () => {});

  await ptyWrite(id, "ls\r");
  await ptyAck(id, 11, 100);
  await ptyKill(id);
  expect(await ptyOutput(id, 50)).toBe("tail");
  expect(calls.filter((c) => c.command !== "pty_spawn").map((c) => [c.command, c.args.id])).toEqual([
    ["pty_write", 3],
    ["pty_ack", 3],
    ["pty_kill", 3],
    ["pty_output", 3],
  ]);
  expect(calls.find((c) => c.command === "pty_ack")?.args).toMatchObject({ generation: 11, bytes: 100, rendererGeneration: 7 });
  // Nothing about it reached the primary host.
  expect(primary).toEqual([]);

  // Terminal 3 of the primary host is a different process: it stays on the primary.
  await ptyWrite(3, "pwd\r");
  expect(primary).toEqual([{ command: "pty_write", args: { id: 3, data: "pwd\r" } }]);
});

it("delivers a machine terminal's exit under its alias, and ignores other terminals there", async () => {
  const { host, emit } = fakeMachine(3);
  mockCommands({
    pty_renderer_register: () => ({ generation: 7, sessions: [] }),
    pty_renderer_events: () => ({ exit_cursor: 0, exits: [], spawn_cursor: 0, spawns: [] }),
  });
  await ptyRendererRegister();
  const seen: PtyExit[] = [];
  const stop = await onPtyExit((e) => seen.push(e));
  const { id } = await ptySpawnOnMachine(machine(host), { cols: 80, rows: 24 }, () => {});
  emit("pty:exit", { id: 99, session_generation: 1, exit_code: 0, requested: false });
  emit("pty:exit", { id: 3, session_generation: 1, exit_code: 2, requested: false });
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]).toMatchObject({ id, exit_code: 2 });
  stop();
});

it("renames an agent event's terminal to the alias and drops other terminals' events", async () => {
  const { host, emit } = fakeMachine(3);
  mockCommands({
    pty_renderer_register: () => ({ generation: 7, sessions: [] }),
    "plugin:event|listen": () => 1,
    "plugin:event|unlisten": () => undefined,
  });
  await ptyRendererRegister();
  const { id } = await ptySpawnOnMachine(machine(host), { cols: 80, rows: 24 }, () => {});
  const got: string[][] = [];
  const stop = await onAgentEvents((lines) => got.push(lines));
  emit("agent:events", [
    JSON.stringify({ hook_event_name: "Stop", canopy_pty: 3, session_id: "s" }),
    JSON.stringify({ hook_event_name: "Stop", canopy_pty: 8, session_id: "other" }),
    JSON.stringify({ hook_event_name: "Stop", session_id: "no-stamp" }),
    "not json",
  ]);
  await vi.waitFor(() => expect(got).toHaveLength(1));
  expect(got[0]).toHaveLength(1);
  expect(JSON.parse(got[0][0])).toMatchObject({ canopy_pty: id, session_id: "s" });
  stop();
});

it("renameAgentEventLines needs a terminal started from here", () => {
  expect(renameAgentEventLines("remote:none", [JSON.stringify({ canopy_pty: 1 })])).toEqual([]);
});

it("a machine that reconnects under the same id is listened to afresh", async () => {
  const first = fakeMachine(3);
  const second = fakeMachine(4);
  mockCommands({
    pty_renderer_register: () => ({ generation: 7, sessions: [] }),
    pty_renderer_events: () => ({ exit_cursor: 0, exits: [], spawn_cursor: 0, spawns: [] }),
  });
  await ptyRendererRegister();
  const seen: PtyExit[] = [];
  const stop = await onPtyExit((e) => seen.push(e));
  await ptySpawnOnMachine(machine(first.host), { cols: 80, rows: 24 }, () => {});
  const { id } = await ptySpawnOnMachine(machine(second.host), { cols: 80, rows: 24 }, () => {});
  second.emit("pty:exit", { id: 4, session_generation: 1, exit_code: 0, requested: false });
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0].id).toBe(id);
  stop();
});
